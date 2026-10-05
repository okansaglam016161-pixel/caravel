// Coins held by a PREPARED transaction — priced and built, shown on a review screen, not yet sent.
//
// ── THE WINDOW THIS CLOSES ───────────────────────────────────────────────────
//
// crypto/spentOutputs locks a coin at SUBMIT. That covers the wire, but every prepare path now
// selects its coins minutes earlier: the review screen shows a fee for a transaction built from
// specific outputs, and the user may sit on it. In that window a second prepare — another tab, a
// reveal started while a send is under review, a chat payment — would select the SAME outputs.
// Whichever is confirmed second is then built on a coin the first has spent: a guaranteed reject,
// and on this network a reject can still cost its fee.
//
// So a prepare RESERVES what it selected, and every selection excludes what is reserved. A
// reservation is short-lived by construction:
//
//   released   when the review is cancelled, superseded by a re-price, or the transaction is
//              submitted (at which point spentOutputs' lock takes over);
//   expires    after RESERVATION_TTL_MS regardless — a tab closed on a review screen must not hold
//              a coin hostage. The TTL is longer than QUOTE_MAX_AGE_MS (crypto/quote), so a quote
//              that is still confirmable always still holds its coins.
//
// ── WHAT IT DOES NOT TOUCH ───────────────────────────────────────────────────
//
// THE BALANCE. A reserved coin is still the wallet's and still unspent; only coin SELECTION skips
// it. That is why this is its own record rather than a third spentOutputs status: spentOutputs'
// exclusion feeds the balance scan, and a review screen must not make money vanish from the hero.
//
// Persisted in localStorage — sealed, like the spend record, because which coins a wallet is about
// to spend is the same clustering data — so a reservation is visible to every tab of this origin.
// With no store key (a locked wallet) it falls back to this tab's memory: there is nothing to spend
// from a locked wallet anyway. A storage write that fails costs the hold, never the payment — the
// spend-time lock in spentOutputs still applies.

import { getStoreKey } from './sessionKey'
import { open, seal } from './storeCrypto'
import { loadExcludedIds } from './spentOutputs'

/** How long a prepared transaction may hold its coins without being submitted or released. */
export const RESERVATION_TTL_MS = 3 * 60_000

interface Reservation { token: string; until: number }
type Reservations = Record<string, Reservation>

function key(walletAddress: string) { return `caravel.utxoreserved.v1.${walletAddress}` }

/** The fallback when nothing can be persisted. Keyed like storage, per wallet. */
const memory = new Map<string, Reservations>()

function load(walletAddress: string, now: number): Reservations {
  // ONE SOURCE AT A TIME: storage when there is a key to read it with, this tab's memory when not.
  // Merging the two would let a hold outlive the storage it was written to.
  let stored: Reservations = {}
  const storeKey = getStoreKey()
  if (!storeKey) {
    stored = memory.get(walletAddress) ?? {}
  } else {
    try {
      const opened = open(storeKey, localStorage.getItem(key(walletAddress)))
      if (opened.status === 'ok') {
        const parsed: unknown = JSON.parse(opened.json)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Reservations
      }
    } catch { /* unreadable storage reads as "none" — the safe default is the spend-time lock */ }
  }
  // Drop anything expired or malformed on every read, so nothing downstream sees a stale hold.
  const live: Reservations = {}
  for (const [id, r] of Object.entries(stored)) {
    if (r && typeof r.token === 'string' && typeof r.until === 'number' && r.until > now) live[id] = r
  }
  return live
}

function save(walletAddress: string, next: Reservations): void {
  const storeKey = getStoreKey()
  if (!storeKey) { memory.set(walletAddress, next); return }
  // A write that does not land costs the hold, not the payment: the spend-time lock still applies.
  try { localStorage.setItem(key(walletAddress), seal(storeKey, JSON.stringify(next))) } catch { /* see above */ }
}

let counter = 0
/** A token naming one prepare's hold, so releasing it can never release someone else's. */
export function newReservationToken(): string {
  counter += 1
  return `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Hold `ids` for the prepare named by `token`. A coin already held by a DIFFERENT live token is
 * left with its holder — selection excluded it, so reaching here with one means two prepares raced,
 * and the first to reserve keeps it. Returns false in that case so the caller can re-select.
 */
export function reserveCoins(walletAddress: string, ids: readonly string[], token: string, now = Date.now()): boolean {
  if (!walletAddress || ids.length === 0) return true
  const current = load(walletAddress, now)
  let clean = true
  for (const id of ids) {
    const held = current[id]
    if (held && held.token !== token) { clean = false; continue }
    current[id] = { token, until: now + RESERVATION_TTL_MS }
  }
  save(walletAddress, current)
  return clean
}

/** Release everything `token` holds. Idempotent; never touches another token's coins. */
export function releaseCoins(walletAddress: string, token: string, now = Date.now()): void {
  if (!walletAddress) return
  const current = load(walletAddress, now)
  let changed = false
  for (const [id, r] of Object.entries(current)) {
    if (r.token === token) { delete current[id]; changed = true }
  }
  if (changed) save(walletAddress, current)
}

/** Coins currently held by a live reservation — what coin selection must skip. */
export function loadReservedIds(walletAddress: string, now = Date.now()): Set<string> {
  if (!walletAddress) return new Set()
  return new Set(Object.keys(load(walletAddress, now)))
}

export function __resetReservationsForTests(): void {
  memory.clear()
}

/**
 * Everything coin SELECTION must skip: what the spend record excludes (spent, and locked on the
 * wire) plus what a prepared transaction is holding. The balance reads loadExcludedIds alone.
 */
export function loadSelectionExcludedIds(walletAddress: string, now = Date.now()): Set<string> {
  const ids = loadExcludedIds(walletAddress)
  for (const id of loadReservedIds(walletAddress, now)) ids.add(id)
  return ids
}
