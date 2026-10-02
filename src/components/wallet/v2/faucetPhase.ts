// Which faucet state to show — and, above all, when to show none.
//
// ── CLAIM STATUS DECIDES, NEVER THE BALANCE ──────────────────────────────────
//
// What the faucet offers depends on one fact about this wallet: has its key claimed? That is read
// from the chain (crypto/faucetStatus — the claim receipt), not inferred from how much the wallet
// holds. The previous ladder hid the faucet once the balance passed a threshold ("you already have
// plenty"), which answered a different question: a wallet funded by a payment has never claimed,
// and a wallet that claimed and spent everything has.
//
// So a never-claimed wallet sees the faucet whatever its balance — the claim when the faucet is
// open, and "paused / empty, check back soon" when it is not. A claimed wallet never sees it again.
//
// ── NOT KNOWING IS ITS OWN PHASE ─────────────────────────────────────────────
//
// Until the status has been read — or when the read fails — the phase is `unknown` and renders
// nothing. Offering a claim is a statement about this wallet, and it is not made from a reading
// nobody has.
//
// ── ORDER ────────────────────────────────────────────────────────────────────
//
// The claim's own state comes first. A claim in flight triggers a rescan and, once it commits,
// turns this wallet's status into `claimed` — if status outranked the claim, its progress and result
// card would vanish under the user mid-claim.

import type { FaucetPhase } from './panels'
import type { FaucetStatus } from '../../../crypto/faucetStatus'

/** What the claim's own state machine is doing, independent of the faucet's status. */
export type ClaimState = 'idle' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error'

export interface FaucetPhaseInputs {
  claim: ClaimState
  /** The faucet's status for this wallet, or null before it has been read. */
  status: FaucetStatus['kind'] | null
  /** False until an identity is available. */
  unlocked: boolean
}

/**
 * The one place the faucet decides what it is.
 *
 *   1. done / lagging / error   the claim has something to report. Outranks everything.
 *   2. claiming / verifying     in flight. Must survive the status changing underneath it.
 *   3. locked                   no identity, so no control to offer.
 *   4. unknown                  status not read, or unreadable. Hidden.
 *   5. claimed                  this key has claimed. Hidden for good.
 *   6. paused / empty           never claimed, faucet unavailable: "check back soon".
 *   7. open                     never claimed, faucet open: the only state that offers a claim.
 */
export function faucetPhase({ claim, status, unlocked }: FaucetPhaseInputs): FaucetPhase {
  if (claim === 'done') return 'done'
  if (claim === 'lagging') return 'lagging'
  if (claim === 'error') return 'error'
  if (claim === 'claiming') return 'claiming'
  if (claim === 'verifying') return 'verifying'

  if (!unlocked) return 'locked'
  if (status === null || status === 'unknown') return 'unknown'
  return status
}

/**
 * The phases that render nothing.
 *
 * `claimed` and `locked` are the faucet having nothing to offer — a card about it would be a
 * permanent object nobody can act on. `unknown` is the faucet having no opinion yet.
 */
export function isHidden(phase: FaucetPhase): boolean {
  return phase === 'claimed' || phase === 'locked' || phase === 'unknown'
}
