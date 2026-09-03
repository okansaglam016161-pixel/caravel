// Pure logic for the payment composer's balance pre-check — a sibling of replyCompose.ts and
// messageEdit.ts, extracted for the same reason: it is a RULE, it lived inline in a render file
// where nothing could test it, and the way it failed was silent.
//
// ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────────
//
// The check compared a spend against `scan.balance` and, when the spend was larger, disabled Review
// and refused the send. But walletScanner sets `incomplete` when the indexer caps its listing, and
// the balance is then a LOWER BOUND — "what we could see", not "what you have". Comparing against a
// lower bound cannot conclude "insufficient". It can only conclude "we cannot see all of it". So a
// wallet holding plenty, whose scan happened to be truncated, was told it could not afford a payment
// it could easily afford — with no override anywhere in the UI.
//
// ── WHY IT IS THE MAX RULE AND NOT THE TOTAL RULE ────────────────────────────
//
// The wallet met this same truncated scan from the other side and wrote the answer down. Its balance
// hero REFUSES a total on an incomplete scan, because a lower bound rendered as a total is a
// confident wrong number. Its MAX button, computed from that identical truncated set, KEEPS offering
// a figure — because every output it counted is one we really hold and really can spend, so the
// amount is safe to act on and is merely possibly less than the true maximum. Both rules, and the
// reasoning, are in components/wallet/v2/total.ts (see incompleteAvailableNote).
//
// A spend guard is the MAX case, not the total case. Refusing here does not protect anyone from a
// wrong number; it blocks a working action in order to avoid understating one. So an incomplete scan
// never blocks, and the chain stays the backstop it already was: an unaffordable send is rejected
// on-chain with nothing spent, which the composer already reports and recovers from.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
// It does not say "this may exceed your balance". Saying so needs somewhere to say it, and the
// composer has no available-figure surface yet — the payments design pass adds the figure and the
// note that qualifies it together. Silence is not the finished answer; it is the honest half that
// can ship without inventing UI. Being silent about what we cannot see beats being wrong about it.
//
// Nothing here touches React, the store, or the wire.

/**
 * The subset of the wallet's ScanState this rule reads.
 *
 * Structural rather than an import of ScanState: the guard needs three fields and should not be a
 * reason to reach into WalletContext's shape. The real `scan` object satisfies it as-is.
 */
export interface ScanReading {
  /** The private balance, or null when the scan has not produced one. */
  balance: bigint | null
  /** walletScanner's cap flag — when true, `balance` is a lower bound. */
  incomplete: boolean
  status: 'idle' | 'scanning' | 'done' | 'error'
}

/**
 * Is `balance` a lower bound rather than a balance?
 *
 * PAIRED WITH `status === 'done'`, exactly as the wallet's own `privateFiguresIncomplete` is
 * (WalletModal). A scan in flight has cleared `balance` to null and has not claimed anything yet, so
 * a stale `incomplete` from the previous run has nothing to qualify. The pairing is redundant today
 * for that reason — and kept anyway, so this predicate and the wallet's cannot drift apart on what
 * "incomplete" is allowed to mean.
 */
export function balanceIsLowerBound(scan: ScanReading): boolean {
  return scan.incomplete && scan.status === 'done'
}

/**
 * Does the balance pre-check block this send?
 *
 * `amountMicrotari` is null when the composer holds nothing usable yet (empty, non-numeric, or not
 * greater than zero) — there is nothing to compare, so nothing is blocked and the send is refused
 * elsewhere by its own "enter an amount" rule.
 *
 * The comparison is `>`, not `>=`: spending the entire balance including the fee ceiling is a valid
 * send, not an overdraft.
 */
export function isInsufficientBalance(
  amountMicrotari: bigint | null,
  feeMicrotari: bigint,
  scan: ScanReading,
): boolean {
  if (amountMicrotari === null) return false
  if (scan.balance === null) return false          // no reading — nothing to conclude
  if (balanceIsLowerBound(scan)) return false      // see the header: a lower bound never blocks
  return amountMicrotari + feeMicrotari > scan.balance
}
