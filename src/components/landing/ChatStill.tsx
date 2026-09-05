//   Chat, as a still — a short exchange in real V3 bubbles, and nothing else.
//
//   ── A TILE, NOT A WINDOW ─────────────────────────────────────────────────────
//
//   This began as a full thread: header with avatar, nickname and the encryption line, two bubbles,
//   a confidential-payment card, a composer with four controls. All of it faithful, and all of it
//   wrong for where it sits. The page already has ONE detailed picture of the product — the hero
//   mockup at the top, with the shell, the spine and the whole wallet page in it. A second detailed
//   picture two screens below does not add a second product; it splits the reader's attention and
//   makes the mockup look like a duplicate of itself.
//
//   So the showcase is a glance now: a short exchange, in and out and back. That is what a chat tile
//   beside one paragraph of copy has room to say, and the paragraph beside it — "private money and
//   private words, one conversation" — is carried by the middle bubble's own words rather than by
//   drawing the payment object underneath it.
//
//   THREE BUBBLES, NOT TWO, AND THE THIRD IS FOR THE ROW. Two left this tile noticeably shorter than
//   the balance hero across from it, and the services section reads as a set of peers — a tile that
//   is two thirds the height of its neighbour looks like the lesser feature rather than the shorter
//   graphic. A third message is the way to add that height without inventing anything: a reply
//   closing the exchange is what a real conversation does, where padding stuffed to the same effect
//   would just be a card full of air. It also lets the exchange RESOLVE, which two bubbles cannot —
//   the answer now lands.
//
//   WHAT WENT, and where it lives if it is wanted back: the thread header (Avatar, E2ELine,
//   ThreadMenuButton — all still exported from chat/, all still pure), the composer (the four
//   COMPOSER_* constants in threadChrome), and a hand-drawn approximation of the confidential-
//   payment card. The last of those is the only one that was not borrowed, and it is the only one
//   whose loss costs nothing to rebuild — the real card is a closure in ChatApp driven by a
//   ten-state union, so a still could never have reused it anyway.
//
//   ── WHY IT IS STILL A COMPONENT OVER A REAL BUBBLE ───────────────────────────
//
//   MessageBubble is what keeps this honest. It owns the V3 geometry — 14px in 10/14 padding, the
//   tail on the BOTTOM corner rather than the top, --msg-sent / --msg-received, and the meta line
//   under each bubble with the time and the sent tick. The hand-drawn pair this replaced had none
//   of that: it was the pre-V3 shape, in navy, with no meta row at all, and it stayed that way for
//   months because nothing compiled it. Three bubbles is little enough to hand-draw and exactly
//   little enough to get quietly wrong.
//
//   THEME-FOLLOWING, unlike the navy card this replaced. Chat stopped being pinned dark in the V3
//   pass, so on the default light theme this is a white tile. There is no dark island left here —
//   the payment card was the only thing that earned one.
//
//   INERT, like WalletStill beside it. Nothing in a picture should take focus or a click; the
//   attribute also removes the subtree from the accessibility tree, which is right for decoration.

import MessageBubble from '../chat/MessageBubble'
import { THREAD_SCROLLER } from '../chat/threadChrome'

// TIMES ARE DERIVED, NOT LITERAL. MessageBubble prints them through toLocaleTimeString, so a
// hardcoded epoch would read 03:14 for a visitor in Sydney — not a plausible dinner conversation.
// Offsets from load keep it recent in the reader's own locale, wherever they are.
const now = Date.now()
const MIN = 60_000

export default function ChatStill() {
  return (
    <div inert style={{
      pointerEvents: 'none',
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 18, boxShadow: 'var(--e1)',
    }}>
      {/* THREAD_SCROLLER for the column and the 12px message gap — the app's spacing between
          bubbles, which is the part that would drift. Its padding is overridden: 18/24 is the
          measurement of a full-height thread pane, and this is a tile that has to sit at the same
          visual weight as the balance hero across the row from it. The two other overrides are
          what make it a still — there is nothing to scroll, and no flex parent to weigh against. */}
      <div style={{ ...THREAD_SCROLLER, flex: 'none', overflowY: 'visible', padding: 24 }}>
        <MessageBubble variant="received" text="Dinner was on me last time. Your turn." timestamp={now - 6 * MIN} />
        <MessageBubble variant="sent" text="Fair. Sending it now, privately." timestamp={now - 5 * MIN} />
        <MessageBubble variant="received" text="Got it. Thanks!" timestamp={now - 4 * MIN} />
      </div>
    </div>
  )
}
