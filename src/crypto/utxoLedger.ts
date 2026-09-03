// When this wallet FIRST SAW each UTXO it owns — and which ones predate the journal entirely.
//
// ── WHY THIS HAS TO EXIST ────────────────────────────────────────────────────
//
// Receive reconciliation subtracts the wallet's own journalled outputs from the UTXOs the scan
// owns and treats the leftover as money somebody else sent. That subtraction is only safe over a
// window the journal actually covers, and the scan supplies no window at all: `/utxos` returns an
// unordered set with no timestamps and no heights, and `scanWallet` returns a fresh full snapshot
// every time. Nothing in the app has ever recorded that it saw a UTXO, so there was no `observedAt`
// for a guard to compare against. This is that record.
//
// ── THE BASELINE IS THE PART THAT MAKES THE GUARD SOUND ──────────────────────
//
// A first-seen DATE alone is not enough, and it fails in the dangerous direction. `firstSeen` is
// when we LOOKED, not when the UTXO appeared: a wallet whose owner closed the app for a week, or
// whose earlier scan came back truncated, records a late date for an output that is in fact old.
// Compared against a journal epoch, that late date passes the guard — and the output may be
// pre-journal change of the user's own, which is precisely the thing that must never be shown as a
// stranger's payment.
//
// So the real guard is a SET, not a clock. At the moment the journal's coverage becomes complete,
// one complete scan is snapshotted and every UTXO in it is marked pre-epoch, permanently
// unclassifiable. Set membership is immune to clock drift, indexer lag and an app that was closed.
// `firstSeen` then answers the narrower question the baseline cannot: of the UTXOs that are NOT in
// the baseline, when did each first appear.
//
// The baseline is defined here and stays null until coverage completes — nothing populates it yet.
//
// ── COMPLETE SCANS ONLY ──────────────────────────────────────────────────────
//
// A truncated scan (the indexer capped the set) sees a subset, so a UTXO it missed would be
// recorded as first seen on some later, complete scan — a later date than the truth, which is the
// permissive direction again. `recordCompleteScan` therefore refuses a truncated scan outright,
// and it takes the whole scan shape rather than a list of ids so that the rule lives in this
// module, under test, instead of at a call site where it can be forgotten.

import { getStoreKey } from './sessionKey'
import { open, seal } from './storeCrypto'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UtxoLedger {
  /** utxoId → the first moment a complete scan showed us this UTXO. First write wins, always. */
  firstSeen: Record<string, number>
  /**
   * Every UTXO owned at the moment the journal's coverage became complete — pre-epoch, and never
   * classifiable as a receive. `null` until coverage completes; populated once and never again.
   */
  baseline: string[] | null
  baselineAt: number | null
  /**
   * First moment a ledger write was lost.
   *
   * Same reasoning as the journal's: a dropped write means a UTXO carries a later first-seen date
   * than the truth, or none at all, and both read as "newer than it is". A hole here is a hole in
   * the guard, so it is recorded rather than swallowed.
   */
  degradedAt: number | null
}

/** The part of a scan this module needs. Taken whole so the completeness rule cannot be bypassed. */
export interface ScanObservation {
  utxoIds: readonly string[]
  /** True when the indexer capped the returned set — the scan saw a subset of what we own. */
  incomplete: boolean
}

const EMPTY: UtxoLedger = { firstSeen: {}, baseline: null, baselineAt: null, degradedAt: null }

// ── ENCRYPTED AT REST (stage 3) ──────────────────────────────────────────────
//
// Sealed under the session store key through storeCrypto. What this file records — which outputs
// are ours, and when each was first seen — is the clustering data that links a wallet's outputs to
// each other, so it belongs in the same tier as the journal.
//
// IT FAILS CLOSED, which is why encrypting it is safe for reconciliation. An unopenable record
// reads as EMPTY, so `baseline` is null, so isPreEpoch() answers true for every UTXO and reconcile
// suppresses all of them as pre-epoch. A key failure therefore produces NO receives rather than
// wrong ones — the same direction the design already chose for an absent ledger.
//
// Migration is lazy: a plaintext ledger reads through the v1 passthrough and is re-emitted sealed
// by the next scan. Nothing is ever wiped.

// ── Storage ───────────────────────────────────────────────────────────────────

function key(walletAddress: string) { return `caravel.utxoseen.v1.${walletAddress}` }

/**
 * Degradations known to THIS SESSION, whether or not they reached disk.
 *
 * Identical reasoning to journalStore's: the write that records a failed write is liable to fail
 * for the same reason. Across a reload an absent ledger reads as `firstSeen: {}` and no baseline,
 * which classifies nothing — so the unsafe combination cannot survive a reload either way.
 */
const sessionDegradations = new Map<string, number>()

/** Was the stored record readable? `unreadable` is what save() refuses to overwrite. */
function readStatus(walletAddress: string): 'ok' | 'empty' | 'unreadable' {
  let raw: string | null
  try {
    raw = localStorage.getItem(key(walletAddress))
  } catch {
    return 'unreadable'
  }
  const opened = open(getStoreKey(), raw)
  if (opened.status !== 'ok') return opened.status
  try {
    const parsed: unknown = JSON.parse(opened.json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? 'ok' : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

export function loadLedger(walletAddress: string): UtxoLedger {
  let stored: UtxoLedger = EMPTY
  let wasPlaintext = false
  try {
    const raw = localStorage.getItem(key(walletAddress))
    const opened = open(getStoreKey(), raw)
    // An unopenable record reads as EMPTY — see the header: that is the fail-closed direction, and
    // reconcile already treats a null baseline as "nothing is classifiable".
    if (opened.status === 'ok') {
      const parsed = JSON.parse(opened.json) as Partial<UtxoLedger>
      stored = {
        firstSeen: parsed.firstSeen && typeof parsed.firstSeen === 'object' ? parsed.firstSeen : {},
        baseline: Array.isArray(parsed.baseline) ? parsed.baseline : null,
        baselineAt: typeof parsed.baselineAt === 'number' ? parsed.baselineAt : null,
        degradedAt: typeof parsed.degradedAt === 'number' ? parsed.degradedAt : null,
      }
      wasPlaintext = opened.legacy
    }
  } catch { stored = EMPTY; wasPlaintext = false }

  // ── MIGRATE ON READ ────────────────────────────────────────────────────────
  //
  // WHY THIS STORE NEEDS IT AND THE OTHERS DO NOT. journalStore, txHistory and messageStore all
  // rewrite themselves during ordinary use — a send, a message, any wallet action — so their lazy
  // migration lands on the next thing the user does. This one is FIRST-WRITE-WINS: recordCompleteScan
  // returns before save() when a scan brings no new UTXO, and captureBaseline is skipped once a
  // baseline exists. A wallet that is not transacting therefore never writes, and would keep its
  // firstSeen map and baseline — tier-1 output-clustering data — in plaintext indefinitely.
  //
  // So the read migrates, exactly as txHistory's read does when it strips legacy rows.
  //
  // THREE THINGS THIS MUST NOT DO, all load-bearing:
  //   1. Never on `unreadable` — writing over bytes we could not open is the loss this whole design
  //      guards against. Only a confirmed `ok` read reaches here.
  //   2. Never on an already-sealed record — `legacy` is false there, so every subsequent load is a
  //      pure read. Without that check each load would rewrite the store.
  //   3. Persist `stored`, NOT the session-merged value below. A degradation known only to this
  //      session must not become a persisted one as a side effect of somebody reading.
  //
  // save() refuses when there is no store key, which is the right answer: a legacy record still
  // reads without one (nothing to decrypt) but cannot be sealed, so it stays plaintext until an
  // unlocked session reads it. This runs inside WalletModal's reconcile useMemo, so it is a write
  // during render — once, idempotently, and touching no React state.
  if (wasPlaintext) save(walletAddress, stored)

  const session = sessionDegradations.get(walletAddress) ?? null
  if (stored.degradedAt === null && session !== null) return { ...stored, degradedAt: session }
  return stored
}

/**
 * Returns false when the write did not land.
 *
 * THE NEVER-CLOBBER GUARD MATTERS MOST HERE, because of markDegraded below: it loads the ledger and
 * writes it back with a stamp, so under a wrong key it would load EMPTY and persist EMPTY —
 * destroying firstSeen and baseline in the very act of recording that something went wrong. The
 * guard refuses, and the in-session map still holds the flag, which this file already treats as the
 * durable half.
 */
function save(walletAddress: string, ledger: UtxoLedger): boolean {
  const storeKey = getStoreKey()
  if (storeKey === null) return false
  if (readStatus(walletAddress) === 'unreadable') return false

  try {
    localStorage.setItem(key(walletAddress), seal(storeKey, JSON.stringify(ledger)))
    return true
  } catch { return false }
}

/** Record a lost write. In-session first, because that cannot fail; persisting is best-effort. */
function markDegraded(walletAddress: string, now: number): void {
  if (!sessionDegradations.has(walletAddress)) sessionDegradations.set(walletAddress, now)
  const current = loadLedger(walletAddress)
  if (current.degradedAt !== null) return
  save(walletAddress, { ...current, degradedAt: sessionDegradations.get(walletAddress)! })
}

// ── Recording ─────────────────────────────────────────────────────────────────

/**
 * Record everything a COMPLETE scan showed us.
 *
 * FIRST WRITE WINS. A UTXO's date is set once and never moves — a later scan seeing the same UTXO
 * is not new information about when it appeared, and letting the date drift forward would make an
 * old output look recent, which is the direction that produces a false receive.
 *
 * A TRUNCATED SCAN IS REFUSED, not partially applied. Recording the subset it did see would stamp
 * genuinely-new UTXOs correctly while leaving the missed ones to be stamped later — later than the
 * truth. Writing nothing keeps the ledger honest at the cost of a delay.
 */
export function recordCompleteScan(
  walletAddress: string,
  observation: ScanObservation,
  now = Date.now(),
): { ledger: UtxoLedger; ok: boolean; added: number; skipped: 'incomplete' | null } {
  const current = loadLedger(walletAddress)
  if (observation.incomplete) {
    return { ledger: current, ok: true, added: 0, skipped: 'incomplete' }
  }

  const firstSeen = { ...current.firstSeen }
  let added = 0
  for (const id of observation.utxoIds) {
    if (id in firstSeen) continue
    firstSeen[id] = now
    added++
  }
  if (added === 0) return { ledger: current, ok: true, added: 0, skipped: null }

  const next: UtxoLedger = { ...current, firstSeen }
  const ok = save(walletAddress, next)
  if (!ok) markDegraded(walletAddress, now)
  return { ledger: ok ? next : current, ok, added, skipped: null }
}

/**
 * Freeze the pre-epoch set. Called once, when the journal's coverage becomes complete — see the
 * header. Not called by anything yet.
 *
 * WRITE-ONCE. A second capture would re-baseline UTXOs that arrived in between, quietly erasing
 * every receive that had become classifiable. Refused rather than overwritten.
 *
 * Refuses a truncated scan for the same reason recording does — worse here, because a baseline
 * missing a UTXO leaves that UTXO permanently eligible for classification.
 */
export function captureBaseline(
  walletAddress: string,
  observation: ScanObservation,
  now = Date.now(),
): { ledger: UtxoLedger; ok: boolean; captured: boolean } {
  const current = loadLedger(walletAddress)
  if (current.baseline !== null) return { ledger: current, ok: true, captured: false }
  if (observation.incomplete) return { ledger: current, ok: true, captured: false }

  const next: UtxoLedger = {
    ...current,
    baseline: [...observation.utxoIds],
    baselineAt: now,
    // Everything in the baseline is, by definition, seen now at the latest.
    firstSeen: observation.utxoIds.reduce<Record<string, number>>(
      (acc, id) => (id in acc ? acc : { ...acc, [id]: now }),
      { ...current.firstSeen },
    ),
  }
  const ok = save(walletAddress, next)
  if (!ok) markDegraded(walletAddress, now)
  return { ledger: ok ? next : current, ok, captured: ok }
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** When this UTXO was first seen by a complete scan, or null if it has never been recorded. */
export function firstSeenAt(ledger: UtxoLedger, utxoId: string): number | null {
  return ledger.firstSeen[utxoId] ?? null
}

/**
 * Was this UTXO already owned when coverage completed?
 *
 * `true` means never classifiable. NO BASELINE ALSO MEANS TRUE — coverage has not completed, so
 * nothing is known to be new, and the safe answer to "is this pre-epoch" is yes.
 */
export function isPreEpoch(ledger: UtxoLedger, utxoId: string): boolean {
  if (ledger.baseline === null) return true
  return ledger.baseline.includes(utxoId)
}

/** Test seam only — clears the in-session degradation record. Never called by the app. */
export function __resetLedgerSessionForTests(): void {
  sessionDegradations.clear()
}
