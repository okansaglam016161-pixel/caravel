// Unit tests for the quoted-reply rules (replies v1). Same rationale as messageEdit.test.ts: these
// predicates are implemented once and consumed by BOTH chat views, so a regression here changes
// behaviour in two places at once and shows up in neither view's own tests.

import { describe, expect, it } from 'vitest'
import { canBeginEdit, canBeginReply, canReplyTo, classifyQuoted, quotedAuthorLabel, quoteSnippet } from './replyCompose'
import type { CaravelMessage } from '../../messaging/types'

function msg(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: 'evt1',
    senderPubkeyHex: 'sender',
    recipientPubkeyHex: 'me',
    plaintext: 'original',
    timestamp: 1_000_000,
    direction: 'received',
    logicalId: 'aaa',
    ...over,
  }
}

describe('canReplyTo — which rows offer the Reply affordance', () => {
  it('allows a received message — quoting someone else is the point', () => {
    expect(canReplyTo(msg())).toBe(true)
  })

  it('allows my OWN message too, unlike edit which is mine-only', () => {
    // The substantive difference from canEditMessage: replies are not authorship-gated.
    expect(canReplyTo(msg({ direction: 'sent' }))).toBe(true)
  })

  it('refuses a message with no logical id (pre-M2) — a quote has no handle to name it', () => {
    expect(canReplyTo(msg({ logicalId: undefined }))).toBe(false)
  })

  it('refuses a group-leave notice — composed at render, no prose to quote', () => {
    expect(canReplyTo(msg({ system: 'group-leave', plaintext: '' }))).toBe(false)
  })

  it('refuses payment and media rows — v1 is text replies only', () => {
    expect(canReplyTo(msg({ payment: { utxoId: 'utxo_1' } }))).toBe(false)
    expect(canReplyTo(msg({ media: { url: 'u', key: 'k', nonce: 'n', mime: 'image/webp', x: 'x', ox: '', width: 1, height: 1, size: 1 } }))).toBe(false)
  })

  it('allows a group message (routing is irrelevant to quotability)', () => {
    expect(canReplyTo(msg({ groupId: 'g1' }))).toBe(true)
  })
})

describe('the symmetric reply/edit interlock', () => {
  it('allows a reply when nothing else owns the composer', () => {
    expect(canBeginReply({ editing: false, replying: false })).toBe(true)
  })

  it('refuses a reply while editing', () => {
    expect(canBeginReply({ editing: true, replying: false })).toBe(false)
  })

  it('refuses an edit while replying', () => {
    expect(canBeginEdit({ editing: false, replying: true })).toBe(false)
  })

  it('allows an edit when nothing else owns the composer', () => {
    expect(canBeginEdit({ editing: false, replying: false })).toBe(true)
  })

  it('is SYMMETRIC — neither direction is privileged', () => {
    // The property that matters: from any single active state, the other cannot be started. An
    // asymmetric rule (edit silently clears a pending reply) would pass the two tests above and
    // fail this one, which is exactly the drift this module exists to prevent.
    const editing = { editing: true, replying: false }
    const replying = { editing: false, replying: true }
    expect(canBeginReply(editing)).toBe(false)
    expect(canBeginEdit(replying)).toBe(false)
  })

  it('re-targeting the SAME state is allowed — replying to a different message mid-reply', () => {
    // Only the OTHER state blocks. Switching which message you are quoting is a normal action and
    // must not require cancelling first (beginEdit already allows re-targeting an edit this way).
    expect(canBeginReply({ editing: false, replying: true })).toBe(true)
    expect(canBeginEdit({ editing: true, replying: false })).toBe(true)
  })
})

describe('classifyQuoted — what the preview renders', () => {
  it('classifies a resolved text message', () => {
    expect(classifyQuoted(msg())).toBe('text')
  })

  it('classifies a missing target as unavailable — a normal state, not an error', () => {
    expect(classifyQuoted(undefined)).toBe('unavailable')
  })

  it('classifies media and payment targets, which only a later client can create', () => {
    expect(classifyQuoted(msg({ payment: { utxoId: 'utxo_1' } }))).toBe('payment')
    expect(classifyQuoted(msg({ media: { url: 'u', key: 'k', nonce: 'n', mime: 'image/webp', x: 'x', ox: '', width: 1, height: 1, size: 1 } }))).toBe('media')
  })

  it('treats a system notice as unavailable — there is no prose to show', () => {
    expect(classifyQuoted(msg({ system: 'group-leave', plaintext: '' }))).toBe('unavailable')
  })

  it('prefers payment over media when a row somehow carries both', () => {
    // Deterministic ordering matters only so the two views never disagree about the same row.
    const both = msg({ payment: { utxoId: 'u' }, media: { url: 'u', key: 'k', nonce: 'n', mime: 'image/webp', x: 'x', ox: '', width: 1, height: 1, size: 1 } })
    expect(classifyQuoted(both)).toBe('payment')
  })
})

describe('quotedAuthorLabel — who authored the quoted message', () => {
  // nameFor stands in for ChatApp's displayName: a nickname lookup that falls back to a truncated
  // npub. Crucially it knows nothing about the viewer's OWN key — nicknames[myOwnKey] is never
  // written — which is exactly the hole this helper covers.
  const nameFor = (hex: string) => (hex === 'chrome' ? 'Chrome' : `npub1${hex}…`)

  it('labels my own quoted message "You" instead of falling through to my npub', () => {
    // THE REGRESSION. Before this helper the author line called nameFor(ownKey) unconditionally, so
    // the one viewer who authored the quoted message saw their own raw npub while everyone else saw
    // a name — same message, different answer per viewer.
    expect(quotedAuthorLabel(msg({ direction: 'sent', senderPubkeyHex: 'chrome' }), nameFor)).toBe('You')
  })

  it("resolves another member's quoted message through nameFor", () => {
    expect(quotedAuthorLabel(msg({ direction: 'received', senderPubkeyHex: 'chrome' }), nameFor)).toBe('Chrome')
  })

  it('still falls back to nameFor\'s own npub fallback for an unknown member', () => {
    // The legitimate fallback is preserved: no name for a peer means npub, and that is correct.
    expect(quotedAuthorLabel(msg({ direction: 'received', senderPubkeyHex: 'stranger' }), nameFor)).toBe('npub1stranger…')
  })

  it('accepts a caller-supplied self label for the composer chip\'s grammar', () => {
    // The chip reads "Replying to yourself"; the quote's byline reads "You". Same check, both forms.
    expect(quotedAuthorLabel(msg({ direction: 'sent' }), nameFor, 'yourself')).toBe('yourself')
  })

  it('keys on direction, NOT on the sender key matching anything', () => {
    // direction is the authority: a sent row is mine whatever its senderPubkeyHex says, which is
    // what lets this work without the helper knowing the viewer's identity at all.
    expect(quotedAuthorLabel(msg({ direction: 'sent', senderPubkeyHex: 'chrome' }), nameFor)).toBe('You')
    expect(quotedAuthorLabel(msg({ direction: 'received', senderPubkeyHex: 'chrome' }), nameFor)).toBe('Chrome')
  })
})

describe('quoteSnippet — one line, bounded', () => {
  it('collapses newlines and whitespace runs to single spaces', () => {
    expect(quoteSnippet('first\nsecond\n\nthird')).toBe('first second third')
    expect(quoteSnippet('spaced    out')).toBe('spaced out')
  })

  it('trims surrounding whitespace', () => {
    expect(quoteSnippet('  padded  ')).toBe('padded')
  })

  it('truncates past the budget with an ellipsis, and leaves shorter text alone', () => {
    expect(quoteSnippet('x'.repeat(200))).toBe(`${'x'.repeat(140)}…`)
    expect(quoteSnippet('short')).toBe('short')
  })

  it('measures the budget AFTER collapsing, not before', () => {
    // 200 newlines collapse to 100 spaces + 100 x's = 200 chars, so it still truncates — but the
    // result must be the collapsed form, never raw text with newlines sliced mid-run.
    const noisy = 'x\n'.repeat(100)
    const out = quoteSnippet(noisy, 10)
    expect(out).toBe('x x x x x…')
    expect(out).not.toContain('\n')
  })

  it('returns empty string for whitespace-only text (a captionless media row)', () => {
    expect(quoteSnippet(' ')).toBe('')
  })
})
