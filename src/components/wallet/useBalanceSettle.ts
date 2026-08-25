import { useEffect, useRef } from 'react'

// Waiting for a committed transaction to show up in the balance.
//
// WHY THIS IS NEEDED AT ALL. A transaction committing on-chain and its effect appearing in the
// wallet are two different events, 60–90 seconds apart: the indexer's /utxos listing — the only
// thing the stealth scan can read — lags well behind consensus. A single rescan() fired on commit
// therefore scans a listing that does not contain the new output yet, reports the old balance, and
// stops. The user is told the transaction succeeded and shown a number that says it did not.
//
// The faucet claim has always handled this with a poll-until-it-moves loop. Conceal shipped without
// one and reproduced the bug exactly: a successful conversion that displayed as nothing happening.
// This is that loop, lifted out so the two paths cannot drift — and so the next write path gets it
// for free rather than rediscovering the lag the hard way.
//
// A TIMEOUT HERE IS NOT A FAILURE. The transaction is already committed; only the index is behind.
// `onDeadline` should say so and offer a refresh, never report an error — telling someone their
// funds did not move when they demonstrably did is the worst outcome available.

export interface BalanceSettleOptions {
  /** Poll only while this is true — typically a 'settling' / 'verifying' phase. */
  active: boolean
  /** The balance being watched. `null` means "not known yet" and never counts as movement. */
  balance: bigint | null
  /**
   * Which way the watched balance is expected to move.
   *
   * A conceal, a reveal and a faucet claim all make a balance RISE, and that was the only case
   * until sends needed settling. A SEND has no rise to watch — the money leaves — so the only local
   * evidence it landed is the spent-from balance FALLING. Same loop, same deadline, opposite
   * comparison.
   *
   * Defaults to 'rise', so every existing caller is unchanged.
   */
  direction?: 'rise' | 'fall'
  /**
   * The balance captured BEFORE the transaction, so movement can be detected.
   *
   * `null` means the baseline was NOT KNOWN when the transaction committed — the read was in
   * flight or had failed. It is deliberately not a number: encoding unknown as zero breaks both
   * directions, in opposite and equally wrong ways. On a RISE watch, zero is below any real
   * balance, so the very next poll reports success the transaction has not achieved yet. On a FALL
   * watch, nothing is below zero, so it can never settle and always runs to the deadline. Same
   * zero-versus-unavailable discipline as the balance reads themselves.
   *
   * With a null baseline the loop waits and then reports the lag honestly — the transaction
   * committed, and we simply could not verify the effect locally.
   */
  before: bigint | null
  /** Absolute epoch-ms cutoff, after which we stop waiting and report the lag. */
  deadlineAt: number
  /** Trigger a fresh scan. */
  rescan: () => void
  /** The balance moved in the watched direction. Receives the ABSOLUTE delta, always positive. */
  onSettled: (delta: bigint) => void
  /** The deadline passed without movement. The transaction is still fine. */
  onDeadline: () => void
  /** How often to rescan while waiting. */
  pollMs?: number
}

// ── ONE DRIVER AT A TIME (M9 F7) ─────────────────────────────────────────────
//
// More than one of these loops can be alive at once, and it is not a rare shape: settling runs for
// up to 150 seconds, tabs stay mounted, so switching to Move mid-send-settle and starting a move
// leaves two loops polling. The faucet's claim makes three.
//
// Nothing is CORRUPTED by that — each loop watches its own balance in its own direction and reaches
// its own verdict. What goes wrong is the polling: `rescan()` is global, restarts the whole stealth
// scan, and N loops fire it on N independent 8-second timers. The scans overlap, each one's result
// invalidates the last, and the balances the loops are watching thrash while they watch them.
//
// So rescans are LEASED. The first active loop takes the lease and drives; the others still tick,
// still evaluate `settleAction` on every render and every tick, and still reach 'settled' or
// 'deadline' exactly when they otherwise would — they simply do not start a second scan, because
// the driver's scan already refreshes the balance they are reading. The lease is released on
// cleanup, so when the driver finishes, the next loop picks it up on its following tick.
//
// Module-level rather than a context: the callers are in three different component trees and a
// future fourth should get this without being wired for it.
//
// Exposed as a tiny object rather than a bare `let` so the rule can be TESTED without a renderer —
// the same reason settleAction is a pure function. There is no jsdom here, and an invariant that
// only holds inside an effect is an invariant nobody checks.
export const rescanLease = (() => {
  let holder: symbol | null = null
  return {
    /** Take the lease if it is free. Returns whether `id` holds it afterwards. */
    claim(id: symbol): boolean {
      if (holder === null) holder = id
      return holder === id
    },
    /** Give it back — but only if `id` is the one holding it. A loop must never free another's. */
    release(id: symbol): void {
      if (holder === id) holder = null
    },
    holds(id: symbol): boolean { return holder === id },
    /** Test-only: is anyone driving? */
    free(): boolean { return holder === null },
  }
})()

/** What the settle loop should do at a given moment. */
export type SettleAction = 'settled' | 'deadline' | 'wait'

/**
 * The loop's decision, as a pure function — so the rules can be tested without a renderer.
 *
 * ORDER MATTERS: movement wins over an expired deadline. A transaction whose effect appears in the
 * same instant the deadline passes has succeeded and must be reported as such, not as a lag.
 *
 * `null` balance is "not known yet" — a scan in flight, or one that failed — and never counts as
 * movement. Treating unknown as zero would let a failed scan read as a balance that never moved,
 * and on a 'fall' watch it would be worse still: zero is BELOW any positive `before`, so an
 * unknown balance would look exactly like a completed spend.
 *
 * `null` BEFORE is the same idea from the other side: no baseline, so no comparison is possible and
 * nothing can be claimed. The loop waits out the deadline and reports the lag rather than inventing
 * a verdict from a number nobody measured.
 */
export function settleAction(
  balance: bigint | null,
  before: bigint | null,
  now: number,
  deadlineAt: number,
  direction: 'rise' | 'fall' = 'rise',
): SettleAction {
  if (balance !== null && before !== null && (direction === 'rise' ? balance > before : balance < before)) return 'settled'
  if (now > deadlineAt) return 'deadline'
  return 'wait'
}

/**
 * Poll a balance until it rises, or the deadline passes.
 *
 * Callbacks are held in refs rather than listed as effect dependencies. That is not tidiness: an
 * inline arrow would be a new value on every render, the effect would tear down and re-create its
 * interval each time, and with frequent re-renders the timer could be reset forever without ever
 * firing — a poll loop that silently never polls.
 */
export function useBalanceSettle({
  active,
  balance,
  before,
  deadlineAt,
  rescan,
  onSettled,
  onDeadline,
  direction = 'rise',
  pollMs = 8_000,
}: BalanceSettleOptions): void {
  const rescanRef = useRef(rescan)
  const settledRef = useRef(onSettled)
  const deadlineRef = useRef(onDeadline)
  rescanRef.current = rescan
  settledRef.current = onSettled
  deadlineRef.current = onDeadline

  // Identity for the rescan lease — stable for this hook instance, never compared by value.
  const leaseId = useRef<symbol>(Symbol('settle'))

  useEffect(() => {
    if (!active) return

    // Claim the lease if it is free. A loop that does not hold it still polls its own condition;
    // it just does not start a competing scan. See rescanLease above.
    rescanLease.claim(leaseId.current)

    // Movement is checked on every render, not only on a tick: the scan that finds the output may
    // land between ticks, and waiting up to a full interval to notice would be needless delay.
    // The absolute delta, so a caller never has to know which way it was watching. Only ever
    // called on the 'settled' branch, where both values are known.
    const delta = () => (balance! > before! ? balance! - before! : before! - balance!)

    if (settleAction(balance, before, Date.now(), deadlineAt, direction) === 'settled') {
      settledRef.current(delta())
      // Settled without ever starting an interval — hand the lease straight back, or a loop that
      // finished on its first render would hold it for the lifetime of the tab.
      return () => rescanLease.release(leaseId.current)
    }

    const iv = setInterval(() => {
      switch (settleAction(balance, before, Date.now(), deadlineAt, direction)) {
        case 'settled': settledRef.current(delta()); break
        case 'deadline': deadlineRef.current(); break
        // Only the lease-holder scans. Everyone else reads the balance its scan produces, which is
        // the same balance they would have asked for.
        default: if (rescanLease.holds(leaseId.current)) rescanRef.current()
      }
    }, pollMs)
    return () => {
      clearInterval(iv)
      rescanLease.release(leaseId.current)
    }
  }, [active, balance, before, deadlineAt, pollMs, direction])
}
