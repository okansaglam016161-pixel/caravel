// Reading back the UTXOs a committed transaction created, from its result.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Caravel's own builders compute their outputs client-side, so their commitments are readable
// before submission (see outputIds.ts). One transaction is not ours to build: an @name
// registration is assembled inside the vendored ONS client, which returns `{ transactionId, fee }`
// and keeps the outputs statement to itself. Modifying vendored code to surface a commitment would
// be a patch to carry across every re-vendor.
//
// So the commitment is read AFTERWARDS instead, out of the transaction result — which already
// carries it. `up_substates` is the list of substates a transaction created, and a created stealth
// UTXO appears there as `utxo_<resource>_<commitment>`, the same id the scanner builds. The
// structure is the one accountAddress.ts has parsed since M1 to recover the account component;
// this reads a different entry from the same list.
//
// ── WHY OVER-REPORTING IS SAFE HERE ──────────────────────────────────────────
//
// This returns EVERY utxo the transaction created, without checking which are ours. For an @name
// registration that is exactly one output, back to the sender (vendor/ons browser-writer: one
// `createOutput({ destination: senderAddress })`), so the set is ours by construction.
//
// It is worth being explicit about the direction of the risk if that ever stopped holding. These
// ids are used to SUBTRACT from the owned set during reconciliation, so recording an id that was
// not ours removes something from consideration that was never in the owned set anyway — a no-op —
// or, in the worst case, hides a genuine receive. Missing an id is the dangerous direction: an
// unrecorded output of ours reads later as money from a stranger. Over-reporting fails silent;
// under-reporting lies.

import { upSubstates } from './accountAddress'
import { INDEXER_URL } from './indexerConfig'


/** Matches the id format walletScanner builds, so the two sets compare directly. */
const UTXO_PREFIX = 'utxo_'

/**
 * The substate ids of every UTXO this transaction created.
 *
 * `[]` and `null` are as different here as everywhere else in this phase:
 *   []    the result was read and the transaction created no UTXOs.
 *   null  the result could NOT be read — a network failure, an unfinalized transaction, an
 *         unrecognised shape. A hole, and the caller must record it as one rather than as "none".
 */
export async function fetchCreatedUtxoIds(
  txId: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  let resp: Response
  try {
    resp = await fetch(`${INDEXER_URL}/transactions/${encodeURIComponent(txId)}/result`, { signal })
  } catch { return null }
  if (!resp.ok) return null

  let json: unknown
  try { json = await resp.json() } catch { return null }

  const entries = upSubstates(json)
  // An accepted transaction always brings substates up — the fee receipt alone guarantees it. An
  // empty list therefore means the result was not an Accept we recognised, which is a hole rather
  // than a transaction that genuinely created nothing.
  if (entries.length === 0) return null

  const ids: string[] = []
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 1) continue
    const [substateId] = entry as [unknown]
    if (typeof substateId !== 'string') continue
    if (substateId.startsWith(UTXO_PREFIX)) ids.push(substateId)
  }
  return ids
}
