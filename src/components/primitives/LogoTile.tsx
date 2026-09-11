//   LogoTile — the Caravel mark on its brand tile.
//
//   ── THE TILE IS THE UNIT, AND IT HAD NO COMPONENT ───────────────────────────
//
//   Four surfaces drew this by hand: the nav spine's home button, the entry screens' lockup, the
//   landing page's lockup, and the mini-spine inside the landing's hero mockup. Four copies of one
//   composite, and they had already drifted — radii of 30%, 30%, 28% and 31% of the tile, chosen by
//   eye rather than by rule. Nothing held them together because the thing they all drew was never a
//   thing in the codebase; only the mark inside it was.
//
//   ── THE PROPORTIONS ARE THE DESIGN'S, NOT ROUNDED BY EYE ────────────────────
//
//   Both numbers below are read off the design's own tile renderings rather than invented:
//
//     RADIUS is 22.5% of the tile. The design draws 512→115, 400→90, 64→14, 32→7, 16→4; this
//     formula reproduces every one of those exactly. The hand-built tiles were nearer 30%, which is
//     why the new tile reads squarer than the one it replaces.
//
//     THE MARK IS 108.2% OF THE TILE, and that is the part that looks wrong until you see it: the
//     sail and the wake BLEED PAST THE EDGES and are clipped. There is no inset, no inner circle,
//     no margin of blue around the artwork — the design is explicit that the mark runs to the edge.
//     The ratio comes from the two master exports (554/512 and 433/400, which agree to four
//     decimals) and it reproduces the design's 32px tile exactly at 35px.
//
//   ── THE GRADE LOOKS AFTER ITSELF ────────────────────────────────────────────
//
//   Logo switches grade on its own height, so a tile does not choose one. That lands on the
//   design's data points without being told to: a 32px tile asks for a 35px mark and gets the large
//   grade, and a 16px tile asks for 18px and gets the small one — which is precisely where the
//   design draws each. Nothing here needs to know the boundary exists.
//
//   ── IT IS A BUTTON ONLY WHEN IT DOES SOMETHING ──────────────────────────────
//
//   Two of the four sites are the way back to the landing page; two are pictures. Passing `onClick`
//   is what makes this a <button> with the tile hover and the focus ring — omit it and every one of
//   those affordances goes at once, rather than leaving a control that looks live and does nothing.
//   Same rule the assets row keys on, and the same reason.

import type { CSSProperties } from 'react'
import Logo from './Logo'

/** Corner radius as a fraction of the tile. Reproduces 512→115, 400→90, 64→14, 32→7, 16→4. */
const RADIUS_RATIO = 0.225
/** Mark height as a fraction of the tile. From the 512 and 400 masters; the mark bleeds and clips. */
const MARK_RATIO = 1.082

interface LogoTileProps {
  /** The TILE's size in px. The mark's height derives from it — there is no second number. */
  size: number
  /** Makes it a button, with the tile hover and focus ring. Omit for a decorative tile. */
  onClick?: () => void
  /** The accessible name, used for `title` too. Required when `onClick` is given. */
  label?: string
  style?: CSSProperties
}

export default function LogoTile({ size, onClick, label, style }: LogoTileProps) {
  const tile: CSSProperties = {
    width: size, height: size, flexShrink: 0,
    borderRadius: Math.round(size * RADIUS_RATIO),
    background: 'var(--accent-400)',
    // THE CLIP IS LOAD-BEARING. The mark is larger than the tile by design; without this the sail
    // and wake hang outside it.
    overflow: 'hidden',
    // INLINE-flex, AND THE DISTINCTION MATTERS ON ONE SURFACE. The entry card (welcome, unlock) is
    // a plain block that centres its contents with `text-align: center` — so a block-level tile
    // ignores it and sits hard against the left edge while the heading and fields below are
    // centred. An inline-level box is text-aligned like everything else in that card. The tile the
    // entry screen used to hand-build was `inline-flex` for exactly this reason; collapsing the
    // four copies into one component is where that got lost.
    //
    // IT COSTS THE OTHER THREE SITES NOTHING. They all place this inside a flex container, and a
    // flex item's display is blockified — inline-flex computes to flex — so the spine, the landing
    // lockup and the hero mini-spine render identically either way.
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    ...style,
  }

  // The mark takes Logo's default treatment — the light mark — because this tile is always the
  // brand blue, in either theme. That is why Logo's default resolves to a token that does not flip.
  const mark = <Logo size={Math.round(size * MARK_RATIO)} />

  if (!onClick) return <span style={tile}>{mark}</span>

  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="cv-accent-tile"
      style={{ ...tile, padding: 0, border: 'none', cursor: 'pointer' }}
    >
      {mark}
    </button>
  )
}
