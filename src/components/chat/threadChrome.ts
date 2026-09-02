//   The thread frame's measurements, shared by the DM view and the group view.
//
//   ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
//
//   ChatApp's DM thread and GroupThread draw the same frame and drew it twice. An audit before
//   this stage found TWENTY-THREE pairs of duplicated inline literals across the two files — the
//   header bar, its left cluster, the ⋯ button, the scrim, the dropdown panel, the scroll
//   container, the empty state, the edit chips — every one of which had to be edited in both
//   places or drift.
//
//   IT HAD ALREADY DRIFTED. The same audit found FOUR different wordings of the end-to-end
//   encryption claim, in two different hyphenations, across the two files: a header line, an
//   in-thread pill, an empty-state pill, and the group composer's footer. Nobody decided that;
//   it is what happens when one sentence lives in four literals.
//
//   THE SAME REASONING AS chatDisplay.ts, whose ACTION_BTN comment puts it best: "one object, in
//   the module both views already share, so the two buttons cannot drift apart visually — they
//   sit side by side in the same row, where a 1px difference reads as a mistake."
//
//   ── THIS FILE IS .ts; ThreadFrame.tsx HOLDS ITS COMPONENTS ───────────────────
//
//   A module exporting BOTH constants and components loses fast refresh for everything in it
//   (oxlint react/only-export-components), and stages 4-5 will edit these files constantly. So
//   the measurements live here and the three components that use them live next door — the same
//   arrangement chatDisplay.ts already has with the components that read it.

import type { CSSProperties } from 'react'

// ── Header ──────────────────────────────────────────────────────────────────────

export const THREAD_HEADER: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 11, padding: '13px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0,
}

export const HEADER_LEFT: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 11, minWidth: 0,
}

export const THREAD_TITLE: CSSProperties = {
  fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

// ── The ⋯ menu ──────────────────────────────────────────────────────────────────

/**
 * MENU_TOP TRACKS THE BUTTON. The dropdown is positioned by hand rather than by popoverFit — it
 * has a fixed anchor at the header's right edge and never needs flipping — so its offset is the
 * button's height plus a gap, and the two must move together. They were 36 and 42, in four
 * hand-kept places. Deriving one from the other is what keeps them true the next time the button
 * resizes.
 */
export const MENU_BTN = 28
export const MENU_TOP = MENU_BTN + 6

export const MENU_SCRIM: CSSProperties = { position: 'fixed', inset: 0, zIndex: 40 }

export const MENU_PANEL: CSSProperties = {
  position: 'absolute', top: MENU_TOP, right: 0, zIndex: 41, minWidth: 200, padding: 6,
  borderRadius: 11, background: 'var(--surface-raised)',
  border: '1px solid var(--border)', boxShadow: 'var(--e3)',
}

/** A row in the ⋯ dropdown. Callers pick the ink; the geometry is shared. */
export const MENU_ITEM: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
  padding: '8px 10px', borderRadius: 8, border: 'none', background: 'transparent',
  fontSize: 13, fontWeight: 600, textAlign: 'left', fontFamily: 'inherit',
}

// ── Bubbles ─────────────────────────────────────────────────────────────────────

/**
 * The line under a bubble: time, an optional "edited", and — on a sent one — a tick.
 *
 * THREE COMPONENTS DRAW IT — MessageBubble in three variants, MediaMessageCard, and PendingBubble —
 * and before this they drew it three different ways, two of them in mono at different colours. It
 * sits directly under bubbles that are now identical, where a 1px or one-shade difference reads as
 * a mistake. V3 sets it in the UI face; the mono was a teal-era habit.
 */
export const BUBBLE_META: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5,
  fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 4,
}

// ── Composer ────────────────────────────────────────────────────────────────────

/** The bar the composer sits in, under the thread. */
export const COMPOSER_SHELL: CSSProperties = {
  padding: '12px 18px 16px', borderTop: '1px solid var(--border)', flexShrink: 0,
}

/**
 * ONE CARD, holding the input row and — when they are up — the reply chip or editing banner.
 *
 * V3 puts those two INSIDE this border rather than floating them above it as separate bordered
 * blocks. It is the difference between "the composer is in a state" and "there is a notice near
 * the composer", and the first is what both of them actually mean.
 *
 * NO `overflow: hidden` HERE, EVER. It was here briefly, to make the chip's border-bottom sit
 * flush inside this radius, and it took the emoji picker out with it: the picker's containing
 * block is the `position: relative` wrapper around its button, which lives INSIDE this card, and
 * an absolutely-positioned box is clipped by any ancestor with overflow between it and its
 * containing block. The panel opens ABOVE the button, so it was clipped away entirely — and no
 * z-index rescues that, because clipping is not a stacking question. The chip rounds its own top
 * corners instead (COMPOSER_CHIP_RADIUS), which is what the clip was for.
 */
export const COMPOSER_CARD: CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 13,
  background: 'var(--surface)', boxShadow: 'var(--e1)',
}

/** The card's radius less its 1px border — what a flush first child has to round itself to. */
export const COMPOSER_CHIP_RADIUS = 12

export const COMPOSER_ROW: CSSProperties = {
  display: 'flex', alignItems: 'flex-end', gap: 8, padding: '9px 10px',
}

/**
 * THREE WEIGHTS IN ONE ROW, and the order matters.
 *
 * Send is the hero — a solid accent tile, because it is the action taken a hundred times a
 * session. Attach and emoji are bare icons. The `$` sits between them: an accent wash with an
 * accent ring, one notch above its neighbours and clearly below send. V3 draws it flat with the
 * other two; it is louder here because stage 2 took the balance pill and the wallet modal out of
 * chat, so this unlabelled glyph is now the ONLY payment entry point in a conversation, and
 * burying it would hide the feature rather than merely quiet it.
 */
export const COMPOSER_BTN = 30
export const COMPOSER_SEND = 34

export const COMPOSER_ICON_BTN: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: COMPOSER_BTN, height: COMPOSER_BTN, flexShrink: 0, padding: 0,
  borderRadius: 9, border: 'none', background: 'transparent',
  color: 'var(--text-muted-dim)', cursor: 'pointer',
}

/**
 * How far the emoji picker floats above the button it is anchored to.
 *
 * DERIVED, BECAUSE THE LITERAL ROTTED ONCE ALREADY. EmojiPicker's `offset` defaulted to 54 — which
 * was the old 46px button plus an 8px gap — and neither composer passed one, so shrinking the
 * button would have left the picker floating 16px off its anchor with nothing erroring. Both call
 * sites now pass this explicitly. ReactionQuickSet keeps its own OFFSET: that anchor is a 26px
 * action button inside the thread, a different measurement entirely.
 */
export const COMPOSER_POPOVER_OFFSET = COMPOSER_BTN + 8

// ── The message list ────────────────────────────────────────────────────────────

/**
 * The scroll container's LOOK. The ELEMENT stays in each view, and so must two things on it: its
 * own `ref` (useJumpToMessage) and `data-popover-bounds`.
 *
 * THE ATTRIBUTE MUST SIT ON THE ELEMENT THAT ACTUALLY SCROLLS. popoverFit resolves a popover's
 * clamping box with `el.closest('[data-popover-bounds]')`, and its no-bounds fallback is the
 * VIEWPORT — so moving the attribute onto a wrapper would not throw, it would silently misplace
 * every reaction panel. That is why this is a style and not a component: a component here would
 * invite exactly that move.
 *
 * NO `transform` ON THIS ELEMENT, EVER. A transform establishes a new containing block for
 * absolutely-positioned descendants, which is what every reaction popover is; the panels would
 * shift by the scroller's offset, again with nothing erroring.
 */
export const THREAD_SCROLLER: CSSProperties = {
  flex: 1, overflowY: 'auto', padding: '18px 24px',
  display: 'flex', flexDirection: 'column', gap: 12,
}

/**
 * The quiet centred line: notes-to-self, an exchanged payment address, a group system notice.
 *
 * ONE TREATMENT FOR "CONTEXT, NOT CONTENT". These were three different one-off styles — a
 * bordered pill, an accent-tinted banner and a bare centred span — for three facts that are all
 * the same kind of thing: something true about this thread that you do not need to act on. The
 * one that IS actionable, an unverified address, deliberately does not use this; it keeps a full
 * warning banner, because the whole point of quieting the rest is that the loud thing means
 * something when it appears.
 */
export const THREAD_META_LINE: CSSProperties = {
  alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 6,
  maxWidth: '90%', padding: '2px 0', fontSize: 11.5, lineHeight: 1.45,
  color: 'var(--text-muted-dim)', textAlign: 'center',
}
