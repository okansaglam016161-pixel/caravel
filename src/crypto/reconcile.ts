// Working out which of the UTXOs this wallet owns were sent to it by somebody else.
//
// ── THE PROBLEM, IN ONE PARAGRAPH ────────────────────────────────────────────
//
// A confidential output carries no sender. The scan can decrypt every UTXO this wallet owns and
// read its amount, and it cannot tell an incoming payment from the wallet's own change: both are
// owned commitments that simply appeared. Deriving receives from the scan alone was tried once and
// reverted, because it reported the user's own change, faucet deposits and dust as "Received · No
// note" (see the migration in txHistory.ts).
//
// What the chain cannot say about other people's actions, the journal can say about ours. Every
// output this wallet creates for itself is built client-side and its commitment recorded at the
// moment it exists — so the arithmetic is:
//
//     leftovers = owned − our own outputs − outputs another source already attributed
//
// That subtraction is EXACT, not statistical. What is left is, by construction, not something we
// made. This module does that subtraction, and then refuses to draw a conclusion from it unless
// every condition that could make it wrong is known to be false.
//
// ── THE ASYMMETRY EVERY DECISION HERE RESOLVES ON ────────────────────────────
//
// A missed receive leaves a balance that is still correct. A fabricated one tells the user a
// stranger paid them when it was their own change, and destroys trust in the whole ledger. So
// over-subtraction is safe and under-subtraction lies, and every ambiguous case below suppresses.
//
// ── WHY IT IS PURE ───────────────────────────────────────────────────────────
//
// No fetches, no clock, no React. The scan already carries each UTXO's amount AND its memo — the
// memo is decoded by walletScanner and, until now, discarded by every consumer. The journal, the
// ledger and the epoch supply the rest. Everything this needs has already been read, which is what
// lets the whole classification be a tested function over data rather than a process.

import { coverageComplete, outputsFullyAccounted, type JournalEntry, type JournalEpoch } from './journal'
import { isPreEpoch, firstSeenAt, type UtxoLedger } from './utxoLedger'
import type { ScannedUtxo } from './walletScanner'

/** Why a leftover was not classified. Reported rather than swallowed, so a caller can say why. */
export type SuppressionReason =
  /** No journal at all — a wallet older than journalling, or one whose storage was cleared. */
  | 'no-epoch'
  /** A journal write was lost. A hole cannot be proven closed, so nothing may be claimed after it. */
  | 'degraded'
  /** Some output-creating action is not recorded, so some of our own outputs are unaccounted. */
  | 'coverage-incomplete'
  /** A committed action never recorded what it created — see journal/unresolvedOutputs. */
  | 'unresolved-outputs'
  /** Already owned when coverage completed. Could be our own change from an unrecorded action. */
  | 'pre-epoch'
  /** No complete scan has ever reported this UTXO, so there is no first-seen to reason about. */
  | 'never-seen'
  /** First seen before coverage completed — possibly the output of an unrecorded action. */
  | 'seen-before-coverage'

/**
 * A UTXO this wallet holds that it did not create.
 *
 * WHAT IT CAN SAY: how much, and when we first saw it. WHAT IT CAN NEVER SAY: who sent it. There
 * is no sender in a confidential output and no amount of local bookkeeping invents one.
 */
export interface ReconciledReceive {
  utxoId: string
  /** Decrypted from the UTXO by the scan. Known exactly — this is not an estimate. */
  amountMicrotari: bigint
  /**
   * When a complete scan first reported it. NOT when it was sent, and never to be rendered as one:
   * a UTXO can sit unseen for as long as the app is closed.
   */
  firstSeenAt: number
  /**
   * `memo` — the sender attached words to this payment, so it is certainly not ours: every output
   * this wallet makes for itself is built without one (checked at all five sites). Unverified, in
   * that a sender writes it, but a sender who wrote it did send us the money.
   *
   * `inferred` — no memo. It is a receive because the subtraction says so and every guard passed,
   * not because anything on the output says who it came from.
   */
  confidence: 'memo' | 'inferred'
  /** The sender's own words, when they left any. Already decrypted by the scan. */
  message: string | null
  /** A sender-supplied correlation reference, when present. */
  payRef: string | null
}

export interface SuppressedUtxo {
  utxoId: string
  reason: SuppressionReason
}

export interface ReconcileResult {
  /** Newest first. Empty whenever `reason` is set. */
  receives: ReconciledReceive[]
  suppressed: SuppressedUtxo[]
  /**
   * Set when NOTHING could be classified, whatever the UTXO — a fact about the journal rather than
   * about any one output. Null when classification ran normally.
   */
  reason: SuppressionReason | null
}

export interface ReconcileInput {
  /** Every UTXO the scan decrypted as ours, with its amount and memo. */
  owned: readonly ScannedUtxo[]
  journal: readonly JournalEntry[]
  ledger: UtxoLedger
  epoch: JournalEpoch | null
  /**
   * UTXOs another source has already attributed to a named counterparty — today, the ids carried by
   * chat payment messages.
   *
   * These are OWNED and are NOT our own outputs, so the subtraction alone would leave them as
   * unattributed receives sitting beside the attributed row that already names the sender. Removing
   * them here is over-subtraction, which is the safe direction: the payment is still shown, by the
   * source that actually knows who sent it.
   */
  knownReceiveUtxoIds?: readonly string[]
}

/**
 * Every output-substate id the journal has recorded as ours.
 *
 * `null` entries contribute NOTHING and are not treated as empty — a committed action with
 * unrecorded outputs is a hole, and `outputsFullyAccounted` blocks the whole run over it rather
 * than letting this quietly under-subtract.
 */
function journalledSelfOutputs(journal: readonly JournalEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const e of journal) {
    if (e.selfOutputIds === null) continue
    for (const id of e.selfOutputIds) ids.add(id)
  }
  return ids
}

/**
 * A reason the whole journal cannot be reasoned from, or null.
 *
 * Checked once, before any UTXO is looked at, because none of these depend on which UTXO it is.
 * Ordered from most fundamental outward, so the reason reported is the most useful one.
 */
function blockingReason(
  journal: readonly JournalEntry[],
  epoch: JournalEpoch | null,
): SuppressionReason | null {
  if (epoch === null) return 'no-epoch'
  if (epoch.degradedAt !== null) return 'degraded'
  if (!coverageComplete(epoch.covers)) return 'coverage-incomplete'
  if (epoch.coverageCompleteAt === null) return 'coverage-incomplete'
  if (!outputsFullyAccounted(journal)) return 'unresolved-outputs'
  return null
}

/**
 * Subtract, then classify what is left — but only where it is safe to.
 *
 * Every guard fails toward suppression. There is no branch in this function that produces a receive
 * from an absent, unknown or ambiguous value.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { owned, journal, ledger, epoch, knownReceiveUtxoIds = [] } = input

  // ── The subtraction ──
  const ours = journalledSelfOutputs(journal)
  const attributed = new Set(knownReceiveUtxoIds)
  const leftovers = owned.filter(u => !ours.has(u.id) && !attributed.has(u.id))

  // ── Journal-wide refusal ──
  const blocked = blockingReason(journal, epoch)
  if (blocked !== null) {
    return {
      receives: [],
      suppressed: leftovers.map(u => ({ utxoId: u.id, reason: blocked })),
      reason: blocked,
    }
  }
  // Narrowed by blockingReason: both are non-null past this point.
  const coverageAt = epoch!.coverageCompleteAt!

  // ── Per-UTXO ──
  const receives: ReconciledReceive[] = []
  const suppressed: SuppressedUtxo[] = []

  for (const u of leftovers) {
    // Already owned when coverage completed. It may be our own change from an action nobody was
    // recording at the time, and there is no way to tell — so it is never classifiable.
    if (isPreEpoch(ledger, u.id)) {
      suppressed.push({ utxoId: u.id, reason: 'pre-epoch' })
      continue
    }

    const seen = firstSeenAt(ledger, u.id)
    // No complete scan has reported it. This is also how a TRUNCATED scan is handled without a
    // separate guard: the ledger refuses to stamp one, so anything only a truncated scan has shown
    // has no date and is suppressed until a complete scan stamps it.
    if (seen === null) {
      suppressed.push({ utxoId: u.id, reason: 'never-seen' })
      continue
    }
    if (seen < coverageAt) {
      suppressed.push({ utxoId: u.id, reason: 'seen-before-coverage' })
      continue
    }

    // A memo proves the output is not ours: every output this wallet builds for itself is created
    // without one. It does not bypass any guard above — it raises confidence in something already
    // classified, and carries the only words about this payment that exist.
    const message = u.message.length > 0 ? u.message : null
    const payRef = u.payRef.length > 0 ? u.payRef : null

    receives.push({
      utxoId: u.id,
      amountMicrotari: u.amount,
      firstSeenAt: seen,
      confidence: message !== null || payRef !== null ? 'memo' : 'inferred',
      message,
      payRef,
    })
  }

  receives.sort((a, b) => b.firstSeenAt - a.firstSeenAt)
  return { receives, suppressed, reason: null }
}
