// The confirm-time check every prepared transaction runs before it is signed onto the wire.
//
// ── WHY A PRICE CAN GO STALE ─────────────────────────────────────────────────
//
// Every write path prepares first: it selects its coins, dry-runs, and builds the real transaction
// at the measured fee plus a small margin (crypto/feeProbe). The user then reads a review screen —
// for a second, or for ten minutes. Three things can move underneath it in that time:
//
//   the clock      the review was priced against state that is now minutes old;
//   the coins      an input was spent by something else (another tab, a receive-side race), or the
//                  account vault the transaction pinned has a new version;
//   the fee        the engine's requirement for THIS transaction rose above what it pays.
//
// Any of them turns "confirm" into a transaction that fails after the user approved it — and a
// failed transaction can still cost its fee. So at confirm, BEFORE anything is sent:
//
//   1. a quote older than QUOTE_MAX_AGE_MS is refused outright;
//   2. the inputs are checked still unspent (stealth coins) or unchanged (pinned vault versions);
//   3. a twin of the final transaction is dry-run at the EXACT quoted fee, and anything but an
//      Accept whose required fee is within the quote is refused. The dry run does not enforce the
//      fee itself (feeProbe.simulateFee), so the requirement is compared explicitly.
//
// A refusal is a QuoteChanged, which means NOTHING WAS SENT. The caller re-prepares and asks again;
// it never quietly submits at a different fee. Busy-indexer retries are untouched by this: they
// resend the same sealed envelope (crypto/submitGuard) and never rebuild.

import { inputsStillUnspent, type LandedCheck } from './submitGuard'

/** The longest a review screen's quote may be confirmed for before it must be priced again. */
export const QUOTE_MAX_AGE_MS = 2 * 60_000

/** A submit runs the check itself unless confirm() already ran it within this window. */
export const CONFIRM_FRESH_MS = 30_000

export type QuoteChangedReason = 'stale' | 'inputs-gone' | 'fee-risen' | 'rejected'

/** Thrown before submission when the quote no longer holds. Nothing was sent. */
export class QuoteChanged extends Error {
  readonly reason: QuoteChangedReason
  readonly detail?: string
  constructor(reason: QuoteChangedReason, detail?: string) {
    super(QUOTE_CHANGED_MESSAGES[reason])
    this.name = 'QuoteChanged'
    this.reason = reason
    this.detail = detail
  }
}

/** What the re-priced review says about why it is asking again. Plain words; nothing was sent. */
export const QUOTE_CHANGED_MESSAGES: Record<QuoteChangedReason, string> = {
  'stale': 'That price was more than two minutes old, so it was worked out again. Nothing was sent. Check the fee and confirm.',
  'inputs-gone': 'Some of the funds it was built from have changed, so it was rebuilt. Nothing was sent. Check the fee and confirm.',
  'fee-risen': 'The network fee changed since it was priced, so it was priced again. Nothing was sent. Check the new fee and confirm.',
  'rejected': 'The network would no longer accept it as priced, so it was worked out again. Nothing was sent. Check it and confirm.',
}

/** The verdict shape the check needs from a simulation — FeeSimulation and the ONS writer's both fit. */
export type SimulationVerdict =
  | { accepted: true }
  | { accepted: false; kind?: string; reason?: string }

export interface Quote {
  /** When the transaction was priced (ms since epoch). */
  preparedAt: number
  /** Dry-run the FINAL transaction's twin at the exact quoted fee. */
  simulate: () => Promise<SimulationVerdict>
  /**
   * Has anything the transaction spends moved? Stealth paths pass their input ids (each must still
   * exist); vault paths pass a versionsUnchanged check captured at prepare. Omitted: nothing to check.
   */
  inputs?: { ids: readonly string[] } | { landed: LandedCheck }
}

/** Run the confirm-time check. Resolves when the quote holds; throws QuoteChanged otherwise. */
export async function confirmQuote(q: Quote, now = Date.now()): Promise<void> {
  if (now - q.preparedAt > QUOTE_MAX_AGE_MS) throw new QuoteChanged('stale')

  const inputs = q.inputs
  if (inputs && !('ids' in inputs && inputs.ids.length === 0)) {
    const check = 'ids' in inputs ? inputsStillUnspent(inputs.ids) : inputs.landed
    // `not-landed` is the check's word for "everything it watches is exactly as it was".
    if (await check() !== 'not-landed') throw new QuoteChanged('inputs-gone')
  }

  const sim = await q.simulate()
  if (!sim.accepted) {
    throw new QuoteChanged(sim.kind === 'underpaid' ? 'fee-risen' : 'rejected', sim.reason)
  }
}

/**
 * The confirm/submit pairing every prepared transaction exposes: `confirm()` runs the check and
 * remembers when; `ensureConfirmed()` (called first thing in submit) re-runs it unless confirm()
 * passed within CONFIRM_FRESH_MS. So a UI that confirms before journalling pays one dry run, and a
 * one-shot caller that only calls submit still gets the check.
 */
export function confirmer(quote: Quote) {
  let confirmedAt = 0
  return {
    confirm: async () => {
      await confirmQuote(quote)
      confirmedAt = Date.now()
    },
    ensureConfirmed: async () => {
      if (Date.now() - confirmedAt <= CONFIRM_FRESH_MS) return
      await confirmQuote(quote)
      confirmedAt = Date.now()
    },
  }
}
