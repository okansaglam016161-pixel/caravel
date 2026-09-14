// What the composer's submit does, and when it is live.
//
// ── WHY THIS IS A MODULE AND NOT TWO INLINE EXPRESSIONS ──────────────────────
//
// The DM composer and the group composer are separate implementations of the same control, and each
// has three ways to submit: the preview card's Send, the arrow, and Enter. That is six places for
// one rule to live, and the rule duly came apart — the arrow and Enter ran the text-only path while
// an image sat staged above them, so a caption typed under a photo was sent as a standalone message
// and the photo was left behind. Only the card had been taught about attachments.
//
// The decision is pure — it is a function of which composer modes are active — so it belongs
// somewhere both composers read and a test can reach, alongside replyCompose's interlocks and
// messageEdit's submittability rule. Nothing here touches React, a File, or the network.

/** The composer's mutually exclusive modes, as the two composers already track them. */
export interface ComposerState {
  /** An edit is in progress; the textarea is the edit field and submit means Save. */
  editing: boolean
  /** Payment mode; the textarea is the note field and submit means Review. Group threads: never. */
  paymentMode?: boolean
  /** An image is staged in the preview card above the composer, captioned by the textarea. */
  attachment: boolean
}

/** Which send a submit performs. */
export type ComposerAction = 'save-edit' | 'review-payment' | 'send-attachment' | 'send-text'

/**
 * What a submit should do, from whichever control raised it.
 *
 * ORDER IS THE CONTRACT. Edit outranks everything: it reuses the same textarea, so a submit while
 * editing must Save and nothing else. Payment comes next for the same reason — the textarea is the
 * note field, and submit opens the confirm gate rather than sending. An attachment is checked only
 * once both are ruled out, which is the ordering the interlocks already imply: beginEdit refuses
 * while an image is staged, and the preview card is not rendered in payment mode. Text is the
 * fallback, unchanged and reached exactly when nothing else is staged.
 */
export function composerAction(state: ComposerState): ComposerAction {
  if (state.editing) return 'save-edit'
  if (state.paymentMode) return 'review-payment'
  if (state.attachment) return 'send-attachment'
  return 'send-text'
}

export interface SubmittableState extends ComposerState {
  /** The textarea's trimmed contents. */
  draft: string
  /** A text send is in flight. */
  sending: boolean
  /** An image send is in flight. */
  imageBusy: boolean
  /** Edit mode only: the text is non-empty AND actually different. */
  editSubmittable?: boolean
  /** Payment mode only: the amount and recipient validate. */
  paymentValid?: boolean
  /** Either composer's "a payment is being confirmed or paid" freeze. */
  busy?: boolean
}

/**
 * Whether submit is live — the arrow's enabled state, and the rule Enter should agree with.
 *
 * THE ATTACHMENT CLAUSE IS THE FIX. A staged photo makes the composer submittable with NO TEXT at
 * all, which is what the preview card has always allowed and what the arrow refused: `draft.trim()`
 * alone left the arrow dark over a picked photo, and Enter — which consulted nothing — sent the
 * empty-caption case down the text path, where it bailed on its own first line.
 *
 * `imageBusy` keeps submit dark while a send runs, as the card's own button already is. It is not a
 * substitute for the double-send guard in the send path: a disabled button cannot be clicked, but
 * Enter arrives through a keydown handler that no `disabled` attribute governs.
 */
export function canSubmit(state: SubmittableState): boolean {
  if (state.busy) return false
  if (state.editing) return !!state.editSubmittable
  if (state.paymentMode) return !!state.paymentValid
  if (state.sending || state.imageBusy) return false
  return state.draft.trim().length > 0 || state.attachment
}
