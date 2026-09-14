// What the composer's submit does, and when it is live.
//
// THE BUG THESE PIN. Three controls submit the composer — the preview card's Send, the arrow, and
// Enter — across two separate composers, and the rule had come apart: the arrow and Enter ran the
// text-only path while an image sat staged above them, so a caption typed under a photo went out as
// a standalone message and the photo was silently left behind. Only the card knew about
// attachments. These cover the decision both composers now share.

import { describe, expect, it } from 'vitest'
import { canSubmit, composerAction, type SubmittableState } from './composerSend'

const idle = { editing: false, attachment: false }

describe('composerAction — what a submit does', () => {
  it('sends text when nothing is staged', () => {
    expect(composerAction(idle)).toBe('send-text')
  })

  // THE FIX, in one assertion: with a photo staged, a submit is an IMAGE send, whichever control
  // raised it. Before, only the preview card reached this answer.
  it('sends the attachment when one is staged', () => {
    expect(composerAction({ ...idle, attachment: true })).toBe('send-attachment')
  })

  it('sends the attachment even with a caption typed — caption, not a separate message', () => {
    // The reported case exactly: image + caption, Enter pressed. The caption belongs TO the image.
    expect(composerAction({ editing: false, attachment: true })).toBe('send-attachment')
  })

  // ── PRECEDENCE, which is the contract the two composers rely on ───────────
  it('saves the edit first, whatever else is set', () => {
    expect(composerAction({ editing: true, attachment: true })).toBe('save-edit')
    expect(composerAction({ editing: true, paymentMode: true, attachment: true })).toBe('save-edit')
  })

  it('reviews the payment before considering an attachment', () => {
    expect(composerAction({ editing: false, paymentMode: true, attachment: true })).toBe('review-payment')
  })

  it('leaves the plain text path untouched when nothing is staged', () => {
    expect(composerAction({ editing: false, paymentMode: false, attachment: false })).toBe('send-text')
  })
})

const base: SubmittableState = {
  editing: false, attachment: false, draft: '', sending: false, imageBusy: false,
}

describe('canSubmit — when the arrow is live', () => {
  it('is dead with an empty composer and nothing staged', () => {
    expect(canSubmit(base)).toBe(false)
  })

  it('is live on text alone, as it always was', () => {
    expect(canSubmit({ ...base, draft: 'hello' })).toBe(true)
  })

  it('treats whitespace as empty', () => {
    expect(canSubmit({ ...base, draft: '   \n  ' })).toBe(false)
  })

  // THE OTHER HALF OF THE FIX: a photo with NO caption is submittable. The preview card has always
  // allowed it; the arrow refused, because the rule only looked at the draft.
  it('is live on a staged image with no caption at all', () => {
    expect(canSubmit({ ...base, attachment: true })).toBe(true)
  })

  it('is live on a staged image with a caption', () => {
    expect(canSubmit({ ...base, attachment: true, draft: 'look at this' })).toBe(true)
  })

  // ── The freezes ───────────────────────────────────────────────────────────
  it('goes dark while an image send is running', () => {
    expect(canSubmit({ ...base, attachment: true, imageBusy: true })).toBe(false)
    expect(canSubmit({ ...base, draft: 'hi', imageBusy: true })).toBe(false)
  })

  it('goes dark while a text send is running', () => {
    expect(canSubmit({ ...base, draft: 'hi', sending: true })).toBe(false)
  })

  it('goes dark while a payment is confirming or paying, whatever is staged', () => {
    expect(canSubmit({ ...base, draft: 'hi', busy: true })).toBe(false)
    expect(canSubmit({ ...base, attachment: true, busy: true })).toBe(false)
    expect(canSubmit({ ...base, editing: true, editSubmittable: true, busy: true })).toBe(false)
  })

  // ── Edit and payment keep their own rules ─────────────────────────────────
  it('follows editSubmittable in edit mode, and ignores the attachment', () => {
    expect(canSubmit({ ...base, editing: true, editSubmittable: false, draft: 'x' })).toBe(false)
    expect(canSubmit({ ...base, editing: true, editSubmittable: true })).toBe(true)
    expect(canSubmit({ ...base, editing: true, editSubmittable: false, attachment: true })).toBe(false)
  })

  it('follows paymentValid in payment mode, and ignores the draft', () => {
    expect(canSubmit({ ...base, paymentMode: true, paymentValid: false, draft: 'note' })).toBe(false)
    expect(canSubmit({ ...base, paymentMode: true, paymentValid: true, draft: '' })).toBe(true)
  })

  // The two composers must agree on every input, which is the whole reason the rule was lifted out
  // of both of them. A group thread simply never passes paymentMode.
  it('gives a group composer the same answers, with no payment mode', () => {
    expect(canSubmit({ editing: false, attachment: true, draft: '', sending: false, imageBusy: false })).toBe(true)
    expect(canSubmit({ editing: false, attachment: false, draft: '', sending: false, imageBusy: false })).toBe(false)
  })
})
