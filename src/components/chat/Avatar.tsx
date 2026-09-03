// The identity tile shared by DM + group views. `icon` is a group-only variant (renders a glyph
// instead of initials) and is never passed by the DM view.
//
// `bg` / `fg` OVERRIDE THE ICON VARIANT'S FILL, and default to what it always drew, so every
// existing call site renders exactly as before. V3's conversation list wants its group tile quiet
// — --msg-received behind --text-body-dim — where the thread header still wants the accent fill.
// One prop pair says that; the alternative was a second component, or the list hand-rolling a tile
// the way the request card already does, which is how two copies of one glyph start to drift.
// The glyph itself takes `currentColor`, which is what makes `fg` reach it.

import type { ReactNode } from 'react'
import { avatarFor, initialsFor } from './chatDisplay'

export default function Avatar({ hex, nickname, size = 42, radius = 12, fontSize = 16, icon, bg, fg }: {
  hex?: string
  nickname?: string
  size?: number
  radius?: number
  fontSize?: number
  icon?: ReactNode
  /** Icon-variant fill. Defaults to the accent tile the group thread header uses. */
  bg?: string
  /** Icon-variant ink, reaching the glyph through `currentColor`. */
  fg?: string
}) {
  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: radius, display: 'flex',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }
  if (icon) {
    return <div style={{ ...base, background: bg ?? 'var(--accent-400)', color: fg ?? 'var(--ink-on-accent)' }}>{icon}</div>
  }
  const av = avatarFor(hex ?? '')
  return <div style={{ ...base, background: av.grad, fontSize, fontWeight: 700, color: av.color }}>{initialsFor(nickname)}</div>
}
