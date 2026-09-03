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
// ── ENCRYPTED AT REST ────────────────────────────────────────────────────────
//
// The entry list is sealed under the session store key (sessionKey.ts) through storeCrypto's
// envelope. This file used to write every recipient address, every amount, every note and a
// complete private↔public movement history to disk in the clear — the one record that reconstructs
// what the chain's confidentiality was hiding — and it was the first store fixed for exactly that
// reason.
//
// The cost is as predicted: a journal unreadable while locked. Nothing reads it while locked
// (journalSnapshot short-circuits on a null address), so the cost is theoretical today.
//
// MIGRATION IS LAZY AND PER RECORD. A journal written before this reads through storeCrypto's v1
// passthrough and is re-emitted sealed by the next write — and since every write already rewrites
// the whole array, migration is a side effect of ordinary use rather than a sweep. Nothing is ever
// wiped.
//
// STILL PLAINTEXT, DELIBERATELY: the epoch below. It is the channel that RECORDS a failed write, so
// making it depend on the same key and the same cipher as the thing whose failure it records would
// couple the alarm to the fault. It is also metadata — timestamps and action kinds — not the
// movement history this file exists to protect.
//
// The remaining stores (txHistory, messages, the ledger, the messaging maps) are still plaintext
// and are the subject of later stages. This one is done.

import { getStoreKey } from './sessionKey'
import { open, seal } from './storeCrypto'
import {
  applyPatch, coverageComplete, draftToEntry,
  type JournalDraft, type JournalEntry, type JournalEpoch, type JournalPatch,
  type OutputCreatingAction,
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

/**
 * The stored value, decided: readable entries, nothing there, or present-but-unopenable.
 *
 * `loadJournal` flattens the last two to `[]` because a display path has nothing useful to do with
 * the difference. `save` does not — see the note there.
 */
type ReadResult =
  | { status: 'ok'; entries: JournalEntry[] }
  | { status: 'empty' }
  | { status: 'unreadable' }

function read(walletAddress: string): ReadResult {
  let raw: string | null
  try {
    raw = localStorage.getItem(key(walletAddress))
  } catch {
    return { status: 'unreadable' }   // storage disabled — not "no journal"
  }

  const opened = open(getStoreKey(), raw)
  if (opened.status !== 'ok') return opened

  try {
    const parsed = JSON.parse(opened.json) as EntryRaw[]
    // A decrypted payload that is not an array is a corrupt record, not an empty journal — the
    // distinction matters because save() refuses to overwrite the former.
    if (!Array.isArray(parsed)) return { status: 'unreadable' }
    return { status: 'ok', entries: parsed.map(fromRaw) }
  } catch {
    return { status: 'unreadable' }
  }
}

export function loadJournal(walletAddress: string): JournalEntry[] {
  const result = read(walletAddress)
  return result.status === 'ok' ? result.entries : []
}

/**
 * Returns false when the write did not land — the caller stamps the epoch.
 *
 * TWO REFUSALS BEFORE THE WRITE IS EVEN ATTEMPTED, and both report failure the same way a quota
 * error does, so the existing degradation contract carries them without changing.
 *
 * 1. NO STORE KEY. Falling back to plaintext would defeat the entire point, and throwing would take
 *    down a send that has already left the wallet. "Not recorded" is the honest outcome and the
 *    epoch exists to say it. This should not happen while unlocked — sessionKey is set before
 *    adoptIdentity — so reaching it means something is wrong and degrading is correct.
 *
 * 2. THE CURRENT RECORD IS PRESENT BUT UNREADABLE. This is the guard against silent total loss. A
 *    key that is present but WRONG — a re-minted salt — makes read() return `unreadable`, which
 *    loadJournal flattens to `[]`; beginEntry would then build a one-row array from that emptiness
 *    and this function would encrypt it perfectly well and overwrite an entire history it never
 *    understood. Refusing to write over bytes we could not read is what keeps the migration
 *    lossless in the one case where it could silently not be.
 *
 * Note that both refusals are consistent with what read() would return, and that consistency is the
 * invariant: if the load path cannot read a record, the save path must not replace it.
 */
function save(walletAddress: string, entries: JournalEntry[]): boolean {
  const storeKey = getStoreKey()
  if (storeKey === null) return false
  if (read(walletAddress).status === 'unreadable') return false

  try {
    localStorage.setItem(key(walletAddress), seal(storeKey, JSON.stringify(entries.map(toRaw))))
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
      const parsed = JSON.parse(raw) as Partial<JournalEpoch>
      if (typeof parsed?.startedAt === 'number') {
        stored = {
          startedAt: parsed.startedAt,
          degradedAt: parsed.degradedAt ?? null,
          // MIGRATION, AND IT IS A NO-OP BY DESIGN. An epoch written before coverage tracking
          // existed reads back as covering nothing, which classifies nothing — the safe default.
          // There is no rewrite and no version bump: absence already means the right thing.
          covers: Array.isArray(parsed.covers) ? parsed.covers : [],
          coverageCompleteAt: typeof parsed.coverageCompleteAt === 'number' ? parsed.coverageCompleteAt : null,
        }
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
  const fresh: JournalEpoch = { startedAt: now, degradedAt: null, covers: [], coverageCompleteAt: null }
  saveEpoch(walletAddress, fresh)
  return fresh
}

/**
 * Declare that the journal now records these output-creating actions.
 *
 * NO CALLER YET. Stage D calls it, once the chat and @name capture actually ship — declaring
 * coverage before the recording exists would be the one lie this whole apparatus is built to
 * prevent, so the ordering is the guard.
 *
 * `coverageCompleteAt` is stamped the first time the set becomes complete and never moves after.
 * It is the threshold every classification is measured against, so a later re-declaration must not
 * be able to slide it forward and quietly re-admit UTXOs that arrived in between.
 */
export function recordCoverage(
  walletAddress: string,
  actions: readonly OutputCreatingAction[],
  now = Date.now(),
): JournalEpoch {
  const epoch = ensureEpoch(walletAddress, now)
  const covers = [...new Set([...epoch.covers, ...actions])]
  const nowComplete = coverageComplete(covers)
  const next: JournalEpoch = {
    ...epoch,
    covers,
    coverageCompleteAt: epoch.coverageCompleteAt ?? (nowComplete ? now : null),
  }
  saveEpoch(walletAddress, next)
  return next
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

// ── Reading it from React ─────────────────────────────────────────────────────
//
// The journal is written straight to localStorage by the call sites, with no React state in
// between — which is right for a ledger and useless for a list that has to update. These three
// give `useSyncExternalStore` what it needs: a subscription, and a snapshot.
//
// ── THE SNAPSHOT MUST BE REFERENTIALLY STABLE ────────────────────────────────
//
// `loadJournal` parses JSON and returns a NEW array every call. Handing that to
// useSyncExternalStore re-renders forever: React compares snapshots by identity, sees a different
// array each time, and re-reads. So the parsed result is cached and only invalidated by a write.
// Two calls with no write between them return the identical array, and there is a test for it.

const listeners = new Set<() => void>()

let cachedAddress: string | null = null
let cachedEntries: JournalEntry[] = []
let cacheValid = false

/** Shared empty array, so a caller with no wallet also gets a stable reference. */
const NO_ENTRIES: JournalEntry[] = []

export function subscribeJournal(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

/** The current journal, cached. Same array back until something writes. */
export function journalSnapshot(walletAddress: string | null): JournalEntry[] {
  if (walletAddress === null) return NO_ENTRIES
  if (cacheValid && cachedAddress === walletAddress) return cachedEntries
  cachedEntries = loadJournal(walletAddress)
  cachedAddress = walletAddress
  cacheValid = true
  return cachedEntries
}

/** Invalidate and notify. Called by every write below — there is no other way to mutate. */
function emitChange(): void {
  cacheValid = false
  for (const l of listeners) l()
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
  emitChange()
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
  emitChange()
  return { ok, found: true }
}

/** Test seam only — clears the in-session degradation record. Never called by the app. */
export function __resetSessionDegradationsForTests(): void {
  sessionDegradations.clear()
  cacheValid = false
  cachedAddress = null
  cachedEntries = []
}
