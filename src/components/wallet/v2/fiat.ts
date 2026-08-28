// Dollar values, over the balances the wallet already trusts.
//
// ── FIAT IS A DISPLAY LAYER, NOT A SOURCE ────────────────────────────────────
//
// Nothing here decides whether a balance is known. That decision is already made, once, by
// computeTotal and by the BalanceView union, and this module is downstream of both: it converts a
// bigint that exists into a string, and returns null when there is no bigint.
//
// THAT IS WHY computeTotal IS UNTOUCHED BY THIS STAGE. `TotalView` carries `microtari` on exactly
// one variant — `ready` — and on none of `loading`, `settling` or `unreadable`. A converter that
// takes a TotalView therefore CANNOT produce a dollar figure from an unknown balance: there is no
// number to convert, and tsc says so at the call site. Threading a price INTO computeTotal would
// have added a fourth thing that can be unknown and a fifth way for the total to be wrong, to buy
// nothing the type system was not already enforcing.
//
// The rule that matters is one line, and it is tested: no balance, no dollar. Never a zero, never a
// stale figure, never a guess.
//
// ── THE RATE IS A PLACEHOLDER, AND SAYS SO ───────────────────────────────────
//
// One fixed constant, no feed, no fetch, nothing async. Caravel runs on a testnet where XTR has no
// market price, so a "live" rate would be a more elaborate fiction than an honest placeholder. The
// wallet already declares itself testnet in the network chip beside the header, which is why there
// is no second tag on the hero saying the same thing again.
//
// Replacing this at mainnet means changing RATE_NUM / RATE_DEN and giving the conversion an
// unavailable state — at which point `fiatFor*` gains a genuine second reason to return null, and
// every call site is already written to handle null.

import type { BalanceView } from './balances'
import type { TotalView } from './total'

/**
 * 1 XTR = $0.0004 USD. TEMPORARY TESTNET PLACEHOLDER.
 *
 * Held as an exact fraction over microtari rather than a float: every amount in this wallet is a
 * bigint precisely so no figure ever round-trips through binary floating point, and a rate applied
 * as `Number(microtari) * 0.0004` would undo that at the last step.
 *
 *   USD = microtari x RATE_NUM / RATE_DEN
 *       = microtari x 4 / 10^10          (microtari -> XTR is /10^6, XTR -> USD is x4/10^4)
 */
export const RATE_NUM = 4n
export const RATE_DEN = 10_000_000_000n

/** Human-readable form of the rate, for anywhere that needs to state it. */
export const RATE_LABEL = '1 XTR = $0.0004'

/**
 * Decimal places.
 *
 * Two above a dollar, four below it. Testnet balances are worth fractions of a cent, so a flat two
 * places would render every figure in this wallet as "$0.00" — which is precisely the confident
 * wrong number the rest of this codebase exists to refuse. Four everywhere would give "$48,250.1900"
 * once amounts are real.
 */
function placesFor(usdWhole: bigint): number {
  return usdWhole >= 1n ? 2 : 4
}

/**
 * Format a microtari amount as USD. Exact — bigint throughout, truncated, never rounded up.
 *
 * Truncation is deliberate: a balance should never display as more than it is.
 */
export function usdFromMicrotari(microtari: bigint): string {
  const whole = (microtari * RATE_NUM) / RATE_DEN
  const dp = placesFor(whole)
  const scale = 10n ** BigInt(dp)
  const scaled = (microtari * RATE_NUM * scale) / RATE_DEN

  const intPart = scaled / scale
  const frac = (scaled % scale).toString().padStart(dp, '0')
  return `$${intPart.toLocaleString('en-US')}.${frac}`
}

/**
 * The total as USD — or null when there is no total to convert.
 *
 * NULL IS THE POINT. `loading`, `settling` and `unreadable` carry no figure, so there is nothing to
 * price, and the caller must keep rendering the state it already had.
 */
export function fiatForTotal(total: TotalView): string | null {
  return total.status === 'ready' ? usdFromMicrotari(total.microtari) : null
}

/** One side as USD — or null when that side is loading or unavailable. Same rule. */
export function fiatForBalance(balance: BalanceView): string | null {
  return balance.status === 'ready' ? usdFromMicrotari(balance.microtari) : null
}
