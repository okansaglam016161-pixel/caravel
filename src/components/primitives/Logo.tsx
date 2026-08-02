//   Logo — canonical Caravel sail mark (token-driven). Reproduces the current logo geometry
//   exactly, so the 4 hand-inlined copies (WalletModal, CreateWallet, UnlockWallet, Landing
//   footer) can migrate to this without any visual change. The "Logo Refresh" fingerprint
//   exploration is a separate, deliberate change for a later step — NOT adopted here.

import { useId } from 'react'

interface LogoProps {
  size?: number
  /** Flat variant — solid teal main sail (--teal-grad-top) instead of the gradient. Matches the
   *  entry-flows design canvas, which draws the mark flat. Default keeps the gradient brand mark. */
  flat?: boolean
  /** Mono variant — the whole mark in teal-500 with a 0.4 mid panel. Matches the landing-page
   *  design canvas (nav + footer marks). Takes precedence over `flat`. */
  mono?: boolean
}

export default function Logo({ size = 30, flat = false, mono = false }: LogoProps) {
  const gradId = useId()
  const mainFill = mono ? 'var(--teal-500, #2DE0C6)' : flat ? 'var(--teal-grad-top, #34E5D0)' : `url(#${gradId})`
  const midOpacity = mono ? 0.4 : 0.45
  return (
    <svg viewBox="0 0 44 44" width={size} height={size} aria-hidden="true">
      {!flat && !mono && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            {/* light sail stop is the legacy accent light (no design-scale token — kept literal) */}
            <stop offset="0" stopColor="var(--accL, #5CEAD6)" />
            <stop offset="1" stopColor="var(--teal-grad-bottom, #12A594)" />
          </linearGradient>
        </defs>
      )}
      <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill={mainFill} />
      <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="var(--teal-500, #2DE0C6)" opacity={midOpacity} />
      <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="var(--teal-500, #2DE0C6)" />
    </svg>
  )
}
