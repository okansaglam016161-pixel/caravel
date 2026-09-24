// Which faucet state to show — and, above all, when to show none.
//
// ── THE BUG THIS EXISTS TO PREVENT ───────────────────────────────────────────
//
// The ladder used to end `: 'idle'`, an unconditional fall-through, and the guard above it read:
//
//     const highBalance = balance !== null && balance >= HIGH_BALANCE
//
// which answers "is it DEFINITELY high?" — and then everything downstream treated a `false` as
// "it is low". Those are not the same claim. `false` covers two worlds: known-low, and NOT YET
// KNOWN. Every rescan blanks the balance to `null` before it starts (WalletContext's startScan, via
// SCAN_IDLE), so on every refresh a funded wallet spent a scan's worth of time — a second or two
// over a thousand-odd rows plus trial decrypt — falling through to `idle` and flashing a "Claim
// test funds" banner it did not need. A scan that ERRORED left the balance at null for good, so the
// same banner sat there permanently on a wallet with plenty.
//
// Offering a claim is a statement that this wallet needs funding. The fix is to stop making that
// statement from an indeterminate reading: `unknown` is now its own phase and it renders nothing.
// Same rule the hero already follows — see v2/total.ts, which refuses to show a figure it cannot
// stand behind.
//
// ── ORDER IS THE OTHER HALF OF THE FIX ───────────────────────────────────────
//
// A CLAIM ITSELF TRIGGERS A RESCAN, so the balance is null for part of every claim. If the unknown
// check sat anywhere above the in-flight states, the claim's own progress and result card would
// vanish under the user mid-claim. It is therefore the LAST branch, after done / lagging / error /
// cooldown / busy — each of which is a fact about the claim and owes nothing to the balance. A
// mid-claim `null` hits one of those first and never reaches here.

import type { FaucetPhase } from './panels'

/** "You already have plenty" — the payout is 1000 XTR, so one claim clears this for good. */
export const HIGH_BALANCE = 100_000_000n // 100 XTR

/** What the claim's own state machine is doing, independent of any balance. */
export type ClaimState = 'idle' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error'

export interface FaucetPhaseInputs {
  claim: ClaimState
  /** Caravel's own re-claim throttle, not the faucet's rate limit. */
  cooldown: boolean
  /**
   * The private balance in µXTR. `null` means NOT KNOWN — a scan in flight, or one that failed.
   * Never zero: an empty wallet reads `0n`, and the difference is the entire point of this module.
   */
  balance: bigint | null
  /** False until an identity is available. */
  unlocked: boolean
}

/**
 * The one place the faucet decides what it is.
 *
 * Precedence, and why it is this order:
 *
 *   1. done / lagging / error   the claim has something to report. Outranks everything; a balance
 *                               that has gone unknown underneath it changes nothing.
 *   2. cooldown                 we are declining to re-claim. Also a fact about the claim.
 *   3. claiming / verifying     in flight. Must survive the rescan it triggered.
 *   4. plenty                   CONFIRMED high. Hidden.
 *   5. locked                   no identity, so no control to offer.
 *   6. idle                     CONFIRMED low. The only state that offers a claim.
 *   7. unknown                  the balance is not known. Hidden — see the header.
 */
export function faucetPhase({ claim, cooldown, balance, unlocked }: FaucetPhaseInputs): FaucetPhase {
  if (claim === 'done') return 'done'
  if (claim === 'lagging') return 'lagging'
  if (claim === 'error') return 'error'
  if (cooldown) return 'cooldown'
  if (claim === 'claiming') return 'claiming'
  if (claim === 'verifying') return 'verifying'

  // Both of these ask a question about a KNOWN balance, and neither answers it for `null`. Written
  // as two positive tests rather than one test and its negation, because the negation is exactly
  // the mistake this module was extracted to stop making.
  if (balance !== null && balance >= HIGH_BALANCE) return 'plenty'
  if (!unlocked) return 'locked'
  if (balance !== null && balance < HIGH_BALANCE) return 'idle'
  return 'unknown'
}

/**
 * The phases that render nothing.
 *
 * `plenty` and `locked` are the faucet DECLINING — a card that renders a decline is a permanent
 * object on the overview saying nothing anyone can act on. `unknown` is different in kind: it is
 * the faucet having no opinion yet, which is the honest state during a refresh and the one that
 * used to leak a claim banner.
 */
export function isHidden(phase: FaucetPhase): boolean {
  return phase === 'plenty' || phase === 'locked' || phase === 'unknown'
}
