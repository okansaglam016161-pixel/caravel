//   Shared style tokens for the pre-auth entry screens (Create / Unlock / Restore), so the card,
//   primary/disabled buttons, back button and page shell stay identical across all three.
//   Transcribed from the entry-flows design canvas; values map to the CSS custom properties.

import type { CSSProperties } from 'react'

export const MONO = 'var(--font-mono)'

// Base entry card: 428-wide, 18px radius, --surface. Callers add per-state padding + border.
export function entryCard(extra: CSSProperties = {}): CSSProperties {
  return {
    width: '100%',
    maxWidth: 428,
    boxSizing: 'border-box',
    borderRadius: 18,
    background: 'var(--surface)',
    ...extra,
  }
}

// Full-viewport centred backdrop shared by every entry screen (kept from the current app).
export const pageShell: CSSProperties = {
  minHeight: '100vh',
  background: 'radial-gradient(900px 460px at 50% 0%, #0C1A1B, #05080E 70%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '40px 24px',
}

// Primary CTA (teal gradient). Padding/fontSize overridable inline.
export const primaryBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 13,
  borderRadius: 12,
  width: '100%',
  boxSizing: 'border-box',
  border: 'none',
  fontSize: 14,
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: 'pointer',
  background: 'var(--teal-grad)',
  color: 'var(--ink-on-accent)',
}

// Disabled CTA — the design's explicit disabled treatment (not opacity).
export const disabledBtn: CSSProperties = {
  ...primaryBtn,
  background: 'rgba(16,21,31,0.6)',
  border: '1px solid rgba(var(--border-rgb),0.12)',
  color: 'var(--text-disabled)',
  cursor: 'default',
}

// Secondary CTA — surface-raised with a teal hairline (Copy all / Fix word / Try again).
export const secondaryBtn: CSSProperties = {
  ...primaryBtn,
  background: 'var(--surface-raised)',
  border: '1px solid rgba(var(--teal-500-rgb),0.26)',
  color: 'var(--text-bright)',
}

// Left "Back" button in a two-button row (fixed 110px).
export const backBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 110px',
  padding: 13,
  borderRadius: 12,
  border: '1px solid rgba(var(--border-rgb),0.2)',
  background: 'transparent',
  color: 'var(--text-muted)',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
}
