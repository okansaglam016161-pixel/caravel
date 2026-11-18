// Plain values for the list cards (listRows.tsx) — kept out of the component module so it exports
// components only.

import type { CSSProperties } from 'react'

/** An inline text action inside a row — Grant, Unlock, Connect. */
export const linkBtn: CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  fontSize: 12.5, fontWeight: 600, color: 'var(--accent-400)', fontFamily: 'inherit',
}

/** `otl_1u6fr8…0m3c863h`: the first 10 and last 8 characters. Copy always takes the full value. */
export function shortenMiddle(value: string): string {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value
}
