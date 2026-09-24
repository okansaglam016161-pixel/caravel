// The outputs this wallet has already spent — and the ones it is spending right now.
//
// ── THE BUG THIS MODULE EXISTS TO END ────────────────────────────────────────
//
// Caravel had no record of its own spends. The balance was a pure sum of whatever `/utxos`
// returned (walletScanner: `found.reduce((sum, u) => sum + u.amount, 0n)`), and the commitments a
// transaction consumed were discarded at the module boundary — `selection.inputs` lived and died
// inside `sendConfidential`. So the wallet's only account of what it owned was the indexer's, and
// two things followed, both confirmed live:
//
//   THE BALANCE NEVER DROPPED. `/utxos` trails consensus by 60–90 seconds and, on the node this
//   app reads, measurably longer. Until it caught up the wallet kept counting coins it had spent.
//
//   COIN SELECTION RE-PICKED A SPENT COIN. Worse, and the reason this module's exclusion is wired
//   into the spend path and not only into the display: the next send selected the same output and
//   built a transaction the chain could only reject —
//   `Input substate utxo_..._685dc06e... is down`. A guaranteed-reject transaction that still
//   costs its fee.
//
// A wallet cannot outsource "what do I own" to a listing that lags. Every UTXO wallet keeps its
// own account of its spends; this is ours.
//
// ── MODELLED ON THE REFERENCE WALLET'S OutputStatus ──────────────────────────
//
// `tari_ootle_wallet_sdk`'s `models::OutputStatus` is the shape being copied, and RFC-0150 requires
// a wallet to "maintain an internal ledger" tracking Spent / Unspent / Unconfirmed:
//
//   LockedForSpend  "The output is locked for spending. Once the transaction has been accepted,
//                    this output becomes Spent."
//   Spent           "The output has been spent."
//
// Two states, so two here — `locked` and `spent`. The distinction is not cosmetic: LOCKING HAPPENS
// AT SUBMIT, before any verdict, because a coin already on the wire must not be selectable by the
// next transaction. Promotion and release then resolve the lock against what the network actually
// said. Both states exclude; only the reason differs, and the reason is what a reject can undo.
//
// ── WHY ABSENCE IS NOT PROOF, AND WHAT RECONCILIATION THEREFORE DOES ─────────
//
// The obvious way to forget an entry is "drop it the first time `/utxos` stops listing it". That
// is unsafe here, and measurably so: the two live Esmeralda indexers were compared at an identical
// epoch, block height and block hash, and indexer-a was MISSING 79 live outputs that indexer-b
// listed — an 8% shortfall, with every sampled row live on both nodes. A listing that can drop a
// live output can also bring it back, and forgetting on first absence would let a spent coin
// reappear in the balance the moment the indexer flapped.
//
// So forgetting requires agreement over time: a COMPLETE walk (never a truncated one), the
// commitment absent across several consecutive such walks, and a minimum age. Keeping an entry too
// long costs nothing — an absent commitment is not being counted anyway, so the exclusion is a
// no-op — while forgetting one too early puts spent money back on the screen. The asymmetry is the
// same one reconcile.ts resolves on, pointed the same way.

import { getStoreKey } from './sessionKey'
import { open, seal } from './storeCrypto'
import type { TxVerdict } from './txResult'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Mirrors the two states of the reference wallet's OutputStatus that a client can observe. */
export type SpendStatus =
  /** Submitted, no verdict yet. Excluded — a coin on the wire must not be reselected. */
  | 'locked'
  /** The network accepted the transaction that consumed it. Excluded, permanently. */
  | 'spent'

export interface SpendRecord {
  status: SpendStatus
  /** The transaction that consumed it. The key promotion and release both resolve against. */
  txId: string
  /** When it was first locked. Feeds the retention floor below. */
  at: number
  /**
   * Consecutive COMPLETE scans in which `/utxos` did not list this commitment.
   *
   * Reset to zero the moment it is listed again. Only complete walks move it at all — a truncated
   * scan saw a subset, so its silence about a commitment is not evidence of anything.
   */
  absent: number
  /**
   * How many sweeps have looked this transaction up and been unable to resolve it.
   *
   * NOT a back-off counter — a sweep costs one GET per locked transaction and the normal case is
   * zero of them. It is the SAFETY NET's input: a lock that several sweeps in a row could not
   * settle is the shape of the failure that understated a wallet by 1110 tTARI in silence, and
   * `heldOutOfBalance` uses this (with age) to say so out loud instead.
   */
  attempts: number
}

export interface SpentOutputs {
  /** Substate id (`utxo_<resource>_<commitment>`) → what we know about spending it. */
  records: Record<string, SpendRecord>
  /**
   * First moment a write was lost. Same meaning as the journal's and the ledger's: a dropped write
   * here means a spend we cannot exclude, so it is recorded rather than swallowed.
   */
  degradedAt: number | null
}

/** What reconciliation needs from a scan. Taken whole so the completeness rule lives in here. */
export interface SpendObservation {
  /** The excluded substate ids that `/utxos` STILL listed on this walk. */
  presentIds: readonly string[]
  /** True when the walk hit utxoFeed's runaway guard — it saw a subset, so it proves nothing. */
  incomplete: boolean
}

const EMPTY: SpentOutputs = { records: {}, degradedAt: null }

/**
 * Consecutive complete scans a commitment must be absent from before it is forgotten.
 *
 * Three, not one, for the flapping indexer described in the header. Each complete walk is an
 * independent observation; three agreeing is cheap and makes a single bad listing harmless.
 */
export const ABSENT_SCANS_TO_FORGET = 3

/**
 * And it must be at least this old, however many scans agree.
 *
 * The scan count alone is satisfiable in seconds — the settle loop rescans every 8s — which would
 * put three observations well inside the indexer's own lag window, where a listing has not even
 * had time to be right. Thirty minutes is far past that and costs only a few bytes of storage.
 */
export const MIN_RETENTION_MS = 30 * 60_000

/**
 * When an unresolved lock stops being ordinary and starts being worth telling the user about.
 *
 * A lock is ordinary for as long as its transaction might still be deciding: the network settles
 * in 60-90s and crypto/finality waits up to 180s for it, so anything inside a couple of minutes is
 * simply a transaction in flight. Ten minutes is far outside that window — past it, the sweep has
 * asked the chain repeatedly and still cannot say, and the honest move is to report money held
 * back rather than quietly subtract it.
 */
export const UNRESOLVED_AFTER_MS = 10 * 60_000

/** …or this many sweeps have tried and failed, whichever comes first. */
export const UNRESOLVED_AFTER_ATTEMPTS = 3

// ── Storage ───────────────────────────────────────────────────────────────────
//
// Sealed at rest through storeCrypto, in the same tier as the journal and the first-seen ledger:
// which outputs this wallet spent, and when, is the clustering data that links its transactions to
// each other.
//
// IT FAILS CLOSED IN THE ONLY DIRECTION AVAILABLE, and that direction is not free. An unopenable
// record reads as EMPTY, so nothing is excluded — the balance over-counts and selection may pick a
// spent coin again, which is exactly the pre-fix behaviour. There is no fail-closed alternative: a
// record we cannot read cannot tell us what to exclude, and excluding everything would zero a
// working wallet. So the degradation is recorded and the wallet degrades to where it was, rather
// than to something worse.

function key(walletAddress: string) { return `caravel.utxospent.v1.${walletAddress}` }

/**
 * Degradations known to THIS SESSION, whether or not they reached disk.
 *
 * Identical reasoning to journalStore's and utxoLedger's: the write that records a failed write is
 * liable to fail for the same reason.
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

/** Narrow one stored record, dropping anything malformed rather than trusting it. */
function readRecord(v: unknown): SpendRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Partial<SpendRecord>
  if (r.status !== 'locked' && r.status !== 'spent') return null
  if (typeof r.txId !== 'string' || typeof r.at !== 'number') return null
  return {
    status: r.status,
    txId: r.txId,
    at: r.at,
    absent: typeof r.absent === 'number' ? r.absent : 0,
    // Records written before the sweep shipped carry no count. Zero is the truthful start.
    attempts: typeof r.attempts === 'number' ? r.attempts : 0,
  }
}

export function loadSpentOutputs(walletAddress: string): SpentOutputs {
  let stored: SpentOutputs = EMPTY
  let wasPlaintext = false
  try {
    const raw = localStorage.getItem(key(walletAddress))
    const opened = open(getStoreKey(), raw)
    if (opened.status === 'ok') {
      const parsed = JSON.parse(opened.json) as Partial<SpentOutputs>
      const records: Record<string, SpendRecord> = {}
      if (parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records)) {
        for (const [id, rec] of Object.entries(parsed.records)) {
          const read = readRecord(rec)
          if (read) records[id] = read
        }
      }
      stored = { records, degradedAt: typeof parsed.degradedAt === 'number' ? parsed.degradedAt : null }
      wasPlaintext = opened.legacy
    }
  } catch { stored = EMPTY; wasPlaintext = false }

  // Migrate a plaintext record on read, for utxoLedger's reason: this store is written only when
  // the wallet spends, so a wallet that is merely holding would otherwise keep its spend history
  // in plaintext indefinitely. Never on `unreadable`, never on an already-sealed record, and it
  // persists `stored` rather than the session-merged value below.
  if (wasPlaintext) save(walletAddress, stored)

  const session = sessionDegradations.get(walletAddress) ?? null
  if (stored.degradedAt === null && session !== null) return { ...stored, degradedAt: session }
  return stored
}

/** Returns false when the write did not land. Never clobbers a record we could not open. */
function save(walletAddress: string, next: SpentOutputs): boolean {
  const storeKey = getStoreKey()
  if (storeKey === null) return false
  if (readStatus(walletAddress) === 'unreadable') return false
  try {
    localStorage.setItem(key(walletAddress), seal(storeKey, JSON.stringify(next)))
    return true
  } catch { return false }
}

/** Record a lost write. In-session first, because that cannot fail; persisting is best-effort. */
function markDegraded(walletAddress: string, now: number): void {
  if (!sessionDegradations.has(walletAddress)) sessionDegradations.set(walletAddress, now)
  const current = loadSpentOutputs(walletAddress)
  if (current.degradedAt !== null) return
  save(walletAddress, { ...current, degradedAt: sessionDegradations.get(walletAddress)! })
}

// ── The lifecycle ─────────────────────────────────────────────────────────────

/**
 * Lock the inputs a transaction has just been submitted with.
 *
 * CALLED AT SUBMIT, NOT AT CONFIRMATION, and that ordering is the whole safety property. Between
 * submitting and hearing back there is a window — 30 seconds of polling, and far longer when the
 * poll times out and the settle loop takes over — in which the old code would happily select these
 * same outputs into a second transaction. The chain rejects the second one ("is down"), the user
 * pays its fee, and nothing explains why.
 *
 * ALREADY-SPENT RECORDS ARE NOT DOWNGRADED. If a commitment is somehow locked twice, the stronger
 * state wins: `spent` is a verdict and `locked` is a guess, and a guess must not overwrite a fact.
 */
export function markLocked(
  walletAddress: string,
  utxoIds: readonly string[],
  txId: string,
  now = Date.now(),
): { ok: boolean; locked: number } {
  const current = loadSpentOutputs(walletAddress)
  if (!walletAddress || utxoIds.length === 0) return { ok: true, locked: 0 }

  const records = { ...current.records }
  let locked = 0
  for (const id of utxoIds) {
    if (records[id]?.status === 'spent') continue
    records[id] = { status: 'locked', txId, at: now, absent: 0, attempts: 0 }
    locked++
  }
  if (locked === 0) return { ok: true, locked: 0 }

  const ok = save(walletAddress, { ...current, records })
  if (!ok) markDegraded(walletAddress, now)
  return { ok, locked }
}

/**
 * The network accepted it — the locks become facts.
 *
 * Keyed on the transaction rather than on the commitments, so the caller does not have to carry
 * the input list through its own state to resolve a verdict it already has.
 */
export function promoteToSpent(
  walletAddress: string,
  txId: string,
  now = Date.now(),
): { ok: boolean; promoted: number } {
  const current = loadSpentOutputs(walletAddress)
  const records = { ...current.records }
  let promoted = 0
  for (const [id, rec] of Object.entries(records)) {
    if (rec.txId !== txId || rec.status !== 'locked') continue
    records[id] = { ...rec, status: 'spent' }
    promoted++
  }
  if (promoted === 0) return { ok: true, promoted: 0 }

  const ok = save(walletAddress, { ...current, records })
  if (!ok) markDegraded(walletAddress, now)
  return { ok, promoted }
}

/**
 * The network rejected it — the coins were never spent, so give them back.
 *
 * ONLY RELEASES `locked` RECORDS. A `spent` record for this transaction would mean we had already
 * read an Accept for it, and a later Reject for the same id cannot be true; releasing on the
 * strength of it would put a genuinely spent coin back into the spendable set, which is the one
 * outcome worse than over-counting.
 *
 * A FEE-ONLY COMMIT IS A REJECT HERE. `AcceptFeeRejectRest` takes the fee and moves nothing, so
 * the inputs are untouched and must be released — see txResult.ts, whose verdict is what callers
 * pass this on.
 */
export function release(
  walletAddress: string,
  txId: string,
  now = Date.now(),
): { ok: boolean; released: number } {
  const current = loadSpentOutputs(walletAddress)
  const records = { ...current.records }
  let released = 0
  for (const [id, rec] of Object.entries(records)) {
    if (rec.txId !== txId || rec.status !== 'locked') continue
    delete records[id]
    released++
  }
  if (released === 0) return { ok: true, released: 0 }

  const ok = save(walletAddress, { ...current, records })
  if (!ok) markDegraded(walletAddress, now)
  return { ok, released }
}

// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * Everything to exclude, both states together.
 *
 * Pure, and the single definition of "excluded" — the balance scan and coin selection both read
 * it, so neither can develop its own opinion about which coins are still available.
 */
export function excludedIds(spent: SpentOutputs): Set<string> {
  return new Set(Object.keys(spent.records))
}

/** The same, loaded from storage. What the spend paths call. */
export function loadExcludedIds(walletAddress: string): Set<string> {
  if (!walletAddress) return new Set()
  return excludedIds(loadSpentOutputs(walletAddress))
}

/**
 * Transactions still holding locks.
 *
 * A TIMEOUT LEAVES ITS LOCKS IN PLACE — it means no decision was legible in time, not that the
 * transaction failed. That is the safe default, and it has a cost worth naming: a transaction
 * that was in fact REJECTED leaves its inputs excluded
 * until something resolves it, understating the balance. This exists so a later pass can re-read
 * those verdicts and call promoteToSpent/release; nothing does so yet.
 */
export function lockedTxIds(spent: SpentOutputs): string[] {
  return [...new Set(Object.values(spent.records).filter(r => r.status === 'locked').map(r => r.txId))]
}

// ── Resolving a lock against the chain ───────────────────────────────────────

/**
 * What a sweep should do about one locked transaction, given the chain's verdict.
 *
 * PURE, and separate from the fetching for the reason reconcile.ts is separate from the network:
 * this is the decision that moves money on and off a user's screen, so it is a function over a
 * value, testable without a chain.
 *
 * ── IT INVERTS txResult's RULE, DELIBERATELY ────────────────────────────────
 *
 * txResult classifies POSITIVELY — a transaction succeeded if and only if the result reads
 * `Accept`, and anything unrecognised is a failure — because for REPORTING to a user the cheap
 * error is a false alarm and the expensive one is telling somebody their money moved when it did
 * not.
 *
 * Here the asymmetry points the other way, so the rule has to as well. The two mistakes are:
 *
 *   release a coin that WAS spent   → it returns to coin selection, the next transaction spends a
 *                                     down input, and the chain rejects it after taking the fee.
 *                                     That is the exact failure Stage 1 exists to prevent.
 *   keep excluding a live coin      → the balance is understated until the next sweep resolves it,
 *                                     and the safety net says so out loud.
 *
 * The first costs money; the second costs a delay and an honest message. So anything the sweep
 * cannot read as a definite outcome — `unreadable`, or a result it could not fetch at all, which
 * arrives here as `null` — KEEPS the lock. Only a verdict that positively says the transaction
 * failed releases it.
 */
export type LockAction = 'promote' | 'release' | 'keep'

export function resolveLockAction(verdict: TxVerdict | null): LockAction {
  // No answer yet, or no answer we could obtain. Genuinely pending and unreachable are the same
  // instruction: wait, and try again next sweep.
  if (verdict === null) return 'keep'
  switch (verdict.kind) {
    // The coins ARE spent. The change this transaction created is a different commitment, which
    // nothing excludes, so the scan picks it up as an ordinary owned row.
    case 'accept': return 'promote'
    // Nothing was consumed. `fee-only` belongs here and not with `accept`: AcceptFeeRejectRest
    // takes the fee and rejects the body, so the inputs are untouched and must come back.
    case 'reject':
    case 'fee-only': return 'release'
    // Decided, in terms this code cannot read. Keep excluding — see the asymmetry above.
    case 'unreadable': return 'keep'
  }
}

/** Record that a sweep looked and could not resolve. Feeds the safety net, not a back-off. */
export function recordSweepAttempt(
  walletAddress: string,
  txId: string,
  now = Date.now(),
): { ok: boolean; counted: number } {
  const current = loadSpentOutputs(walletAddress)
  const records = { ...current.records }
  let counted = 0
  for (const [id, rec] of Object.entries(records)) {
    if (rec.txId !== txId || rec.status !== 'locked') continue
    records[id] = { ...rec, attempts: rec.attempts + 1 }
    counted++
  }
  if (counted === 0) return { ok: true, counted: 0 }
  const ok = save(walletAddress, { ...current, records })
  if (!ok) markDegraded(walletAddress, now)
  return { ok, counted }
}

// ── The safety net ────────────────────────────────────────────────────────────

/** One excluded coin the indexer is still listing, with what it is worth. */
export interface ExcludedValue {
  id: string
  microtari: bigint
}

/** A transaction whose lock has outlived every reasonable explanation. */
export interface UnresolvedLock {
  txId: string
  /** How long it has been locked, in ms. */
  ageMs: number
  attempts: number
  /** What this transaction is holding back, of the coins the indexer is still listing. */
  microtari: bigint
}

export interface HeldSummary {
  /**
   * Total µtTARI held out of the displayed balance right now.
   *
   * THE COINS THE LISTING STILL SHOWS, and only those. Excluding a commitment the indexer has
   * already dropped changes no number — the scan never sees it — so counting it here would invent
   * a shortfall that is not on anybody's screen.
   */
  totalMicrotari: bigint
  /** How many such coins. */
  count: number
  /** The subset that is no longer explainable as a transaction in flight. */
  unresolved: UnresolvedLock[]
}

/**
 * What the exclusion set is currently costing the displayed balance, and how much of that is a
 * problem rather than a transaction in flight.
 *
 * PURE. It takes the scan's own measurement of which excluded coins were still listed — see
 * walletScanner's `excludedPresent` — because that, and not the store, is what decides whether an
 * exclusion is subtracting anything.
 *
 * `unresolved` is the line a UI should show. Everything else is a wallet working normally: a spend
 * in flight holds its inputs back for a minute, which is correct and needs no explanation.
 */
export function heldOutOfBalance(
  spent: SpentOutputs,
  excludedPresent: readonly ExcludedValue[],
  now = Date.now(),
): HeldSummary {
  let totalMicrotari = 0n
  const byTx = new Map<string, { ageMs: number; attempts: number; microtari: bigint }>()

  for (const e of excludedPresent) {
    const rec = spent.records[e.id]
    totalMicrotari += e.microtari
    // A `spent` record is a settled fact, not something to chase — it is excluded because the
    // transaction was accepted, and the listing simply has not caught up.
    if (!rec || rec.status !== 'locked') continue
    const ageMs = Math.max(0, now - rec.at)
    if (ageMs < UNRESOLVED_AFTER_MS && rec.attempts < UNRESOLVED_AFTER_ATTEMPTS) continue
    const prev = byTx.get(rec.txId)
    byTx.set(rec.txId, {
      ageMs: Math.max(ageMs, prev?.ageMs ?? 0),
      attempts: Math.max(rec.attempts, prev?.attempts ?? 0),
      microtari: (prev?.microtari ?? 0n) + e.microtari,
    })
  }

  return {
    totalMicrotari,
    count: excludedPresent.length,
    unresolved: [...byTx.entries()].map(([txId, v]) => ({ txId, ...v })),
  }
}

// ── Reconciliation ────────────────────────────────────────────────────────────

/**
 * Let the indexer catch up, carefully.
 *
 * Once `/utxos` genuinely stops listing a commitment, our record of it is redundant. Forgetting it
 * keeps the store from growing without bound across the life of a wallet.
 *
 * WHAT IT REFUSES TO CONCLUDE, and why each refusal is there:
 *
 *   A TRUNCATED SCAN moves nothing at all — not the counters, not the records. It saw a subset, so
 *   its silence about a commitment carries no information. (Note the absence counter is not reset
 *   either: an incomplete walk is not evidence in either direction.)
 *
 *   ONE COMPLETE SCAN IS NOT ENOUGH. See the header — a live output went missing from one of the
 *   two indexers while being live on both, so a single listing is not a reliable witness.
 *
 *   NOR IS AGE ALONE, nor scans alone: both must be satisfied.
 *
 * Forgetting an ABSENT commitment cannot change the balance at that moment — it is not in the
 * listing, so it was not being counted. The only thing the window protects against is the listing
 * bringing it back afterwards.
 */
export function reconcileSpentOutputs(
  walletAddress: string,
  observation: SpendObservation,
  now = Date.now(),
): { ok: boolean; forgotten: number; skipped: 'incomplete' | null } {
  const current = loadSpentOutputs(walletAddress)
  if (observation.incomplete) return { ok: true, forgotten: 0, skipped: 'incomplete' }

  const present = new Set(observation.presentIds)
  const records: Record<string, SpendRecord> = {}
  let forgotten = 0
  let changed = false

  for (const [id, rec] of Object.entries(current.records)) {
    // ── ONLY `spent` ENTRIES ARE GARBAGE-COLLECTED ──────────────────────────
    //
    // This used to iterate every record, which gave a `locked` entry two exits: the sweep, and
    // simply being absent from the listing for long enough. The second one is unsound. A lock is
    // held precisely because we do not yet know the transaction's fate, so forgetting it on the
    // strength of a listing — the listing that was measured dropping 79 live outputs — could make
    // a coin selectable again while its first transaction was still in flight, which is a
    // self-double-spend.
    //
    // With this guard, reconcile is the garbage collection of RESOLVED facts and the sweep is the
    // only way a lock can ever leave. That is what makes "a lock is temporary" true by
    // construction rather than by timing.
    if (rec.status !== 'spent') {
      records[id] = rec
      continue
    }
    if (present.has(id)) {
      // Still listed. The clock restarts — consecutive means consecutive.
      if (rec.absent !== 0) changed = true
      records[id] = rec.absent === 0 ? rec : { ...rec, absent: 0 }
      continue
    }
    const absent = rec.absent + 1
    if (absent >= ABSENT_SCANS_TO_FORGET && now - rec.at >= MIN_RETENTION_MS) {
      forgotten++
      changed = true
      continue
    }
    records[id] = { ...rec, absent }
    changed = true
  }

  if (!changed) return { ok: true, forgotten: 0, skipped: null }

  const ok = save(walletAddress, { ...current, records })
  if (!ok) markDegraded(walletAddress, now)
  return { ok, forgotten, skipped: null }
}

/**
 * The coins one transaction is still holding locked, with when each lock was taken.
 *
 * For the sweep's fallback: when a transaction's RESULT can no longer be fetched, the only thing
 * left to ask the chain about is the coins themselves. See crypto/lockSweep.
 */
export function lockedCoinsFor(spent: SpentOutputs, txId: string): { id: string; at: number }[] {
  return Object.entries(spent.records)
    .filter(([, r]) => r.status === 'locked' && r.txId === txId)
    .map(([id, r]) => ({ id, at: r.at }))
}

/** Test seam only — clears the in-session degradation record. Never called by the app. */
export function __resetSpentSessionForTests(): void {
  sessionDegradations.clear()
}
