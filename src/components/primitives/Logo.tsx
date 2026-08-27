//   Logo — the Caravel mark, v0.3 "Foundation".
//
//   ── WHY THIS IS AN <img> AND NO LONGER AN INLINE SVG ────────────────────────
//
//   The old mark was drawn here as three hand-authored paths ("Full Sail") in three teal
//   treatments. v0.3 replaces the mark itself, and the design project ships it as artwork rather
//   than as geometry — assets/logo-blue.png and assets/logo-light.png. There is no SVG source to
//   transcribe, and redrawing artwork by eye is how a mark drifts, which is exactly what the old
//   header of this file warned against. So the artwork IS the source, vendored into public/.
//
//   ── ONE TOKEN COLOUR PER SURFACE ────────────────────────────────────────────
//
//   The foundation allows exactly two renderings: "accent blue on light, light on the vault.
//   Never teal, never gradients." So there are two assets and no tinting — the colour is baked in,
//   which is the point. Caravel's shipped surfaces are all dark, so the LIGHT mark is the default.
//
//   ── THE PROPS SURVIVE, THE VARIANTS COLLAPSE ────────────────────────────────
//
//   `flat` and `mono` existed to pick between three teal treatments of one shape. v0.3 has two
//   renderings chosen by SURFACE, not by emphasis, so both props now resolve to the same light
//   mark. They are kept rather than removed so this pass stays a reskin: eleven call sites across
//   the landing page, chat and the entry flows pass them, and rewriting those is composition work.
//   Deprecated — new code should pass `onLight` instead.

import type { CSSProperties } from 'react'

/** The mark's intrinsic aspect ratio (358 x 401 artwork), so width follows from height. */
const ASPECT = 358 / 401

interface LogoProps {
  /** Rendered height in px. Width follows the artwork's aspect ratio. */
  size?: number
  /** @deprecated v0.3 has one mark per surface, not three treatments. Resolves to the light mark. */
  flat?: boolean
  /** @deprecated As `flat`. Resolves to the light mark. */
  mono?: boolean
  /** Use the accent-blue mark, for placement on a LIGHT surface. Default is the light mark, for
   *  the vault and for the accent tile in the nav rail. */
  onLight?: boolean
  /** Passed through to the <img>. For the watermark call sites, which position the mark or render
   *  it at low opacity (landing donation card, empty chat pane, empty Activity list). */
  style?: CSSProperties
}

export default function Logo({ size = 30, onLight = false, style }: LogoProps) {
  return (
    <img
      src={onLight ? '/logo-blue.png' : '/logo-light.png'}
      alt=""
      aria-hidden="true"
      width={Math.round(size * ASPECT)}
      height={size}
      style={{ display: 'block', height: size, width: 'auto', flexShrink: 0, ...style }}
    />
  )
}
