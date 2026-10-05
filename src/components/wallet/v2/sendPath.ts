// Which transaction a confirmed send should actually submit.
//
// WHY THIS IS A FUNCTION AND NOT A TERNARY. It used to be one, inline in the confirm handler:
//
//     sendSource === 'public' && sendPrepared
//       ? await sendPrepared.submit(...)      // spends the PUBLIC balance
//       : await sendConfidential(...)         // spends the PRIVATE balance
//
// which means that if the source is public and the prepared envelope is missing for ANY reason, it
// silently spends from the private balance instead. The user picked one balance and a different one
// empties. Nothing about that is visible: the amount is right, the recipient is right, and the
// wrong money moves.
//
// It was unreachable in practice — the confirm button is disabled while the fee is still resolving,
// which is the only way to reach review without a prepared envelope. But that is a guard made of UI
// STATE, one refactor away from not holding, protecting against a silent wrong-source spend. So the
// decision is made here instead, where "public without an envelope" has no path to the private
// builder at all and is a refusal rather than a fallback.
//
// BOTH SOURCES ARE PREPARED NOW. The private path used to be "built and submitted in one call", so
// only the public branch carried an envelope. Since both price before review, both require theirs —
// and the envelope is TAGGED with the source it was priced for, so an envelope from the other
// balance (a source toggled after pricing) is refused rather than submitted.

export type SendSourceChoice = 'private' | 'public'

/** An envelope priced at review, tagged with the balance it spends. */
export type PreparedFor<TPublic, TPrivate> =
  | { source: 'public'; p: TPublic }
  | { source: 'private'; p: TPrivate }

export type SendPath<TPublic, TPrivate> =
  /** Spend the public balance, using exactly the envelope that was priced at review. */
  | { kind: 'public'; prepared: TPublic }
  /** Spend the private balance, using exactly the envelope that was priced at review. */
  | { kind: 'private'; prepared: TPrivate }
  /** Refuse. `reason` is fit to show a user. */
  | { kind: 'refuse'; reason: string }

const NOT_READY = 'This payment wasn’t ready yet, so nothing was sent. Go back and try again.'

/**
 * Decide, without a fallback.
 *
 * Each branch REQUIRES its own prepared envelope. A missing one means the pricing step did not
 * complete, and one priced for the other balance means the choice changed after pricing; the
 * correct response to either is to stop, not to quietly spend different money.
 */
export function resolveSendPath<TPublic, TPrivate>(
  source: SendSourceChoice,
  prepared: PreparedFor<TPublic, TPrivate> | null | undefined,
): SendPath<TPublic, TPrivate> {
  if (!prepared || prepared.source !== source) return { kind: 'refuse', reason: NOT_READY }
  return prepared.source === 'public'
    ? { kind: 'public', prepared: prepared.p }
    : { kind: 'private', prepared: prepared.p }
}
