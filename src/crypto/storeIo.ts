// Sealed load/save for the simple stores — the tier-2 map and list stores (stage 4).
//
// ── WHY THIS EXISTS, AND WHY TIER 1 DOES NOT USE IT ──────────────────────────
//
// Stages 2 and 3 hand-rolled the same read/discriminate/migrate/guard sequence into journalStore,
// txHistory, utxoLedger and messageStore. That was right there: each of those has a genuinely
// different shape — a bigint mapping, field-by-field defaults, a three-state read, a session
// degradation merge — and forcing them through one signature would have obscured more than it saved.
//
// Tier 2 is five near-identical `Record<string, T>` and `T[]` stores, and copying the sequence five
// more times would be five more chances to get a guard subtly wrong. THE GUARDS ARE THE POINT: a
// wrong one means either silent total loss or a plaintext leak, and stage 3 showed they have
// non-obvious failure modes (see the migrate-on-read note below, which was caught in verification
// rather than review). Centralising them puts each invariant in one tested place.
//
// TIER 1 IS DELIBERATELY NOT RETROFITTED. Those four are committed and hand-verified against real
// device data; rewriting them to route through this would put verified code back in play for no
// behavioural gain. Available cleanup, not a debt.
//
// ── THE THREE INVARIANTS THIS OWNS ───────────────────────────────────────────
//
// 1. NEVER CLOBBER A RECORD WE COULD NOT READ. Every one of these stores is `(id, current, …) =>
//    next` over React state seeded at unlock, so under a wrong key the load returns empty, the next
//    mutation builds a one-entry map from that emptiness, and the write encrypts it over the whole
//    history. writeStore refuses when the record on disk cannot be opened.
//
// 2. NEVER REWRITE AN ALREADY-SEALED RECORD ON READ. Without that check, migrate-on-read would
//    re-encrypt the store on every single load — a fresh nonce and a write per render.
//
// 3. NEVER FALL BACK TO PLAINTEXT. No store key means the read degrades to empty and the write is
//    refused. Writing in the clear would defeat the entire exercise.
//
// ── MIGRATE ON READ ──────────────────────────────────────────────────────────
//
// All five tier-2 stores are REFERENCE DATA: set once, read constantly. tariAddressStore writes
// only when an address is pasted or exchanged, contactStore only on a state change, nicknameStore
// only on a rename, groupStore is first-def-wins, and paymentResolutionStore only when a NEW
// payment resolves. An established wallet writes none of them, so lazy-on-write alone would leave
// the entire social graph in plaintext indefinitely — the exact gap utxoLedger hit in stage 3.
//
// So loadStore migrates. It persists the PARSED value, not the raw bytes, which means a store's own
// in-load migration becomes permanent at the same time — tariAddressStore's legacy bare strings and
// groupStore's missing `state` have both been re-derived on every load until now.

import { getStoreKey } from './sessionKey'
import { open, seal } from './storeCrypto'

/**
 * What a stored value turned out to be.
 *
 * `legacy` reports the FORMAT of a successful read — v1 plaintext, or a decrypted v2 envelope —
 * which is what drives the migration. It says nothing about readability; an unreadable record has
 * no format to report.
 */
export type StoreRead<T> =
  | { status: 'ok'; value: T; legacy: boolean }
  | { status: 'empty' }
  | { status: 'unreadable' }

/**
 * Validate and shape a decoded JSON value, or return `null` to declare the record unreadable.
 *
 * This is where a store puts its own defaulting and its own in-load migrations. Returning null must
 * mean "I could not make sense of this", because the caller treats it exactly as it treats a failed
 * decrypt: read as empty, and refuse to write over it.
 */
export type Parse<T> = (decoded: unknown) => T | null

/** Decrypt-and-JSON status only. Deliberately does NOT run the store's Parse — see writeStore. */
function statusOf<T>(storageKey: string, parse: Parse<T>): 'ok' | 'empty' | 'unreadable' {
  const result = readStore(storageKey, parse)
  return result.status
}

export function readStore<T>(storageKey: string, parse: Parse<T>): StoreRead<T> {
  let raw: string | null
  try {
    raw = localStorage.getItem(storageKey)
  } catch {
    return { status: 'unreadable' }   // storage disabled — not "nothing stored"
  }

  const opened = open(getStoreKey(), raw)
  if (opened.status !== 'ok') return opened

  let decoded: unknown
  try {
    decoded = JSON.parse(opened.json)
  } catch {
    return { status: 'unreadable' }
  }

  const value = parse(decoded)
  if (value === null) return { status: 'unreadable' }
  return { status: 'ok', value, legacy: opened.legacy }
}

/**
 * Read a store, migrating it to the sealed format if it is still plaintext.
 *
 * `empty` is what an absent or unopenable record reads as, matching what each store returned before
 * encryption reached it. It is a factory rather than a value so two callers can never share one
 * mutable object.
 *
 * THE MIGRATION WRITE CANNOT DESTROY ANYTHING: it happens only on a confirmed `ok` read, only when
 * the record was plaintext, and writeStore refuses again underneath. With no store key a legacy
 * record still reads — there is nothing to decrypt — but cannot be sealed, so it waits for an
 * unlocked session rather than being rewritten or lost.
 */
export function loadStore<T>(storageKey: string, parse: Parse<T>, empty: () => T): T {
  const result = readStore(storageKey, parse)
  if (result.status !== 'ok') return empty()
  if (result.legacy) writeStore(storageKey, JSON.stringify(result.value), parse)
  return result.value
}

/**
 * Seal and store a value. Returns whether it landed.
 *
 * `parse` is taken so the never-clobber check asks EXACTLY the question the read asks. A record that
 * decrypts and parses as JSON but does not satisfy the store's own shape is unreadable to that
 * store, and overwriting it would be the same silent loss as overwriting ciphertext we could not
 * decrypt.
 *
 * Most callers discard the boolean: none of these five stores has a success contract, and all of
 * them are called from inside React state updaters with nowhere to route a failure. A refused write
 * therefore behaves exactly as a quota failure always has — React state holds something disk does
 * not, and a reload loses it.
 */
export function writeStore<T>(storageKey: string, json: string, parse: Parse<T>): boolean {
  const storeKey = getStoreKey()
  if (storeKey === null) return false
  if (statusOf(storageKey, parse) === 'unreadable') return false

  try {
    localStorage.setItem(storageKey, seal(storeKey, json))
    return true
  } catch {
    return false   // quota / private mode
  }
}

// ── Parsers shared by the map stores ─────────────────────────────────────────

/** A plain JSON object — the shape every tier-2 map store persists. Arrays are rejected. */
export function asRecord(decoded: unknown): Record<string, unknown> | null {
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null
  return decoded as Record<string, unknown>
}
