// Persistent results of claiming received chat payments through Sapient, per identity, sealed under
// the chat storage key. Final answers only — `verified`, `unverified` and `unconfirmed` — so a reload
// does not claim the same output again. Anything transient (claiming, waiting for Sapient) lives in
// memory (messaging/paymentClaims).
//
// These are CONFIDENTIAL RECEIVE AMOUNTS in the clear, which is why they are sealed like the message
// store. Keyed `utxoId → outcome`; amounts are decimal strings (raw units) so they JSON-serialise.

import { asRecord, loadStore, writeStore, type Parse } from '../crypto/storeIo'

export type StoredClaim =
  | { s: 'verified'; amount: string }
  /** A memo that is THERE and is not this message's, or one of our own sends. Nobody is credited. */
  | { s: 'unverified'; amount: string | null; reason: 'memo' | 'own-send' }
  /** Could not be confirmed either way — not found after the retries, or no memo to read. Retryable. */
  | { s: 'unconfirmed' }

export type ClaimMap = Record<string, StoredClaim>

// v2: v1 could hold a genuine payment wrongly stored as "not verified" — its memo read through
// tari_getShieldedOutputs as raw JSON (see sapient/payments.readMemo). A new key re-checks them all.
function key(myPubkeyHex: string) { return `caravel.payclaims.v2.${myPubkeyHex}` }

function valid(v: unknown): v is StoredClaim {
  const o = v as Partial<{ s: string; amount: unknown; reason: unknown }> | null
  if (!o || typeof o !== 'object') return false
  if (o.s === 'verified') return typeof o.amount === 'string'
  if (o.s === 'unverified') return (o.amount === null || typeof o.amount === 'string') && (o.reason === 'memo' || o.reason === 'own-send')
  return o.s === 'unconfirmed'
}

const parse: Parse<ClaimMap> = decoded => {
  const record = asRecord(decoded)
  if (record === null) return null
  const out: ClaimMap = {}
  for (const id in record) if (valid(record[id])) out[id] = record[id] as StoredClaim
  return out
}

export function loadClaims(myPubkeyHex: string): ClaimMap {
  return loadStore(key(myPubkeyHex), parse, () => ({}))
}

export function saveClaim(myPubkeyHex: string, utxoId: string, claim: StoredClaim): void {
  const map = loadClaims(myPubkeyHex)
  map[utxoId] = claim
  writeStore(key(myPubkeyHex), JSON.stringify(map), parse)
}

/** Forget outcomes — a conversation delete, or a Retry on an unconfirmed payment. */
export function removeClaims(myPubkeyHex: string, utxoIds: string[]): void {
  if (utxoIds.length === 0) return
  const map = loadClaims(myPubkeyHex)
  let changed = false
  for (const id of utxoIds) if (id in map) { delete map[id]; changed = true }
  if (changed) writeStore(key(myPubkeyHex), JSON.stringify(map), parse)
}
