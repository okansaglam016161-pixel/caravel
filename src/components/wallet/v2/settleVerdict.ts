//   What a finished settle watch actually proved — and what it did not.
//
//   ── THE BUG THIS EXISTS TO PREVENT ───────────────────────────────────────────
//
//   A settle watch used to be started only when the builder returned `Commit`, so every watch that
//   ever finished began from a network receipt saying the transaction had committed. Under that
//   premise a passed deadline is still a success: the money moved, the indexer is merely behind.
//   Both settle effects encoded exactly that, and correctly.
//
//   Starting a watch on `Timeout` breaks the premise. A Timeout means the builder's own poll gave
//   up — roughly 30s against a documented 60–90s indexer lag — so it is not a verdict at all, only
//   the absence of one. Most such sends do land, which is the whole reason to watch them. But a
//   Timeout watch that ALSO reaches its deadline has observed nothing twice: no receipt, and no
//   balance movement. The one thing it must never do is inherit the Commit branch's meaning and
//   report "Sent".
//
//   So the two inputs are not interchangeable, and the verdict is a fork over both:
//
//                    │ settled (the balance moved)  │ lagged (deadline passed)
//     ───────────────┼──────────────────────────────┼──────────────────────────
//      from Commit   │ confirmed                    │ confirmed, lagged
//      from Timeout  │ confirmed  ← self-corrects   │ UNKNOWN  ← never claims it landed
//
//   `settled` is unconditional in both rows, and that is the point rather than a shortcut: an
//   observed balance movement is direct evidence, and it does not matter what the builder said
//   before it. That is what lets a slow-but-successful send correct itself from "unconfirmed" to
//   "Sent" without anyone asserting anything they did not see.
//
//   ── WHY IT IS A MODULE ───────────────────────────────────────────────────────
//
//   Three callers need this fork — send, move, and the faucet — and it is two branches over two
//   booleans. Three hand-written copies of that is how the bottom-right cell quietly becomes
//   "confirmed" in one of them. Here it is written once, and the cell that matters is pinned by a
//   test that asserts what it is NOT.

import type { SettleStatus } from '../../../context/settle'

/** How the transaction reached the settle loop: what the builder returned before the watch began. */
export type SettleStartedBy = 'Commit' | 'Timeout'

/**
 * The statuses a FINISHED watch can hold.
 *
 * Derived from settle.ts's union rather than restated, so a new status there fails this fork at the
 * type level instead of falling through one of its branches.
 */
export type FinishedStatus = Exclude<SettleStatus, 'settling'>

export type SettleVerdict =
  /** The transaction landed. `lagged` only describes whether we saw it, not whether it happened. */
  | { kind: 'confirmed'; lagged: boolean }
  /** Nothing was ever observed. Not a failure — an absence, and it must be said as one. */
  | { kind: 'unknown' }

export function settleVerdict(startedBy: SettleStartedBy, status: FinishedStatus): SettleVerdict {
  // Direct evidence, and it outranks whatever the builder reported.
  if (status === 'settled') return { kind: 'confirmed', lagged: false }
  // Nothing observed. Only a prior Commit receipt can carry this to a success.
  return startedBy === 'Commit' ? { kind: 'confirmed', lagged: true } : { kind: 'unknown' }
}

/**
 * The journal patch a verdict justifies, if any.
 *
 * `null` means WRITE NOTHING. An unknown verdict leaves the entry saying `timeout`, which is what
 * it is — patching it would invent an outcome out of a second absence of evidence. The journal only
 * ever adds knowledge, and this is where a settle could have broken that.
 */
export function journalOutcomeFor(verdict: SettleVerdict): 'committed' | null {
  return verdict.kind === 'confirmed' ? 'committed' : null
}
