// Persistent cache of RESOLVED payment amounts (M10.2), sibling to messageStore.ts.
//
// A resolved amount for a given UTXO id never changes, so we cache it to avoid re-fetching on
// every render/unlock. Successes only — failures stay in memory and are retryable. This is
// LOCAL, DERIVED data: it is NOT stored on CaravelMessage.payment (that is the wire PaymentRef),
// same separation of concerns as M10.1's localPayment.
//
// Conventions match nicknameStore/tariAddressStore: per-identity key (keyed under MY pubkey),
// quota errors swallowed. Amount is a decimal µTari STRING so it JSON-serialises without bigint.

// utxoId → amountMicrotari (decimal string), for the current identity.
export type ResolvedAmountMap = Record<string, string>

function key(myPubkeyHex: string) { return `caravel.payresolved.v1.${myPubkeyHex}` }

export function loadResolvedAmounts(myPubkeyHex: string): ResolvedAmountMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    return JSON.parse(raw) as ResolvedAmountMap
  } catch { return {} }
}

// Cache one resolved amount (read-modify-write). No `current` param — each card resolves its own
// id independently, so there is no single React mirror of the whole map to thread through.
export function cacheResolvedAmount(myPubkeyHex: string, utxoId: string, amountMicrotari: string): void {
  try {
    const map = loadResolvedAmounts(myPubkeyHex)
    map[utxoId] = amountMicrotari
    localStorage.setItem(key(myPubkeyHex), JSON.stringify(map))
  } catch { /* quota / private mode */ }
}
