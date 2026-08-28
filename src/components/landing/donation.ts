//   The donation address, and the copy behaviour that went with it.
//
//   ── WHY THIS FILE EXISTS WITH NO CALLER ──────────────────────────────────────
//
//   The pre-v0.3 landing page carried a "Keep it sailing" donation card: a truncated address, a
//   Copy button, and a two-second copied state. The v0.3 landing design has no slot for it, so it
//   is not rendered anywhere right now — but the ADDRESS IS REAL and the intent is to bring the
//   card back once the design has a home for it.
//
//   Deleting it would mean recovering a live payment address out of git history later and hoping
//   the right revision was found. Lifting it here instead keeps the one thing that is genuinely
//   hard to reconstruct — the address itself — in the working tree, reviewable, next to a note
//   saying why nothing calls it.
//
//   When the card returns: import `XTM_ADDR_DISPLAY` for the on-screen value and
//   `copyDonationAddress()` for the button. Do NOT re-derive the truncation from the full address
//   at the call site; the display form is checked against the real one here.

/** The full donation address. What actually gets copied. */
export const XTM_ADDR =
  '129Wf58tMXfYvqtQgQiuZbs8V75vGKKMPZGKSYVbQNvPDeHwaJ5VzjFXEhpsTEXs5NUbHm2JUVVum5Be1DKs1Zg9Sg7'

/** The truncated form the card showed. Head and tail are verbatim slices of XTM_ADDR. */
export const XTM_ADDR_DISPLAY = '129Wf58tMXfYvqtQgQiuZbs8V75vGKK…um5Be1DKs1Zg9Sg7'

/**
 * Copy the full address to the clipboard.
 *
 * Resolves `false` rather than throwing when the clipboard is unavailable (insecure origin,
 * permissions, an older browser) so a caller can show "couldn't copy" instead of an unhandled
 * rejection — a donation button that silently does nothing is the worst of the three outcomes.
 */
export async function copyDonationAddress(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(XTM_ADDR)
    return true
  } catch {
    return false
  }
}
