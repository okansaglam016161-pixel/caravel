// The quoted-original preview shown above a reply's bubble (replies v1).
//
// RESOLVED LIVE, from a Map the view builds once per render pass. Two consequences that are the
// whole reason the wire carries a bare id instead of a copy of the text:
//   - an EDITED original updates its own quotes, everywhere, with no repair step;
//   - a MISSING original renders an honest placeholder instead of a stale snippet, and upgrades
//     itself to the real quote the moment the original arrives (relays do not federate and gift
//     wraps backfill in arbitrary order, so a reply outrunning its original is routine).
//
// The Map — not `messages.find()` per row — because the store is ONE flat array holding every
// thread's messages: resolving per rendered reply is O(rows × replies) on that array, and a long
// thread pays it on every keystroke in the composer.
//
// Presentational only. Which rows may be replied to (canReplyTo) and what a target resolves to
// (classifyQuoted) live in replyCompose.ts, so the DM and group views cannot drift on either.

import { MONO } from './chatDisplay'
import { classifyQuoted, quotedAuthorLabel, quoteSnippet } from './replyCompose'
import type { CaravelMessage } from '../../messaging/types'

// The quote panel must contrast with the BUBBLE IT SITS IN, not with the thread background — it is
// nested inside the bubble, so the bubble is its backdrop. That makes two palettes necessary rather
// than one:
//
//   'on-dark'   — inside a received or notes-to-self bubble (--surface-inset). An accent-tinted
//                 panel with accent-leaning text, which ties the quote to the colour used for
//                 quoting elsewhere in the UI. Its tokens are theme-aware, so it follows the app.
//   'on-accent' — inside a SENT bubble (--msg-sent). The same accent panel would be accent-on-accent:
//                 present, but barely legible. A translucent WHITE panel with white text inverts it,
//                 which is the arrangement WhatsApp and Signal both settled on and for the same
//                 reason — and it is what the V3 design draws (its REPLY · QUOTED PREVIEW panel is
//                 rgba(255,255,255,.14) behind a rgba(255,255,255,.6) rule).
//
// THE 'on-accent' VALUES ARE DELIBERATELY THEME-INVARIANT. --msg-sent is the brand blue in both
// themes (the light block never restates it), so the surface this palette contrasts against does
// not move, and neither should the ink on it. This is the one place in chat where a literal is the
// correct answer rather than a missing token. The white alphas sit on a lighter blue since the
// bubble took the design's accent-400 — still legible, but this is the palette to check first if
// the quote inside a sent bubble is ever reported as washed out.
//
// It was 'on-teal', over a teal gradient bubble, with pale-mint ink. The bubble is flat cobalt now.
//
// Both keep the left rule; only its colour flips, because an accent rule on accent is invisible.
// Both stay SUBORDINATE to the reply's own text — a quote is context, not content.
type QuoteTone = 'on-dark' | 'on-accent'

const PALETTE: Record<QuoteTone, { rule: string; bg: string; body: string; author: string; muted: string }> = {
  'on-dark': {
    rule: '2px solid rgba(var(--accent-400-rgb),0.45)',
    bg: 'rgba(var(--accent-400-rgb),0.05)',
    body: 'var(--text-muted)',
    author: 'var(--text-accent-dim)',
    muted: 'var(--text-faint-dim)',
  },
  'on-accent': {
    // A white recess in the accent, per the design. The panel lightens rather than darkens: on
    // --accent-600 a dark inset reads as a hole punched in the bubble, a light one as a quoted
    // slab lying on it.
    rule: '2px solid rgba(255,255,255,0.6)',
    bg: 'rgba(255,255,255,0.14)',
    // Deliberately BELOW the bubble text's --text-bright, so the quote stays secondary to the reply
    // it belongs to while remaining comfortably readable.
    body: 'rgba(255,255,255,0.82)',
    author: 'rgba(255,255,255,0.95)',
    muted: 'rgba(255,255,255,0.6)',
  },
}

export default function QuotedPreview({ replyTo, byLogicalId, nameFor, onJump, tone = 'on-dark' }: {
  replyTo: string
  // logicalId → message, built once per render pass by the view (useMemo).
  byLogicalId: Map<string, CaravelMessage>
  // GROUPS ONLY. Supplied by GroupThread to name the quoted author; omitted by the DM view, where
  // there are only two participants and a name on every quote is noise rather than information.
  nameFor?: (hex: string) => string
  // Checkpoint C wires this to scroll-to + flash. Undefined here means the quote is inert, which is
  // also the correct permanent state for an unresolved target — there is nothing to jump to.
  onJump?: (logicalId: string) => void
  // Which bubble this quote is nested in. Defaults to 'on-dark': that covers received and
  // notes-to-self, so only the sent call sites have to say anything.
  tone?: QuoteTone
}) {
  const c = PALETTE[tone]
  const target = byLogicalId.get(replyTo)
  const kind = classifyQuoted(target)

  // An unresolved quote is NOT hidden. Dropping it would silently turn a reply into an ordinary
  // message and lose the fact that it was answering something — the reader would see a non-sequitur
  // with no explanation. The placeholder says what happened and stays put.
  const unavailable = kind === 'unavailable'

  const body =
    kind === 'text' ? quoteSnippet(target!.plaintext)
    : kind === 'media' ? 'Photo'
    : kind === 'payment' ? 'Payment'
    : 'Original unavailable'

  const jumpable = !unavailable && !!onJump

  return (
    <div
      onClick={jumpable ? () => onJump!(replyTo) : undefined}
      // Inert when there is nothing to jump to, so the cursor never promises an action that does
      // not exist. Same reason the placeholder is not a button.
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxWidth: '100%',
        minWidth: 0,
        marginBottom: 4,
        padding: '5px 10px',
        borderLeft: c.rule,
        borderRadius: '4px 8px 8px 4px',
        background: c.bg,
        cursor: jumpable ? 'pointer' : 'default',
        opacity: unavailable ? 0.72 : 1,
      }}
    >
      {/* Author line — groups only. In a DM the quote's author is unambiguous (it is one of the two
          people in the thread), so naming it on every quote adds a line of chrome and no meaning. */}
      {nameFor && target && !unavailable && (
        <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 600, color: c.author, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {quotedAuthorLabel(target, nameFor)}
        </span>
      )}
      <span
        style={{
          fontSize: 12.5,
          lineHeight: 1.35,
          color: unavailable ? c.muted : c.body,
          fontStyle: unavailable ? 'italic' : undefined,
          // One line, clipped with an ellipsis. quoteSnippet has already collapsed newlines and
          // bounded the length; this bounds the WIDTH, which the character budget cannot know.
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {body}
      </span>
    </div>
  )
}
