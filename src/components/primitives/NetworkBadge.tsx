//   NetworkBadge — warn-toned chip with a dot, for the "Esmeralda testnet" marker.

import Chip from './Chip'
import type { CSSProperties } from 'react'

interface NetworkBadgeProps {
  label?: string
  style?: CSSProperties
}

export default function NetworkBadge({ label = 'Esmeralda testnet', style }: NetworkBadgeProps) {
  return (
    <Chip
      tone="warn"
      mono
      style={style}
      leading={<span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)' }} />}
    >
      {label}
    </Chip>
  )
}
