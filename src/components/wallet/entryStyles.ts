//   Shared style tokens for the pre-auth entry screens (Create / Unlock / Restore), so the card,
//   primary/disabled buttons, back button and page shell stay identical across all three.
//   Values map to the CSS custom properties in src/index.css (v0.3 Foundation).

import type { CSSProperties } from 'react'

export const MONO = 'var(--font-mono)'

// Base entry card: 428-wide, xl radius, --surface. Callers add per-state padding + border.
export function entryCard(extra: CSSProperties = {}): CSSProperties {
  return {
    width: '100%',
    maxWidth: 428,
    boxSizing: 'border-box',
    borderRadius: 'var(--r-xl)',
    background: 'var(--surface)',
    // The card needs to lift off the backdrop in light, where both are near-white. Free in dark,
    // where --e2 is a shadow nobody sees against navy.
    boxShadow: 'var(--e2)',
    ...extra,
  }
}

// Full-viewport centred backdrop shared by every entry screen.
//
// THE GRADIENT READS ROLE TOKENS, NOT THE NAVY SCALE. It used to be navy-800 → navy-950, which is
// theme-independent by design and so stayed dark under a light theme — a light card marooned on a
// navy field, which looks more broken than either theme alone. Surface tokens give the same quiet
// lift from the centre in both.
export const pageShell: CSSProperties = {
  minHeight: '100vh',
  background: 'radial-gradient(900px 460px at 50% 0%, var(--surface-raised), var(--surface-void) 70%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '40px 24px',
}

// Primary CTA — flat accent, not a gradient (the foundation forbids brand gradients).
// Padding/fontSize overridable inline.
export const primaryBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 13,
  borderRadius: 'var(--r-md)',
  width: '100%',
  boxSizing: 'border-box',
  border: 'none',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  background: 'var(--accent-400)',
  color: 'var(--ink-on-accent)',
}

// Disabled CTA — the design's explicit disabled treatment (not opacity).
//
// `--surface-inset`, NOT `--surface-raised`: in light both the card and `raised` resolve to white,
// so a raised button on a card would be an invisible control. `inset` steps away from the card in
// BOTH themes, which is the only property that matters here.
export const disabledBtn: CSSProperties = {
  ...primaryBtn,
  background: 'var(--surface-inset)',
  border: '1px solid var(--border)',
  color: 'var(--text-disabled)',
  cursor: 'default',
}

// Secondary CTA — a step off the card with a strong hairline (Copy all / Fix word / Try again).
// `inset` for the same reason as the disabled button: `raised` is the card's own colour in light.
export const secondaryBtn: CSSProperties = {
  ...primaryBtn,
  background: 'var(--surface-inset)',
  border: '1px solid var(--border-strong)',
  color: 'var(--text-primary)',
}

// Left "Back" button in a two-button row (fixed 110px).
export const backBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 110px',
  padding: 13,
  borderRadius: 'var(--r-md)',
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--accent-300)',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
}
