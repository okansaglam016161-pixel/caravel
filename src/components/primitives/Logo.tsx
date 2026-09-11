//   Logo — the Caravel mark.
//
//   ── IT IS GEOMETRY AGAIN, AND THAT IS A REVERSAL ────────────────────────────
//
//   This file used to be an <img> around two PNGs, and its reasoning was sound at the time: "the
//   design project ships it as artwork rather than as geometry — there is no SVG source to
//   transcribe, and redrawing artwork by eye is how a mark drifts." That premise is what changed.
//   The new mark ships AS PATHS on the design's own logo page, so there is a source, and it is
//   transcribed here rather than eyeballed — the `d` strings below are copied from that page
//   verbatim, not approximated from a picture.
//
//   What the reversal buys: one file instead of two assets, a mark that is crisp at every size and
//   on every display, no second HTTP request, and — the reason that actually matters — a mark that
//   takes its COLOUR FROM THE SURFACE rather than baking it in.
//
//   ── ONE MARK, TWO RENDERINGS, VIA currentColor ──────────────────────────────
//
//   The foundation allows exactly two: "accent blue on light, light on the vault. Never teal, never
//   gradients." With paths that is one component and a colour, not two files that can drift apart.
//   The default is the light mark — Caravel's shipped surfaces are mostly dark, and the brand tile
//   is always blue, so white is what sits on it. `--ink-on-accent` is the right token for that: it
//   is defined once and does NOT flip with the theme, which is what a mark on a blue tile needs.
//   `--text-bright` would have been the wrong choice for the same reason — it inverts in light mode.
//
//   ── TWO GRADES, AND WHERE THE LINE IS ───────────────────────────────────────
//
//   The mark is drawn twice by the design: a detailed grade, and a small grade that DROPS THE SEAM
//   and thickens the sail and mast (5.5 → 7, 6.5 → 7.5) so the shape survives when the strokes
//   stop resolving. A hairline that reads as craft at 64px reads as dirt at 16.
//
//   THE DESIGN DOES NOT PIN THE BOUNDARY. It draws the large grade at 512, 400, 64 and 32, and the
//   small grade only at 16 — so the switch is somewhere in between and the file says no more than
//   that. 24 is the midpoint, and it is also where the foundation puts the lockup's minimum size,
//   which makes it the least arbitrary place to put the line. Below 16 nothing should render at all:
//   the foundation's floor for the mark alone is 16px.

import type { CSSProperties } from 'react'

/**
 * The design's own viewBox. Width and height come from it, so the mark's proportions are the
 * artwork's rather than a number retyped here.
 */
const VIEW_BOX = '10 6 84 88'
const ASPECT = 84 / 88

/** Below this, the small grade. See the header — the design brackets it, it does not state it. */
const SMALL_GRADE_BELOW = 24

/** The wake. Identical in both grades: it is a filled shape, so thinning was never its problem. */
const WAKE = 'M14 87 C38 76 62 73 88 77 L84 84 C62 79.5 40 80.5 16 89 Z'
/** The sail's belly. Same outline in both grades; only the stroke weight changes. */
const SAIL = 'M43.2 16 C66 26 77 46 70 64 L32.6 66 Z'
/** The mast. The small grade runs it a little longer at both ends as it thickens. */
const MAST_LARGE = 'M44.5 11 L30.5 75'
const MAST_SMALL = 'M44.5 10 L30 76'
/** The seam across the belly — the detail the small grade drops. */
const SEAM = 'M39 42 C51 44 60.5 48.5 66 55'

interface LogoProps {
  /** Rendered height in px. Width follows the artwork's aspect ratio. */
  size?: number
  /** The accent-blue mark, for a LIGHT surface. Default is the light mark, for the vault and the
   *  brand tile. */
  onLight?: boolean
  /** Passed through. For the watermark call sites, which position the mark or drop its opacity. */
  style?: CSSProperties
}

export default function Logo({ size = 30, onLight = false, style }: LogoProps) {
  const small = size < SMALL_GRADE_BELOW
  return (
    <svg
      viewBox={VIEW_BOX}
      width={Math.round(size * ASPECT)}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{
        display: 'block', height: size, width: 'auto', flexShrink: 0,
        // The one place the treatment is chosen. Everything below inherits it.
        color: onLight ? 'var(--accent-400)' : 'var(--ink-on-accent)',
        ...style,
      }}
    >
      <path d={WAKE} fill="currentColor" />
      {/* The belly is the ink at 18%, which is what rgba(255,255,255,.18) was when the ink was
          always white — expressed as an opacity so it still holds when the ink is blue. */}
      <path
        d={SAIL}
        fill="currentColor"
        fillOpacity={0.18}
        stroke="currentColor"
        strokeWidth={small ? 7 : 5.5}
        strokeLinejoin="round"
      />
      <path
        d={small ? MAST_SMALL : MAST_LARGE}
        stroke="currentColor"
        strokeWidth={small ? 7.5 : 6.5}
        strokeLinecap="round"
      />
      {!small && <path d={SEAM} stroke="currentColor" strokeWidth={3} opacity={0.7} />}
    </svg>
  )
}
