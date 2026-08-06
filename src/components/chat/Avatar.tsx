// The identity tile shared by DM + group views. Reproduces the exact inline avatar markup used in
// the DM header (42/12/16) and DM list rows (46/13/16). `icon` is a group-only variant (renders a
// glyph on the teal gradient instead of initials) and is never passed by the DM view.

import type { ReactNode } from 'react'
import { avatarFor, initialsFor } from './chatDisplay'

export default function Avatar({ hex, nickname, size = 42, radius = 12, fontSize = 16, icon }: {
  hex?: string
  nickname?: string
  size?: number
  radius?: number
  fontSize?: number
  icon?: ReactNode
}) {
  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: radius, display: 'flex',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }
  if (icon) {
    return <div style={{ ...base, background: 'var(--teal-grad)' }}>{icon}</div>
  }
  const av = avatarFor(hex ?? '')
  return <div style={{ ...base, background: av.grad, fontSize, fontWeight: 700, color: av.color }}>{initialsFor(nickname)}</div>
}
