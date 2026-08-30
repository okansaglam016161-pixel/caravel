// Persistence for the activity journal. Sibling to txHistory.ts, and deliberately the same shape:
// a per-identity localStorage key, pure helpers that return the next array, no React.
//
// ── THE OLD STORE IS NOT TOUCHED ─────────────────────────────────────────────
//
// caravel.txhistory.v1.* keeps working exactly as it does and keeps feeding Activity. This writes
// alongside it under its own key. Nothing is migrated, nothing is deleted, and the display phase
// merges the two by txId — so a bad journal cannot cost a user the send history they already had.
//
// ── WHY SAVES REPORT SUCCESS ─────────────────────────────────────────────────
//
// Every other store in this app writes `catch { /* quota / private mode */ }` and moves on, which
// is right for a cache and wrong for a ledger. A silently dropped journal write leaves a hole that
// later makes the wallet call its OWN change output a payment from a stranger. So every write here
// returns whether it landed, and the first failure stamps the epoch as degraded — permanently, and
// for that wallet only.
//
// ── PLAINTEXT, FOR NOW ───────────────────────────────────────────────────────
//
// REVISIT BEFORE MAINNET. This file writes, unencrypted, to disk: every recipient address, every
// amount, every note, and a complete private↔public movement history that the chain deliberately
// conceals. It is consistent with how messages and txHistory are already stored — only the seed is
// encrypted at rest — but it is a larger disclosure than either, because it is the one record that
// reconstructs what the confidentiality was hiding. The primitives to encrypt it under the unlock
// password already exist in walletCrypto.ts; the cost is a journal unreadable while locked.

import {
  applyPatch, draftToEntry,
  type JournalDraft, type JournalEntry, type JournalEpoch, type JournalPatch,
} from './journal'

// ── Serialization ─────────────────────────────────────────────────────────────
//
// bigint cannot round-trip through JSON, so amounts are stored as decimal strings — the same
// approach txHistory uses, for the same reason. `null` survives as `null`: the distinction between
// "no amount known" and "zero" has to persist across a reload or the record loses its meaning.

interface EntryRaw extends Omit<JournalEntry, 'amountMicrotari' | 'feeMicrotari'> {
  amountMicrotari: string | null
  feeMicrotari: string | null
}

function toRaw(e: JournalEntry): EntryRaw {
  return {
    ...e,
    amountMicrotari: e.amountMicrotari === null ? null : e.amountMicrotari.toString(),
    feeMicrotari: e.feeMicrotari === null ? null : e.feeMicrotari.toString(),
  }
}

function fromRaw(r: EntryRaw): JournalEntry {
  return {
    ...r,
    amountMicrotari: r.amountMicrotari === null ? null : BigInt(r.amountMicrotari),
    feeMicrotari: r.feeMicrotari === null ? null : BigInt(r.feeMicrotari),
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

function key(walletAddress: string) { return `caravel.journal.v1.${walletAddress}` }
function epochKey(walletAddress: string) { return `caravel.journal.epoch.v1.${walletAddress}` }

export function loadJournal(walletAddress: string): JournalEntry[] {
  try {
    const raw = localStorage.getItem(key(walletAddress))
    if (!raw) return []
    const parsed = JSON.parse(raw) as EntryRaw[]
    if (!Array.isArray(parsed)) return []
    return parsed.map(fromRaw)
  } catch { return [] }
}

/** Returns false when the write did not land — the caller stamps the epoch. */
function save(walletAddress: string, entries: JournalEntry[]): boolean {
  try {
    localStorage.setItem(key(walletAddress), JSON.stringify(entries.map(toRaw)))
    return true
  } catch { return false }
}

// ── The epoch ─────────────────────────────────────────────────────────────────

/**
 * Degradations known to THIS SESSION, whether or not they reached disk.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `markDegraded` is called precisely when a write has just failed — so the write that records the
 * failure is liable to fail too, and the flag would be lost at the very moment it is true. In
 * practice the epoch is a few dozen bytes and the entry list is not, so a quota failure on the
 * latter usually leaves room for the former; but a browser with storage disabled outright refuses
 * both, and this keeps the session honest in that case.
 *
 * ACROSS A RELOAD, ABSENCE IS THE GUARD. If nothing persisted then `loadEpoch` reads `null`, and
 * `journalCovers(null, …)` already claims nothing. So the unsafe combination — a journal that
 * looks complete but is not — cannot survive a reload either way.
 */
const sessionDegradations = new Map<string, number>()

export function loadEpoch(walletAddress: string): JournalEpoch | null {
  let stored: JournalEpoch | null = null
  try {
    const raw = localStorage.getItem(epochKey(walletAddress))
    if (raw) {
      const parsed = JSON.parse(raw) as JournalEpoch
      if (typeof parsed?.startedAt === 'number') {
        stored = { startedAt: parsed.startedAt, degradedAt: parsed.degradedAt ?? null }
      }
    }
  } catch { stored = null }

  if (!stored) return null
  const sessionDegradedAt = sessionDegradations.get(walletAddress) ?? null
  if (stored.degradedAt !== null) return stored
  if (sessionDegradedAt !== null) return { ...stored, degradedAt: sessionDegradedAt }
  return stored
}

function saveEpoch(walletAddress: string, epoch: JournalEpoch): void {
  // No success signal needed: an epoch that will not persist reads back as `null`, which
  // journalCovers already treats as "claim nothing". The failure is self-announcing.
  try { localStorage.setItem(epochKey(walletAddress), JSON.stringify(epoch)) } catch { /* quota */ }
}

/** The epoch for this wallet, starting one if journalling has not run here before. */
export function ensureEpoch(walletAddress: string, now = Date.now()): JournalEpoch {
  const existing = loadEpoch(walletAddress)
  if (existing) return existing
  const fresh: JournalEpoch = { startedAt: now, degradedAt: null }
  saveEpoch(walletAddress, fresh)
  return fresh
}

/**
 * Mark the journal as holed. IRREVERSIBLE for this wallet, and only ever set on a failed write.
 *
 * There is no un-degrade. A hole cannot be proven closed — a later successful write says nothing
 * about the entry that was lost — so the only honest recovery is a wallet whose storage is cleared
 * and whose epoch therefore starts again from nothing.
 */
export function markDegraded(walletAddress: string, now = Date.now()): JournalEpoch {
  // The in-session record FIRST, because it cannot fail. Persisting is best-effort by nature: the
  // storage that just refused an entry may refuse this too.
  if (!sessionDegradations.has(walletAddress)) sessionDegradations.set(walletAddress, now)

  const epoch = ensureEpoch(walletAddress, now)
  if (epoch.degradedAt !== null) return epoch
  const next: JournalEpoch = { ...epoch, degradedAt: sessionDegradations.get(walletAddress)! }
  saveEpoch(walletAddress, next)
  return next
}

// ── Mutation ──────────────────────────────────────────────────────────────────

/**
 * Write the first half of an entry, BEFORE the action is submitted.
 *
 * This is what closes the hole where a throwing send left no trace at all. The row exists from the
 * moment the user commits to the action, so a crash, a closed tab or an exception all leave
 * something that says the attempt happened.
 */
export function beginEntry(
  walletAddress: string,
  draft: JournalDraft,
  now = Date.now(),
): { entry: JournalEntry; ok: boolean } {
  ensureEpoch(walletAddress, now)
  const entry = draftToEntry(draft, now)
  const next = [entry, ...loadJournal(walletAddress)]
  const ok = save(walletAddress, next)
  if (!ok) markDegraded(walletAddress, now)
  return { entry, ok }
}

/**
 * Patch an entry with what the action turned out to be.
 *
 * A MISSING ENTRY IS NOT AN ERROR, and it is also not a reason to invent one: if `beginEntry`
 * failed to persist, its id is not in the store and there is nothing to patch. Writing a fresh row
 * here would paper over exactly the hole the epoch exists to record, so this reports `found: false`
 * and leaves the degradation stamp to speak for itself.
 */
export function settleEntry(
  walletAddress: string,
  id: string,
  patch: JournalPatch,
  now = Date.now(),
): { ok: boolean; found: boolean } {
  const current = loadJournal(walletAddress)
  let found = false
  const next = current.map(e => {
    if (e.id !== id) return e
    found = true
    return applyPatch(e, patch)
  })
  if (!found) return { ok: false, found: false }
  const ok = save(walletAddress, next)
  if (!ok) markDegraded(walletAddress, now)
  return { ok, found: true }
}

/** Test seam only — clears the in-session degradation record. Never called by the app. */
export function __resetSessionDegradationsForTests(): void {
  sessionDegradations.clear()
}
