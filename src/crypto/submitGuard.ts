// Submitting a transaction to a busy indexer without ever paying twice.
//
// ── THE ONE CASE THAT IS RETRIED ─────────────────────────────────────────────
//
// A submit is retried only when the indexer answered 429 or 503 — its rate limiter refusing the
// request before doing anything with it — and then only:
//
//   1. with the SAME sealed envelope. Never a rebuilt transaction: a rebuild can select different
//      coins, and two different transactions spending different coins can BOTH commit — the user
//      pays twice. The identical envelope spends the identical inputs, so at most one copy can ever
//      commit, whatever happens.
//   2. after a LANDED CHECK says the refused attempt did not land. The TS SDK cannot compute a
//      transaction id before submitting, so there is no id to look up; instead each call site says
//      what the transaction would have changed (its stealth inputs gone, a receipt present, a vault
//      version moved) and that is read. Anything other than a clear "not landed" stops the retry.
//
// ── EVERYTHING ELSE IS NOT RETRIED ───────────────────────────────────────────
//
// A timeout, a dropped connection or another 5xx is AMBIGUOUS: the indexer may have accepted the
// transaction before failing to answer. Those are rethrown untouched, so each call site keeps doing
// what it already does for a failed submit — the journal row stays `pending`, and the existing
// finality / lock-sweep machinery settles it. Resubmitting on an ambiguous failure is exactly the
// double-spend this module exists to prevent.

import { pointRead } from './indexerConfig'
import { IndexerBusyError, backoffMs, isBusyError, retryTiming } from './indexerRetry'

/** The landed check's verdict. Only `not-landed` permits a resubmit. */
export type LandedVerdict = 'not-landed' | 'maybe-landed'
export type LandedCheck = () => Promise<LandedVerdict>

/** Thrown when a busy refusal was followed by evidence that the transaction may have landed anyway. */
export class SubmitMaybeLandedError extends Error {
  constructor() {
    super('The network was busy, and this transaction may already have gone through. Check Activity before trying again.')
    this.name = 'SubmitMaybeLandedError'
  }
}

/** Total submit attempts, the first included. */
export const SUBMIT_ATTEMPTS = 3

/**
 * Submit `envelope`, retrying a busy refusal under the rules above.
 *
 * Returns the submit response. Throws IndexerBusyError if it stayed busy (nothing was sent),
 * SubmitMaybeLandedError if the landed check could not rule out a landing, and anything else
 * exactly as the provider threw it.
 */
export async function submitOnce<R extends { transaction_id: unknown }>(
  submit: () => Promise<R>,
  opts: { landed: LandedCheck; onBusyRetry?: () => void },
): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await submit()
    } catch (e) {
      if (!isBusyError(e)) throw e            // ambiguous or definite: never resubmitted
      if (attempt >= SUBMIT_ATTEMPTS) throw new IndexerBusyError()
      opts.onBusyRetry?.()
      await retryTiming.sleep(backoffMs(attempt, null))
      if ((await opts.landed()) !== 'not-landed') throw new SubmitMaybeLandedError()
    }
  }
}

// ── LANDED CHECKS ────────────────────────────────────────────────────────────
//
// Each one answers `not-landed` only on positive evidence. A read that fails, or a node that has
// not heard, is `maybe-landed` — the safe answer, because it stops the retry.

/**
 * For a transaction that spends stealth coins: it has not landed while EVERY input coin still
 * exists. A spent coin is downed, so any one missing means it may have landed.
 */
export function inputsStillUnspent(utxoIds: readonly string[]): LandedCheck {
  return async () => {
    if (utxoIds.length === 0) return 'maybe-landed'
    const reads = await Promise.all(utxoIds.map(id => pointRead(`/substates/${encodeURIComponent(id)}`)))
    return reads.every(r => r.answered && r.body !== null) ? 'not-landed' : 'maybe-landed'
  }
}

/**
 * For a transaction that would CREATE `substateId` (the faucet's claim receipt): it has not landed
 * while every indexer still says the substate does not exist.
 */
export function substateStillAbsent(substateId: string): LandedCheck {
  return async () => {
    const r = await pointRead(`/substates/${encodeURIComponent(substateId)}`)
    return r.answered && r.body === null ? 'not-landed' : 'maybe-landed'
  }
}

/** The version of a substate as `GET /substates/<id>` reports it, or null if unreadable. */
async function readVersion(substateId: string): Promise<number | null> {
  const r = await pointRead(`/substates/${encodeURIComponent(substateId)}`)
  const v = (r.body as { version?: unknown } | null)?.version
  return r.answered && typeof v === 'number' ? v : null
}

/**
 * For a transaction that writes substates declared WITHOUT a version (the account vaults a conceal
 * or public send spends from): snapshot their versions BEFORE submitting, and call the returned
 * check afterwards — it has not landed while every version is unchanged. Any write by anything
 * moves a version, so a change from elsewhere also stops the retry, which is the safe direction.
 */
export async function versionsUnchanged(substateIds: readonly string[]): Promise<LandedCheck> {
  const before = await Promise.all(substateIds.map(readVersion))
  return async () => {
    if (substateIds.length === 0 || before.some(v => v === null)) return 'maybe-landed'
    const after = await Promise.all(substateIds.map(readVersion))
    return after.every((v, i) => v === before[i]) ? 'not-landed' : 'maybe-landed'
  }
}
