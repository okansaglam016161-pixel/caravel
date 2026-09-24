// What the network actually said about a submitted transaction.
//
// ── THE MIDDLE VARIANT IS THE WHOLE REASON THIS FILE EXISTS ───────────────────
//
// A transaction has three outcomes on the wire, not two:
//
//   { Accept: SubstateDiff }                        everything committed
//   { AcceptFeeRejectRest: [SubstateDiff, Reason] }  THE FEE COMMITTED, NOTHING ELSE DID
//   { Reject: Reason }                               nothing committed
//
// and consensus reports `final_decision: "Commit"` for the first TWO, because the fee intent did
// commit. Every submit path in this app used to read `final_decision` alone, so the middle variant
// — a user paying a fee for a move that did not happen — was reported to them as success, and the
// network's explanation was dropped on the floor.
//
// feeProbe.ts had already learned this on the DRY-RUN path, where the same misreading priced a
// doomed transaction as a cheap one. Its fix is the one reproduced here, and the reason this is a
// module rather than a fifth copy of the check is that five call sites reading a three-variant
// union by hand is five chances to read it as two.
//
// ── WHAT IT REFUSES TO GUESS ─────────────────────────────────────────────────
//
// The classification is POSITIVE: a transaction succeeded if and only if the result is `Accept`.
// Anything else — including a shape this code does not recognise — is a failure. The asymmetry is
// deliberate and it is the same one feeProbe states: reporting a working transaction as failed
// costs a confusing message and a rescan, while reporting a failed one as working costs the user
// money and tells them nothing was wrong.

/**
 * The verdict on a transaction the network has finished deciding.
 *
 * `null` is not a verdict — it means NOT YET, and a caller polling for finality must keep polling
 * rather than treat it as either outcome. Separating "no answer" from "a bad answer" is the same
 * distinction substates.ts draws between absence and ignorance, for the same reason.
 */
export type TxVerdict =
  /** `Accept`. The transaction committed in full — this is the only success. */
  | { kind: 'accept' }
  /** `AcceptFeeRejectRest`. The fee was taken and the transaction did not happen. */
  | { kind: 'fee-only'; reason: string }
  /** `Reject`. Nothing committed. */
  | { kind: 'reject'; reason: string }
  /** Decided, but in terms this code cannot read. Failure, by the rule above. */
  | { kind: 'unreadable'; reason: string }

/**
 * Render a `RejectReason` as something a person can act on, verbatim where possible.
 *
 * The binding admits eight variants, and they are not one shape: six are single-key objects whose
 * value is a string or a struct (`ExecutionFailure`, `SubstateNotFound`, `FailedToLockInputs`,
 * `FailedToLockOutputs`, `InsufficientFeesPaid`, `ForeignShardGroupDecidedToAbort`, `Abort`), and
 * two are bare strings (`ForeignPledgeInputConflict`, `FeePaymentInMainIntent`).
 *
 * The network's own words are the most useful thing we are ever told about a failed transaction, so
 * this never invents a friendlier message — it only unwraps the tagging so the useful half is not
 * buried in JSON punctuation. plainError leaves anything it does not recognise alone, so what the
 * network said reaches the screen intact.
 */
export function describeRejectReason(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && !Array.isArray(reason)) {
    const entries = Object.entries(reason as Record<string, unknown>)
    if (entries.length === 1) {
      const [tag, value] = entries[0]!
      if (typeof value === 'string') return `${tag}: ${value}`
      return `${tag}: ${JSON.stringify(value).slice(0, 200)}`
    }
  }
  return JSON.stringify(reason).slice(0, 200)
}

/** Narrow an unknown to a plain object without asserting anything about its contents. */
function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

/**
 * Read a submitted transaction's verdict out of `GET /transactions/{id}/result`.
 *
 * THE COMMITTED SHAPE IS NOT THE DRY-RUN SHAPE. This endpoint answers at
 * `result.Finalized.execution_result.finalize.result`; the dry-run endpoint answers at
 * `result.finalize.result` with no `execution_result` wrapper and no `Finalized` envelope. The two
 * have been confused before — see the note in confidentialSend's poll, where reading the dry run's
 * path against a committed transaction made the fee silently undefined for a whole milestone.
 *
 * Returns `null` while the transaction has no final decision, so a polling loop can simply continue.
 */
export function readFinalizedVerdict(body: unknown): TxVerdict | null {
  const finalized = obj(obj(obj(body)?.result)?.Finalized)
  if (!finalized) return null

  // Undecided. Nothing to report yet, and NOT a failure — the caller keeps waiting.
  const decision = finalized.final_decision
  if (typeof decision !== 'string' || decision === '') return null

  const result = obj(obj(obj(finalized.execution_result)?.finalize)?.result)

  // Decided, but the result body is missing or not an object.
  //
  // A non-Commit decision is unambiguous even without one — consensus aborted the transaction and
  // nothing moved — so it is reported as the rejection it is. A `Commit` with no readable result is
  // the case that must NOT be waved through: it is indistinguishable, from here, between a clean
  // Accept and a fee-only commit, and the rule of this module is that only a result we can read as
  // `Accept` counts as success.
  if (!result) {
    return decision === 'Commit'
      ? { kind: 'unreadable', reason: 'the network committed this transaction but returned no readable result' }
      : { kind: 'reject', reason: `the network did not commit this transaction (${decision})` }
  }

  if (result.Accept !== undefined) return { kind: 'accept' }

  if (result.AcceptFeeRejectRest !== undefined) {
    // Shape is [SubstateDiff, RejectReason] — the reason is the second element and the only part
    // worth reporting. Tolerant of a non-array in case the wire form ever changes.
    const pair = result.AcceptFeeRejectRest
    const reason = Array.isArray(pair) ? pair[1] : pair
    return { kind: 'fee-only', reason: describeRejectReason(reason) }
  }

  if (result.Reject !== undefined) {
    return { kind: 'reject', reason: describeRejectReason(result.Reject) }
  }

  const seen = Object.keys(result).join(', ') || '(none)'
  return { kind: 'unreadable', reason: `the network returned an unrecognised transaction result (${seen})` }
}

/**
 * The sentence a failed transaction shows the user, with the network's own words inside it.
 *
 * FEE-ONLY GETS ITS OWN LINE because it is the one outcome a person cannot infer from their
 * balance: money left the wallet and nothing was achieved, which looks identical to a fee for a
 * move that worked until you go looking for the move. Saying it plainly is the entire point of
 * reading the middle variant at all.
 */
export function describeFailure(verdict: Exclude<TxVerdict, { kind: 'accept' }>): string {
  switch (verdict.kind) {
    case 'fee-only':
      return `The network took the fee and rejected the rest of this transaction, so nothing moved. It reported: ${verdict.reason}`
    case 'reject':
      return `The network rejected this transaction: ${verdict.reason}`
    case 'unreadable':
      return `This transaction could not be confirmed: ${verdict.reason}`
  }
}
