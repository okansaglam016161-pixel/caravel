//   Shared style tokens for the pre-auth entry screens (Create / Unlock / Restore), so the card,
//   primary/disabled buttons, back button and page shell stay identical across all three.
//   Values map to the CSS custom properties in src/index.css (v0.3 Foundation).

import type { CSSProperties } from 'react'

export const MONO = 'var(--font-mono)'

// Base entry card. One card, centred on the page surface, in every gate screen.
export function entryCard(extra: CSSProperties = {}): CSSProperties {
  return {
    width: '100%',
    maxWidth: 428,
    boxSizing: 'border-box',
    borderRadius: 16,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    // The card needs to lift off the backdrop in light, where both are near-white. Free in dark,
    // where --e2 is a shadow nobody sees against navy.
    boxShadow: 'var(--e2)',
    ...extra,
  }
}

/** The accent tile the welcome and unlock screens wear above their heading. */
export const logoTile: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 13, background: 'var(--accent-400)',
}

/** A field surface: the page ground inset into the card, so it reads as a well in both themes. */
export const fieldSurface: CSSProperties = {
  background: 'var(--surface-void)',
  border: '1px solid var(--border-strong)',
  borderRadius: 9,
}

/** One word of a recovery phrase, numbered. */
export const wordChip: CSSProperties = {
  ...fieldSurface,
  border: '1px solid var(--border)',
  padding: '6px 9px',
  borderRadius: 7,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-primary)',
  display: 'flex',
  gap: 6,
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
  padding: 10,
  borderRadius: 9,
  width: '100%',
  boxSizing: 'border-box',
  border: 'none',
  fontSize: 13,
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
  padding: 10,
  borderRadius: 9,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--accent-300)',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
}
