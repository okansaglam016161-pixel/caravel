// How much of the balance is private — as a fact, or as an admission that we do not know.
//
// ── WHY THIS IS ITS OWN FUNCTION ─────────────────────────────────────────────
//
// The Privacy card draws a split bar and a "90% private" caption. Both are claims about the
// COMPOSITION of the balance, and a composition is a ratio between two numbers: it is wrong in a
// way a single figure cannot be. A bar drawn from one known half and one absent half does not
// degrade gracefully — it renders as a confident 100%, which is the most misleading thing this
// screen could say, because "all your funds are private" is precisely the reassurance a user would
// act on.
//
// So the ratio is computed here, in a pure function over the same unions the rest of the wallet
// uses, and the component can only draw a bar when this returns `known`. Every other outcome
// carries a word instead of a number.
//
// ── THE FOUR REFUSALS ────────────────────────────────────────────────────────
//
//   hidden ....... The eye is on. A 90/10 bar leaks the composition the eye exists to conceal —
//                  masking the FIGURES while drawing the RATIO would defeat the control.
//   settling ..... The halves are mid-transition. A ratio across two moments is the same
//                  arithmetic error that a settling total refuses to perform.
//   loading ...... No reading yet. Not zero, not 100% — nothing.
//   unreadable ... A read failed. Which half failed is the Privacy card's amount rows to say.
//
// `total.status === 'ready'` already guarantees both halves are known AND from the same read
// generation (see computeTotal). The per-balance checks below are therefore redundant today, and
// kept deliberately: they are what makes this function correct on its own terms rather than
// correct by reference to an invariant enforced in another file.

import type { BalanceView } from './balances'
import type { TotalView } from './total'

export type SplitView =
  /** Both halves known and non-zero. `privatePct` is exact, unrounded, 0–100. */
  | { kind: 'known'; privatePct: number }
  /** Both halves known and both zero. There is a balance; it is nothing. No ratio exists. */
  | { kind: 'empty' }
  /** No ratio can be stated. `label` is the reason, or null when the reason is already on screen. */
  | { kind: 'unknown'; label: string | null }

export function privacySplit(
  total: TotalView,
  privateBalance: BalanceView,
  publicBalance: BalanceView,
  hidden: boolean,
): SplitView {
  // Said first, and without a label: the eye is a control the user just pressed, so the screen does
  // not need to explain the state back to them. The masked amounts beneath already show it.
  if (hidden) return { kind: 'unknown', label: null }

  switch (total.status) {
    case 'settling': return { kind: 'unknown', label: 'Updating' }
    case 'loading': return { kind: 'unknown', label: 'Checking' }
    case 'unreadable': return { kind: 'unknown', label: 'Unavailable' }
    case 'ready': break
  }

  // Redundant against computeTotal, deliberately — see the header.
  if (privateBalance.status !== 'ready' || publicBalance.status !== 'ready') {
    return { kind: 'unknown', label: 'Unavailable' }
  }

  const priv = privateBalance.microtari
  const sum = priv + publicBalance.microtari
  if (sum <= 0n) return { kind: 'empty' }

  // Basis points, then down to a float. The division happens in bigint so a balance larger than
  // Number.MAX_SAFE_INTEGER cannot lose precision on its way to a percentage.
  return { kind: 'known', privatePct: Number((priv * 10_000n) / sum) / 100 }
}

/**
 * The caption, with the two roundings that would otherwise lie.
 *
 * 99.6% private is not "100% private" — the difference is a real, spendable, publicly visible
 * balance, and rounding it away tells the user they have nothing on chain when they do. The same
 * holds at the bottom: a dust private balance is not "0% private". Both edges get an inequality
 * rather than a round number.
 */
export function splitLabel(privatePct: number): string {
  if (privatePct > 0 && privatePct < 1) return '<1% private'
  if (privatePct < 100 && privatePct > 99) return '>99% private'
  return `${Math.round(privatePct)}% private`
}
