// Persistent cache of RESOLVED payment amounts (M10.2), sibling to messageStore.ts.
//
// A resolved amount for a given UTXO id never changes, so we cache it to avoid re-fetching on
// every render/unlock. Successes only — failures stay in memory and are retryable. This is
// LOCAL, DERIVED data: it is NOT stored on CaravelMessage.payment (that is the wire PaymentRef),
// same separation of concerns as M10.1's localPayment.
//
// Conventions match nicknameStore/tariAddressStore: per-identity key (keyed under MY pubkey),
// quota errors swallowed. Amount is a decimal µTari STRING so it JSON-serialises without bigint.
//
// ── ENCRYPTED AT REST (stage 4) ──────────────────────────────────────────────
//
// These are RESOLVED CONFIDENTIAL RECEIVE AMOUNTS. The chain hides them and the wire cannot carry
// them; this cache is where they end up in the clear, which puts it in the same tier as the journal.
//
// It MIGRATES ON READ (storeIo): it writes only when a NEW payment resolves, so a wallet receiving
// nothing would otherwise keep this in plaintext indefinitely. That read has to be FORCED at
// startup here — see migrateResolvedAmounts at the foot of the file.
//
// BOTH MUTATIONS NOW GO THROUGH ONE save(). They used to call localStorage.setItem directly, which
// meant the never-clobber guard had two places to be forgotten. Note the read-modify-write shape:
// neither takes a `current`, so under a wrong key the load returns {} and the write would have
// replaced the whole cache with one entry — exactly what the guard refuses.

// utxoId → amountMicrotari (decimal string), for the current identity.
import { asRecord, loadStore, writeStore, type Parse } from '../crypto/storeIo'

export type ResolvedAmountMap = Record<string, string>

function key(myPubkeyHex: string) { return `caravel.payresolved.v1.${myPubkeyHex}` }

const parse: Parse<ResolvedAmountMap> = decoded => asRecord(decoded) as ResolvedAmountMap | null

function save(myPubkeyHex: string, map: ResolvedAmountMap): void {
  writeStore(key(myPubkeyHex), JSON.stringify(map), parse)
}

export function loadResolvedAmounts(myPubkeyHex: string): ResolvedAmountMap {
  return loadStore(key(myPubkeyHex), parse, () => ({}))
}

// Cache one resolved amount (read-modify-write). No `current` param — each card resolves its own
// id independently, so there is no single React mirror of the whole map to thread through.
export function cacheResolvedAmount(myPubkeyHex: string, utxoId: string, amountMicrotari: string): void {
  const map = loadResolvedAmounts(myPubkeyHex)
  map[utxoId] = amountMicrotari
  save(myPubkeyHex, map)
}

// Drop cached amounts for the given utxo ids (M9.0a conversation delete).
export function removeResolvedAmounts(myPubkeyHex: string, utxoIds: string[]): void {
  if (utxoIds.length === 0) return
  const map = loadResolvedAmounts(myPubkeyHex)
  let changed = false
  for (const id of utxoIds) { if (id in map) { delete map[id]; changed = true } }
  if (changed) save(myPubkeyHex, map)
}

// Migrate this cache to the sealed format at unlock, discarding what it reads.
//
// The other four tier-2 stores are READ at startup, so loadStore's migrate-on-read reaches them for
// free. This one is not: its only reader is the received-payment card, so a wallet whose visible
// conversations happen to hold no received payment would never open the record at all — and a store
// that also writes only when a NEW payment resolves would then sit in plaintext indefinitely, which
// is precisely the gap migrate-on-read exists to close.
//
// A named export rather than a bare `void loadResolvedAmounts(...)` at the call site, so the
// discarded result reads as the point rather than as a mistake.
export function migrateResolvedAmounts(myPubkeyHex: string): void {
  loadResolvedAmounts(myPubkeyHex)
}
