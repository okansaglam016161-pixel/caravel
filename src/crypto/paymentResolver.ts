import { decryptOwnedUtxo, parseSubstateUtxo, WasmStealthCrypto, Network } from '@tari-project/ootle'
import type { IndexerGetSubstateResponse } from '@tari-project/ootle'
import { pointRead } from './indexerConfig'

// Resolve the TRUE amount of a payment-linked UTXO (M10.2). The amount deliberately never travels
// on the wire (M10.0) — it lives encrypted in the UTXO, its single source of truth — so the
// recipient fetches exactly that one UTXO by id and decrypts it with their own view key. This is
// O(1): one substate fetch, versus the wallet's O(n) blind scan.
//
// (Future optimisation, out of scope here: the blind scanner in walletScanner.ts could be narrowed
// using message-referenced ids like this one. Left untouched deliberately — it works.)

// One shared WASM instance — stateless per call, same pattern as walletScanner.
const stealthCrypto = new WasmStealthCrypto(Network.Esmeralda)

export type PaymentResolution =
  | { status: 'resolved'; amountMicrotari: string }  // decimal µTari STRING (JSON-safe; no bigint)
  | { status: 'not_found' }        // 404 — spent OR not yet indexed; the indexer can't tell us which
  | { status: 'spent' }            // 200 but output === null / frozen (parseSubstateUtxo rejects it)
  | { status: 'unreadable' }       // 200, live UTXO, but decrypt failed → not addressed to this wallet
  | { status: 'network_error'; detail: string }

export async function resolvePayment(
  utxoId: string,
  viewSecret: Uint8Array,
  signal?: AbortSignal,
): Promise<PaymentResolution> {
  // ACROSS EVERY INDEXER. The nodes disagree about which substates they hold, so one node's 404 is
  // not an absence — and here it would show a real payment as "not found" to the person who
  // received it. See indexerConfig.pointRead.
  if (signal?.aborted) return { status: 'network_error', detail: 'aborted' }
  const read = await pointRead(`/substates/${encodeURIComponent(utxoId)}`)
  if (!read.answered) return { status: 'network_error', detail: 'no indexer answered' }

  // 404 from EVERY node: the common "spent or not-yet-indexed" case — deliberately NOT treated as
  // terminal by callers, so indexer lag right after receipt recovers via retry.
  if (read.body === null) return { status: 'not_found' }
  const substate = read.body as IndexerGetSubstateResponse

  // Structural check first: separates a spent/frozen output (output === null) from a live UTXO,
  // so we can distinguish "gone" from "not ours" rather than lumping both into a null decrypt.
  let parsed: unknown
  try { parsed = parseSubstateUtxo(substate, utxoId) } catch { parsed = null }
  if (parsed === null) {
    // 200 + null output = the UTXO existed but is spent or frozen, as opposed to a 404 (never ours).
    return { status: 'spent' }
  }

  let decrypted: Awaited<ReturnType<typeof decryptOwnedUtxo>>
  try {
    decrypted = await decryptOwnedUtxo(stealthCrypto, viewSecret, substate, utxoId)
  } catch {
    decrypted = null   // decryptOwnedUtxo normally returns null for "not ours"; guard a throw too
  }
  if (decrypted === null) return { status: 'unreadable' }

  return { status: 'resolved', amountMicrotari: decrypted.value.toString() }
}
