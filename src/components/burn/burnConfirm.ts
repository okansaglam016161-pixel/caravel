// "Burn forever", as one guarded sequence: confirm the quote → journal → submit → settle.
//
// ── IT RUNS ONCE PER CLICK SEQUENCE, HOWEVER FAST THE CLICKS ─────────────────
//
// The lock is taken SYNCHRONOUSLY, on the first line, before any await. React only re-renders after
// the click handler returns, so a second click landing before that re-render still finds the old
// "Burn forever" button on screen — and, without this, would start a second confirm, a second
// journal row and a second submit. (The second submit would carry the same envelope and could not
// burn twice, but the duplicate row would still be a lie in Activity.)
//
// The lock is released only where a NEW confirm is legitimate: when the burn goes back to review to
// be re-priced, and when the sheet goes back to the form ("Try again"). A finished burn keeps it.
//
// Lifted out of BurnSheet with its dependencies injected, so the guard can be tested without a DOM.

import type { BurnResult, PreparedBurn } from '../../crypto/burn'
import type { JournalDraft, JournalOutcome, JournalPatch } from '../../crypto/journal'
import { FEE_SHORT_MESSAGE, QuoteChanged, isFeeShortRejection } from '../../crypto/quote'
import type { PendingSettle } from '../../context/settle'
import { plainError } from '../wallet/v2/plainError'

/** How long the settle loop waits for the paying balance to fall — the send flow's figure. */
export const SETTLE_MS = 150_000

const JOURNAL_OUTCOME: Record<BurnResult['outcome'], JournalOutcome> = {
  Commit: 'committed',
  Reject: 'rejected',
  Timeout: 'timeout',
}

/** What the sheet shows after "Burn forever" — every state this sequence can lead to. */
export type BurnProgress =
  | { step: 'burning'; amount: bigint; progress: string }
  | { step: 'success'; amount: bigint; fee: bigint; txId: string }
  | { step: 'unconfirmed'; amount: bigint; txId: string }
  | { step: 'error'; message: string }

export interface BurnConfirmDeps {
  address: string
  beginEntry: (address: string, draft: JournalDraft) => { entry: { id: string } }
  settleEntry: (address: string, id: string, patch: JournalPatch) => unknown
  beginSettle: (entry: Omit<PendingSettle, 'status' | 'delta'>) => void
  rescan: () => void
  /** Balances BEFORE submitting — the baselines the settle watch measures from. */
  balancesBefore: () => { private: bigint | null; public: bigint | null }
  show: (v: BurnProgress) => void
  /** Back to review, re-priced, with this notice. Nothing was sent. */
  reprice: (notice: string) => void
  /** The burn committed (or was broadcast and may still land). */
  onBurned: (amount: bigint, txId: string) => void
  now?: () => number
}

export function createBurnConfirm(deps: BurnConfirmDeps) {
  let inFlight = false

  async function confirm(prepared: PreparedBurn): Promise<void> {
    if (inFlight) return
    inFlight = true

    const amount = prepared.amountMicrotari
    deps.show({ step: 'burning', amount, progress: 'Checking the fee…' })

    try {
      await prepared.confirm()
    } catch (e) {
      if (e instanceof QuoteChanged) { inFlight = false; deps.reprice(e.message); return }
      prepared.release()
      deps.show({ step: 'error', message: plainError(e instanceof Error ? e.message : String(e)) })
      return
    }

    // Written before anything is sent, so a throw or a closed tab still leaves a record.
    const journalId = deps.beginEntry(deps.address, {
      kind: 'burn',
      amountMicrotari: amount,
      feeMicrotari: prepared.feeMicrotari,
      from: prepared.source,
      to: 'external',
      counterparty: null,
      note: null,
      source: 'local-journal',
      selfOutputIds: null,
      spentInputIds: null,
    }).entry.id

    const before = deps.balancesBefore()

    try {
      const result = await prepared.submit(progress => deps.show({ step: 'burning', amount, progress }))
      deps.settleEntry(deps.address, journalId, {
        outcome: JOURNAL_OUTCOME[result.outcome],
        txId: result.txId,
        feeMicrotari: result.feeMicrotari,
        selfOutputIds: result.selfOutputIds,
        spentInputIds: result.spentInputIds,
      })
      if (result.outcome === 'Commit' || result.outcome === 'Timeout') {
        deps.beginSettle({
          txId: result.txId,
          kind: 'send',
          deadlineAt: (deps.now ?? Date.now)() + SETTLE_MS,
          expectOutputs: result.selfOutputIds,
          watches: [prepared.source === 'public'
            ? { side: 'public', direction: 'fall', before: before.public }
            : { side: 'private', direction: 'fall', before: before.private }],
        })
        deps.rescan()
        deps.onBurned(amount, result.txId)
        deps.show(result.outcome === 'Commit'
          ? { step: 'success', amount, fee: result.feeMicrotari, txId: result.txId }
          : { step: 'unconfirmed', amount, txId: result.txId })
      } else {
        // A fee that rose as it was sent is a free reject: price it again and ask.
        if (isFeeShortRejection(result.reason)) { inFlight = false; deps.reprice(FEE_SHORT_MESSAGE); return }
        deps.show({ step: 'error', message: plainError(result.reason ?? 'The network rejected this burn. Nothing was burned.') })
      }
    } catch (e) {
      // Attempted, outcome unknown — never recorded as a failure we did not see.
      deps.settleEntry(deps.address, journalId, { outcome: 'pending' })
      deps.show({ step: 'error', message: plainError(e instanceof Error ? e.message : String(e)) })
    }
  }

  return {
    confirm,
    /** True from the first click until the sequence hands back to review or the form. */
    inFlight: () => inFlight,
    /** Back at the form ("Try again"): a new burn may be confirmed. */
    reset: () => { inFlight = false },
  }
}
