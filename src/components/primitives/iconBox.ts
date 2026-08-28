// The boxed icon control — one box, several emblems.
//
// The wallet header carries three of these side by side: hide-balance, refresh, and light/dark.
// They are three different components (the theme toggle is shared with the landing page and owns
// its own state; the other two are wallet concerns), which is exactly the arrangement that ends up
// drawing three subtly different boxes — a border here, a radius there — in the same row.
//
// So the BOX lives here and the components supply only their emblem. If the row is to look like
// one control repeated, its geometry has to be written down once.

import type { CSSProperties } from 'react'

/**
 * `size` is the square edge. 36 in the landing's top bar, 30 in the wallet header — the emblem
 * scales with it at the call site, the box does not need to know.
 */
export function iconBoxStyle(size: number): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: size, height: size, borderRadius: 'var(--r-md)',
    border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--text-body-dim)',
    cursor: 'pointer', flexShrink: 0, padding: 0, userSelect: 'none',
  }
}
