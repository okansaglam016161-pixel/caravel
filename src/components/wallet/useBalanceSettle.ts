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
  /** The balance captured BEFORE the transaction, so a rise can be detected. */
  before: bigint
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
 */
export function settleAction(
  balance: bigint | null,
  before: bigint,
  now: number,
  deadlineAt: number,
  direction: 'rise' | 'fall' = 'rise',
): SettleAction {
  if (balance !== null && (direction === 'rise' ? balance > before : balance < before)) return 'settled'
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

  useEffect(() => {
    if (!active) return

    // Movement is checked on every render, not only on a tick: the scan that finds the output may
    // land between ticks, and waiting up to a full interval to notice would be needless delay.
    // The absolute delta, so a caller never has to know which way it was watching.
    const delta = () => (balance! > before ? balance! - before : before - balance!)

    if (settleAction(balance, before, Date.now(), deadlineAt, direction) === 'settled') {
      settledRef.current(delta())
      return
    }

    const iv = setInterval(() => {
      switch (settleAction(balance, before, Date.now(), deadlineAt, direction)) {
        case 'settled': settledRef.current(delta()); break
        case 'deadline': deadlineRef.current(); break
        default: rescanRef.current()
      }
    }, pollMs)
    return () => clearInterval(iv)
  }, [active, balance, before, deadlineAt, pollMs, direction])
}
