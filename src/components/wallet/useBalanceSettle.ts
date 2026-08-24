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
  /** The balance captured BEFORE the transaction, so a rise can be detected. */
  before: bigint
  /** Absolute epoch-ms cutoff, after which we stop waiting and report the lag. */
  deadlineAt: number
  /** Trigger a fresh scan. */
  rescan: () => void
  /** The balance rose. Receives the delta. */
  onRose: (delta: bigint) => void
  /** The deadline passed without movement. The transaction is still fine. */
  onDeadline: () => void
  /** How often to rescan while waiting. */
  pollMs?: number
}

/** What the settle loop should do at a given moment. */
export type SettleAction = 'rose' | 'deadline' | 'wait'

/**
 * The loop's decision, as a pure function — so the rules can be tested without a renderer.
 *
 * ORDER MATTERS: a rise wins over an expired deadline. A transaction whose output appears in the
 * same instant the deadline passes has succeeded and must be reported as such, not as a lag.
 *
 * `null` balance is "not known yet" — a scan in flight, or one that failed — and never counts as
 * movement. Treating unknown as zero would let a failed scan read as a balance that never rose.
 */
export function settleAction(balance: bigint | null, before: bigint, now: number, deadlineAt: number): SettleAction {
  if (balance !== null && balance > before) return 'rose'
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
  onRose,
  onDeadline,
  pollMs = 8_000,
}: BalanceSettleOptions): void {
  const rescanRef = useRef(rescan)
  const roseRef = useRef(onRose)
  const deadlineRef = useRef(onDeadline)
  rescanRef.current = rescan
  roseRef.current = onRose
  deadlineRef.current = onDeadline

  useEffect(() => {
    if (!active) return

    // Movement is checked on every render, not only on a tick: the scan that finds the output may
    // land between ticks, and waiting up to a full interval to notice would be needless delay.
    if (settleAction(balance, before, Date.now(), deadlineAt) === 'rose') {
      roseRef.current(balance! - before)
      return
    }

    const iv = setInterval(() => {
      switch (settleAction(balance, before, Date.now(), deadlineAt)) {
        case 'rose': roseRef.current(balance! - before); break
        case 'deadline': deadlineRef.current(); break
        default: rescanRef.current()
      }
    }, pollMs)
    return () => clearInterval(iv)
  }, [active, balance, before, deadlineAt, pollMs])
}
