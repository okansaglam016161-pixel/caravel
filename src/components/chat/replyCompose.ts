// Pure logic for the quoted-reply UI (replies v1) — the sibling of messageEdit.ts, and kept out of
// the two chat views for the same reason: the DM composer and the group composer implement the same
// rules independently, and rules that live in render drift. Nothing here touches React, the store,
// or the wire.
//
// The one rule that MUST NOT drift is the interlock. Reply and edit both put a chip in the same slot
// above the composer, and edit additionally seizes the draft — so "which states may coexist" has to
// have exactly one answer for both views. Two inline `if`s in two files is how the DM thread and the
// group thread end up disagreeing about whether you can start a reply mid-edit.

import type { CaravelMessage } from '../../messaging/types'

// Which rows offer the Reply affordance. Note this is NOT mine-only — the whole point of a reply is
// to quote someone else — which is the one substantive way it differs from canEditMessage:
//   !system           — a group-leave notice has no prose to quote; its text is composed at render
//                       time from the sender's name, so there is nothing a quote could show.
//   logicalId present — the quote travels as a LOGICAL id, so a message sent before M2 has no handle
//                       a reply could name. Ages out on its own; the affordance is simply absent.
//   !payment          — v1 is text replies only. A payment row renders as PaymentMessageCard and
//                       never reaches the bubble that would carry the affordance.
//   !media            — likewise MediaMessageCard. Quoting an image is a real feature (it wants a
//                       thumbnail in the preview, not a text snippet) and is deliberately deferred
//                       rather than half-built.
//
// Both cards remain valid JUMP targets in Checkpoint C — being un-quotable is about what you can
// reply TO, not about what a quote can point at. A reply from a future client that quotes one is
// handled at render (see classifyQuoted) rather than assumed impossible.
export function canReplyTo(m: CaravelMessage): boolean {
  return !m.system
    && !!m.logicalId
    && !m.payment
    && !m.media
}

// The composer's two exclusive rich states. Both views hold these as separate `useState`s; this is
// the shared shape the interlock reads so neither can invent its own answer.
export interface ComposerState {
  editing: boolean
  replying: boolean
}

// SYMMETRIC INTERLOCK. Each state refuses to start while the other is active, and neither silently
// discards the other — the user cancels explicitly, via the Cancel already on both chips.
//
// Symmetry is the deliberate choice over the cheaper asymmetric alternative (let beginEdit quietly
// clear a pending reply, since a reply holds no draft to lose). Quietly clearing is fewer clicks but
// throws away stated intent with no acknowledgement: the user picked a message to quote, and the
// chip naming it would vanish because they touched a pencil. Refusing is predictable in both
// directions and never destroys a choice the user made.
export function canBeginReply(s: ComposerState): boolean {
  return !s.editing
}

export function canBeginEdit(s: ComposerState): boolean {
  return !s.replying
}

// What the quoted preview should render for a resolved (or unresolved) target.
//
// 'unavailable' is a NORMAL outcome, not an error: the original may never have reached us (relays do
// not federate and gift wraps backfill in arbitrary order), or may have been deleted since. Because
// the quote is resolved live on every render, an original that arrives late upgrades its own quotes
// from 'unavailable' to 'text' with no repair step.
//
// 'media' and 'payment' are unreachable from THIS client in v1 — canReplyTo refuses to create them —
// but a peer on a later version can send one, and a reader that cannot classify what it received
// would render a blank quote. Naming them costs two lines and removes that failure mode.
export type QuotedKind = 'text' | 'media' | 'payment' | 'unavailable'

export function classifyQuoted(target: CaravelMessage | undefined): QuotedKind {
  if (!target) return 'unavailable'
  if (target.payment) return 'payment'
  if (target.media) return 'media'
  // A system notice has no prose; treating it as unavailable is honest — there is no text to quote.
  if (target.system) return 'unavailable'
  return 'text'
}

// The author label for a quoted message — "You" for your own, the viewer's name for it otherwise.
//
// SHARED BY THE CHIP AND THE QUOTE, because the two disagreeing is not hypothetical: it shipped.
// The composer chip carried this check inline and the rendered quote did not, so composing a reply
// to your own group message said "Replying to yourself" while the sent bubble then rendered a quote
// labelled with your own RAW NPUB. Same screen, same message, two answers.
//
// The reason the bug is invisible in the main thread is worth recording, because it is why no
// existing test or view caught it: GroupThread builds a senderHeader ONLY on the received branch, so
// the main thread never renders the viewer's own name at all. The quote is the first surface that
// has to name the viewer — and `nicknames` is a map of PEER nicknames keyed under my own pubkey, so
// nicknames[myOwnKey] is never written by any code path and the lookup falls through to truncNpub().
//
// Taking a LABEL rather than returning a boolean is the anti-drift property: a predicate can be
// forgotten at a call site, whereas a function that returns the finished label cannot be called
// without getting the check. `selfLabel` is a parameter only because the two surfaces read
// differently — the chip is "Replying to <label>", where "yourself" is the grammatical form, while
// the quote's standalone byline wants "You".
//
// KNOWN GAP, NOT FIXED HERE — GROUP-ONLY MEMBERS HAVE NO NAME. `nameFor` resolves through the
// nickname map, and the only editor that writes it lives in the DM conversation header. A member you
// have met ONLY in a group — accepted, never messaged one-to-one — therefore has no way to acquire a
// nickname, and renders as a truncated npub in the quote AND in the main bubble alike. Note that
// contactStore holds no names either (state + timestamp only), so "saved as a contact" does not
// imply a resolvable name. Closing this needs a name source that is not the DM header (a per-member
// rename in the group roster, or adopting a profile/ONS name), which is its own feature.
export function quotedAuthorLabel(
  target: CaravelMessage,
  nameFor: (hex: string) => string,
  selfLabel = 'You',
): string {
  return target.direction === 'sent' ? selfLabel : nameFor(target.senderPubkeyHex)
}

// One-line snippet for the quote. Collapses ALL whitespace runs (newlines included) to single
// spaces, because a quote is a single line: a multi-line original would otherwise either blow the
// preview's height or be clipped mid-newline with the visible text ending arbitrarily.
//
// Truncation is belt-and-braces alongside the CSS clamp: the clamp handles the visual overflow, but
// an un-truncated 4000-character original still ships every one of those characters into the DOM for
// every rendered reply. `max` is a character budget, not a pixel one.
export function quoteSnippet(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  // trimEnd before the ellipsis: slicing mid-space otherwise yields "word …", with a gap the reader
  // reads as a missing word rather than as truncation.
  return `${oneLine.slice(0, max).trimEnd()}…`
}
