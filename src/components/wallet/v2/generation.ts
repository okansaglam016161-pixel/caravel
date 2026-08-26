// Discarding the result of work the user has already walked away from.
//
// THE PROBLEM THIS EXISTS FOR. Pricing a move or a public send is an async round trip that ends by
// writing state — the prepared envelope, and the step that shows it. The Back control is live while
// that runs, so a user can dismiss the screen mid-flight. The promise does not know that, and when
// it resolves it writes anyway:
//
//     setMovePrepared(prepared)   // an envelope for a screen that is gone
//     setMoveStep('review')       // …and the screen comes back
//
// The user cancelled and is returned to a review card holding a signed transaction, ready to
// confirm. On the reveal path that is a cancelled IRREVERSIBLE action reappearing armed, which is
// the version of this bug worth naming.
//
// The same guard covers the superseding case: back out, change the amount, price again. Two probes
// are then in flight and the slower one must not overwrite the newer.
//
// A COUNTER RATHER THAN AbortController, deliberately. The work cannot actually be cancelled — the
// dry run is already on the wire and the SDK takes no signal — so the honest primitive is not
// "stop" but "ignore what comes back". Pretending otherwise would suggest a cancellation that never
// happens.

/**
 * Hands out a token per attempt and reports whether a token is still the current one.
 *
 * Usage: take a token before starting, check it before writing anything.
 *
 *     const token = gen.begin()
 *     const result = await work()
 *     if (gen.isStale(token)) return   // the user moved on; drop it
 *
 * `cancel()` invalidates whatever is in flight without starting anything new — what Back and reset
 * call.
 */
export class GenerationGuard {
  private current = 0

  /** Start an attempt. The returned token is valid until the next begin() or cancel(). */
  begin(): number {
    return ++this.current
  }

  /**
   * True when this attempt has been superseded or cancelled, and its result must be discarded.
   *
   * Tokens are issued from 1, so anything below that was never handed out — a caller that forgot
   * begin() and passed a default 0 must not be treated as current on a fresh guard. Failing closed
   * costs a discarded result; failing open re-arms a dismissed screen.
   */
  isStale(token: number): boolean {
    return token < 1 || token !== this.current
  }

  /** Invalidate anything in flight. Nothing new is started. */
  cancel(): void {
    this.current++
  }
}
