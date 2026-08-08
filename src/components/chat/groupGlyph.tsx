// Shared group glyph (people icon) rendered inside Avatar.icon — single source for the group thread
// header and the group conversation rows, so the two never drift.

import type { ReactNode } from 'react'

export const groupGlyph: ReactNode = (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx={9} cy={7} r={4} />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)
