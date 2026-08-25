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

export type SendSourceChoice = 'private' | 'public'

export type SendPath<TPrepared> =
  /** Spend the public balance, using exactly the envelope that was priced at review. */
  | { kind: 'public'; prepared: TPrepared }
  /** Spend the private balance, built and submitted in one call. */
  | { kind: 'private' }
  /** Refuse. `reason` is fit to show a user. */
  | { kind: 'refuse'; reason: string }

/**
 * Decide, without a fallback.
 *
 * The public branch REQUIRES its prepared envelope. There is deliberately no "otherwise send it
 * privately" arm — a missing envelope means the pricing step did not complete, and the correct
 * response to that is to stop, not to quietly spend different money.
 */
export function resolveSendPath<TPrepared>(
  source: SendSourceChoice,
  prepared: TPrepared | null | undefined,
): SendPath<TPrepared> {
  if (source === 'public') {
    if (!prepared) {
      return {
        kind: 'refuse',
        reason: 'This payment wasn’t ready yet, so nothing was sent. Go back and try again.',
      }
    }
    return { kind: 'public', prepared }
  }
  return { kind: 'private' }
}
