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

export function loadLedger(walletAddress: string): UtxoLedger {
  let stored: UtxoLedger = EMPTY
  try {
    const raw = localStorage.getItem(key(walletAddress))
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UtxoLedger>
      stored = {
        firstSeen: parsed.firstSeen && typeof parsed.firstSeen === 'object' ? parsed.firstSeen : {},
        baseline: Array.isArray(parsed.baseline) ? parsed.baseline : null,
        baselineAt: typeof parsed.baselineAt === 'number' ? parsed.baselineAt : null,
        degradedAt: typeof parsed.degradedAt === 'number' ? parsed.degradedAt : null,
      }
    }
  } catch { stored = EMPTY }

  const session = sessionDegradations.get(walletAddress) ?? null
  if (stored.degradedAt === null && session !== null) return { ...stored, degradedAt: session }
  return stored
}

/** Returns false when the write did not land. */
function save(walletAddress: string, ledger: UtxoLedger): boolean {
  try {
    localStorage.setItem(key(walletAddress), JSON.stringify(ledger))
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
