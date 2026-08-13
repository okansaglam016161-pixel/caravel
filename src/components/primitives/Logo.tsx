//   Logo — canonical Caravel sail mark (token-driven): the "Full Sail" geometry from the
//   Logo Refinement design — one dominant mainsail plus a small jib. This is the ONLY copy
//   of the mark in the app; every surface (chat header, landing nav/footer/watermarks,
//   entry flows, wallet modal) renders through it, so the shape can never drift again.
//   The "Logo Refresh" fingerprint exploration remains a separate direction — NOT adopted.

import type { CSSProperties } from 'react'
import { useId } from 'react'

interface LogoProps {
  size?: number
  /** Flat variant — solid teal main sail (--teal-grad-top) instead of the gradient. Matches the
   *  entry-flows design canvas, which draws the mark flat. Default keeps the gradient brand mark. */
  flat?: boolean
  /** Mono variant — the whole mark in teal-500 with a 0.4 jib. Matches the landing-page
   *  design canvas (nav + footer marks). Takes precedence over `flat`. */
  mono?: boolean
  /** Passed through to the <svg>. For the watermark call sites, which position the mark or
   *  render it at low opacity (landing donation card, empty chat pane, empty Activity list). */
  style?: CSSProperties
}

export default function Logo({ size = 30, flat = false, mono = false, style }: LogoProps) {
  const gradId = useId()
  const mainFill = mono ? 'var(--teal-500, #2DE0C6)' : flat ? 'var(--teal-grad-top, #34E5D0)' : `url(#${gradId})`
  const midOpacity = mono ? 0.4 : 0.45
  return (
    <svg viewBox="0 0 44 44" width={size} height={size} style={style} aria-hidden="true">
      {!flat && !mono && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            {/* light sail stop is the legacy accent light (no design-scale token — kept literal) */}
            <stop offset="0" stopColor="var(--accL, #5CEAD6)" />
            <stop offset="1" stopColor="var(--teal-grad-bottom, #12A594)" />
          </linearGradient>
        </defs>
      )}
      {/* mainsail */}
      <path d="M20 3 C 33 8 37 22 36 31 L 20 31 Z" fill={mainFill} />
      {/* jib — small headsail forward of the mast */}
      <path d="M15.5 12 C 11 17 8.5 25 8.5 31 L 15.5 31 Z" fill="var(--teal-500, #2DE0C6)" opacity={midOpacity} />
      {/* hull */}
      <path d="M5 35 L 39 35 L 33.5 41 L 10.5 41 Z" fill="var(--teal-500, #2DE0C6)" />
    </svg>
  )
}
