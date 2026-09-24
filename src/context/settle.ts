// Waiting for a committed transaction to show up in the balances.
//
// ── WHY THIS IS NEEDED AT ALL ────────────────────────────────────────────────
//
// A transaction committing on-chain and its effect appearing in the wallet are two different
// events, 60–90 seconds apart: the indexer's /utxos listing — the only thing the stealth scan can
// read — trails consensus. A single rescan() fired on commit therefore scans a listing that does
// not contain the change yet, reports the old balance, and stops. The user is told the transaction
// succeeded and shown a number that says it did not.
//
// A TIMEOUT HERE IS NOT A FAILURE. The transaction is already committed; only the index is behind.
// The deadline branch says so and offers a refresh, never an error — telling someone their funds
// did not move when they demonstrably did is the worst outcome available.
//
// ── WHY THIS LIVES IN CONTEXT AND NOT IN THE MODAL ───────────────────────────
//
// It used to be a hook called from WalletModal and FaucetClaimPanel, with the baselines and the
// deadline in `useRef`s and the loop's `active` flag derived from a view's own step. Two bugs came
// straight out of that:
//
//   * Pressing Done mid-settle set the step to 'idle', which switched the loop off. The overview it
//     returned to kept whatever the last scan produced — stale, with nothing polling to correct it,
//     until the user pressed Refresh by hand.
//   * Closing the modal was worse. `{walletOpen && <WalletModal/>}` is a real unmount, so the loop
//     AND its refs died together; reopening could not resume, because the baseline it would have
//     compared against no longer existed.
//
// A committed transaction is not a property of a screen. It is wallet state — it stays true while
// the user browses tabs, closes the modal, or does nothing at all — so it belongs beside `scan` and
// `revealed`, next to the `rescan` that resolves it.
//
// ── ONE LOOP, MANY SETTLES ───────────────────────────────────────────────────
//
// The hook version could have three loops alive at once (move, send, faucet), each firing the
// global rescan() on its own timer, so scans overlapped and invalidated one another while the
// loops watched the balances they were thrashing. That needed a lease to arbitrate. Holding the
// entries in one list polled by one interval removes the problem rather than managing it: N
// settles, one cadence, one rescan per tick.
//
// This file is the RULES. It is pure — no React, no timers, no network — so the decisions that
// tell a user whether their money moved can be tested directly.

/** Which balance a watch is looking at. */
export type SettleSide = 'private' | 'public'

/** Which way it is expected to move. */
export type SettleDirection = 'rise' | 'fall'

/** The two balances, as the context knows them. `null` is "not known yet", never zero. */
export interface SideBalances {
  private: bigint | null
  public: bigint | null
}

/**
 * Everything a settle is judged against.
 *
 * ── WHY THE BALANCES ALONE WERE NOT ENOUGH ──────────────────────────────────
 *
 * A settle used to complete when a balance moved in the right DIRECTION. That was always a proxy,
 * and the spend record turned it into a broken one. A send now excludes its inputs the instant it
 * is submitted, so the private balance falls immediately — and falls TOO FAR, because the change
 * output it creates is a new commitment the indexer will not list for another sixty to ninety
 * seconds. "Did it fall?" answers yes at exactly the moment the figure is most wrong, the settle
 * ends, and the total certifies a number that is short by the change. Measured: a send of 50
 * showed 741 against a true 750, and stayed there until the user pressed Refresh.
 *
 * `ownedIds` is what replaces the proxy. The wallet knows, BEFORE it submits, the substate id of
 * every output a transaction will create for it — read from the outputs statement by
 * crypto/outputIds and recorded on the journal entry. So the question stops being "did the number
 * move the way I expected" and becomes "are my new outputs on chain yet", which is the thing that
 * was actually being waited for all along.
 */
export interface SettleEvidence {
  balances: SideBalances
  /** Substate ids of every UTXO the current scan shows this wallet owning. */
  ownedIds: ReadonlySet<string>
  /**
   * False while a scan is running or was truncated.
   *
   * ABSENCE ONLY PROVES SOMETHING IN A COMPLETE SCAN. A partial owned set is missing outputs it
   * never looked at, so concluding "my change has not arrived" from one would keep a landed
   * transaction waiting out its whole deadline.
   */
  scanComplete: boolean
}

/**
 * One balance this transaction is expected to move.
 *
 * `before` is the reading captured at commit. `null` means the baseline was NOT KNOWN at that
 * moment — the read was in flight or had failed. It is deliberately not a number: encoding unknown
 * as zero breaks both directions, in opposite and equally wrong ways. On a RISE watch, zero is
 * below any real balance, so the very next poll reports a success the transaction has not achieved.
 * On a FALL watch, nothing is below zero, so it can never settle and always runs to the deadline.
 * With a null baseline the loop waits and then reports the lag honestly.
 */
export interface SettleWatch {
  side: SettleSide
  direction: SettleDirection
  before: bigint | null
}

export type SettleStatus = 'settling' | 'settled' | 'lagged'

/**
 * A committed transaction whose effect has not been observed yet.
 *
 * `lagged` is a SUCCESS, not a failure — the deadline passed without the index catching up. The
 * distinction exists only so the copy can mention the delay.
 */
export interface PendingSettle {
  /**
   * Substate ids of the outputs this transaction creates FOR US — the evidence it has landed.
   *
   *   [...]  wait until every one of them appears in the owned set. The honest completion test.
   *   []     this transaction provably creates no output for us — an exact-cover spend, a public
   *          send. Nothing to wait for, so the private side is done immediately.
   *   null   they could not be read from the outputs statement. A hole: there is no evidence to
   *          wait for, so the private side falls back to its direction watch, which is the old
   *          behaviour and the best that can be done without knowing what to look for.
   */
  expectOutputs: string[] | null
  /** The on-chain transaction id. Also the identity: consumers match their own tx against it. */
  txId: string
  kind: 'move' | 'send' | 'faucet'
  watches: SettleWatch[]
  /** Absolute epoch-ms cutoff, after which we stop waiting and report the lag. */
  deadlineAt: number
  status: SettleStatus
  /**
   * How far the FIRST watch moved, once settled. Absolute, so a caller never has to know which
   * direction it was watching. `null` until settled, and on the lagged branch — where nothing was
   * observed, so there is no delta to report.
   */
  delta: bigint | null
}

export type SettleAction = 'settled' | 'deadline' | 'wait'

/** The current reading for a watch's side. */
export function balanceFor(side: SettleSide, balances: SideBalances): bigint | null {
  return side === 'private' ? balances.private : balances.public
}

/**
 * Has ONE balance moved the way it was supposed to?
 *
 * ORDER MATTERS: movement wins over an expired deadline. A transaction whose effect appears in the
 * same instant the deadline passes has succeeded and must be reported as such, not as a lag.
 *
 * A `null` balance is "not known yet" — a scan in flight, or one that failed — and never counts as
 * movement. Treating unknown as zero would let a failed scan read as a balance that never moved,
 * and on a 'fall' watch it would be worse: zero is BELOW any positive `before`, so an unknown
 * balance would look exactly like a completed spend.
 */
export function settleAction(
  balance: bigint | null,
  before: bigint | null,
  now: number,
  deadlineAt: number,
  direction: SettleDirection = 'rise',
): SettleAction {
  if (balance !== null && before !== null && (direction === 'rise' ? balance > before : balance < before)) return 'settled'
  if (now > deadlineAt) return 'deadline'
  return 'wait'
}

/**
 * Have this transaction's own outputs shown up?
 *
 * `null` means the question cannot be asked — the ids were never readable — and the caller falls
 * back to the direction watch. `false` is a real "not yet", and is also what a running or
 * truncated scan produces, because absence from a partial set proves nothing.
 *
 * ROBUST TO A CONCURRENT RECEIVE, which is the whole reason this is a set of specific commitments
 * rather than an arithmetic check on the total. Somebody paying this wallet mid-send moves the
 * balance by an unrelated amount and would defeat any delta match; it cannot conjure the exact
 * commitment this transaction is waiting for.
 */
export function outputsAppeared(entry: PendingSettle, evidence: SettleEvidence): boolean | null {
  if (entry.expectOutputs === null) return null
  if (entry.expectOutputs.length === 0) return true
  if (!evidence.scanComplete) return false
  return entry.expectOutputs.every(id => evidence.ownedIds.has(id))
}

/** Is one side of the wallet consistent with this transaction yet? */
function sideSettled(
  entry: PendingSettle,
  side: SettleSide,
  evidence: SettleEvidence,
  now: number,
): boolean {
  // THE PRIVATE SIDE IS WHERE THE EVIDENCE LIVES. Every id in `expectOutputs` is a stealth output,
  // so when they have all appeared the private figure already includes them — whatever the number
  // did on the way there. The direction watch is not consulted at all in that case, deliberately:
  // it is the thing that was firing early.
  if (side === 'private') {
    const appeared = outputsAppeared(entry, evidence)
    if (appeared !== null) return appeared
  }

  // The public side, and the private side when there is no evidence to go on. Unchanged: a keyed
  // vault read is consensus-fresh, so a direction is a fair test of it.
  const watches = entry.watches.filter(w => w.side === side)
  if (watches.length === 0) return true
  return watches.every(w =>
    settleAction(balanceFor(side, evidence.balances), w.before, now, Number.POSITIVE_INFINITY, w.direction) === 'settled')
}

/**
 * Has the WHOLE transaction landed?
 *
 * EVERY watch must have moved. A move changes both balances, and they do not arrive together: the
 * public side is two keyed substate lookups and is consensus-fresh, while the private side is a
 * global /utxos listing that trails by a minute. Settling on whichever arrives first declares the
 * transaction done at the moment the two readings are most inconsistent — which is exactly how a
 * reveal came to display a total that double-counted the amount on both sides.
 *
 * The deadline still wins over waiting, and movement still wins over the deadline, so a partially
 * observed transaction reports the lag rather than an error.
 *
 * An empty watch list can never settle; it waits out the deadline. That is deliberate — a settle
 * with nothing to watch is a programming error, and the safe reading of it is "we cannot confirm",
 * not "confirmed".
 */
export function settleAllAction(
  entry: PendingSettle,
  evidence: SettleEvidence,
  now: number,
  deadlineAt: number,
): SettleAction {
  // Nothing to judge against at all — no watches AND no readable outputs — can never settle, and
  // waits out its deadline. Same rule as before: a settle with nothing to observe is a programming
  // error, and the safe reading of it is "we cannot confirm", not "confirmed".
  const observable = entry.watches.length > 0 || entry.expectOutputs !== null
  if (observable && sideSettled(entry, 'private', evidence, now) && sideSettled(entry, 'public', evidence, now)) {
    return 'settled'
  }
  if (now > deadlineAt) return 'deadline'
  return 'wait'
}

/**
 * How far a watch's balance moved, as a positive number.
 *
 * Only meaningful once that watch has settled; `null` whenever either end is unknown, so a caller
 * cannot accidentally render a delta computed from a missing reading.
 */
export function watchDelta(watch: SettleWatch | undefined, balances: SideBalances): bigint | null {
  // A settle may legitimately carry no watches now that evidence can stand alone, so there may be
  // nothing to measure. `null` is already this function's "no reading", so it needs no new case.
  if (!watch) return null
  const now = balanceFor(watch.side, balances)
  if (now === null || watch.before === null) return null
  return now > watch.before ? now - watch.before : watch.before - now
}

/**
 * Have ALL of this entry's watches moved, deadline aside?
 *
 * This is the question "are the balances consistent with this transaction yet", asked without any
 * reference to how long we have been waiting. A settle's STATUS says what we told the user; this
 * says what the data currently supports, and the total cares about the second one.
 *
 * It is what lets a LAGGED entry release the total on its own: `settling` versus `lagged` is a
 * presentation distinction, and for the purpose of adding two balances they mean the same thing —
 * something of ours is missing from the figures. Once this turns true, it no longer is.
 */
export function isAccountedFor(entry: PendingSettle, evidence: SettleEvidence): boolean {
  return settleAllAction(entry, evidence, 0, Number.POSITIVE_INFINITY) === 'settled'
}

/**
 * Move one entry forward against the current balances. Pure: returns a new entry, or the SAME
 * object when nothing changed, so callers can skip a state update without comparing fields.
 *
 * A SETTLED entry is never re-opened. Once a transaction has been observed to land, a later scan
 * that happens to read lower — a truncated listing, a competing spend — must not walk it back and
 * start polling again.
 *
 * A LAGGED one is different, and is completed rather than re-opened. Lagged means "committed, and
 * we could not confirm it in the time we allowed" — an admission, not a verdict. When a later read
 * finally shows the balances moved, that admission is answered, and the entry becomes settled like
 * any other. This is what releases the total after a deadline: a Refresh resolves it, without the
 * user having to know that is what they are fixing.
 */
export function advanceSettle(entry: PendingSettle, evidence: SettleEvidence, now: number): PendingSettle {
  if (entry.status === 'settled') return entry
  if (entry.status === 'lagged') {
    return isAccountedFor(entry, evidence)
      ? { ...entry, status: 'settled', delta: watchDelta(entry.watches[0], evidence.balances) }
      : entry
  }
  switch (settleAllAction(entry, evidence, now, entry.deadlineAt)) {
    case 'settled':
      return { ...entry, status: 'settled', delta: watchDelta(entry.watches[0], evidence.balances) }
    case 'deadline':
      // NOT an error. The transaction committed; only the index is behind. No delta, because
      // nothing was observed to move — reporting one would be inventing a measurement.
      return { ...entry, status: 'lagged', delta: null }
    default:
      return entry
  }
}

/** Advance every entry. Returns the SAME array when nothing changed. */
export function advanceAll(entries: PendingSettle[], evidence: SettleEvidence, now: number): PendingSettle[] {
  let changed = false
  const next = entries.map(e => {
    const advanced = advanceSettle(e, evidence, now)
    if (advanced !== e) changed = true
    return advanced
  })
  return changed ? next : entries
}

/** Is anything still waiting? The poll runs only while this is true. */
export function anySettling(entries: PendingSettle[]): boolean {
  return entries.some(e => e.status === 'settling')
}

/**
 * Add an entry, replacing any entry for the same transaction.
 *
 * Replacing rather than appending matters on a retry: the same txId submitted twice must not leave
 * a stale first attempt polling forever against a baseline that no longer means anything.
 */
export function withSettle(entries: PendingSettle[], entry: PendingSettle): PendingSettle[] {
  return [...entries.filter(e => e.txId !== entry.txId), entry]
}

/**
 * Drop an entry the user has seen the outcome of.
 *
 * ONLY A SETTLED ONE. Two different things are being kept alive here, for two reasons:
 *
 *   * A STILL-SETTLING entry is the Done-mid-settle fix: the screen that started the transaction is
 *     finished with it, the transaction is not, and the overview the user lands on needs the poll
 *     to keep running so it can correct itself.
 *
 *   * A LAGGED entry is the deadline case, and dropping it would be worse than never having
 *     tracked it. The balances are still inconsistent — that is what lagged MEANS — so removing
 *     the only record of that would let the total go straight to a confident sum of a stale figure
 *     and a fresh one. Dismissing a message must not change what the wallet claims to know. It
 *     clears on its own the moment a read shows the balances caught up.
 */
export function acknowledged(entries: PendingSettle[], txId: string): PendingSettle[] {
  return entries.filter(e => !(e.txId === txId && e.status === 'settled'))
}
