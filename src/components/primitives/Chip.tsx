//   Chip — pill container. Tones: neutral / positive / warn / danger.
//   Base for address chips, copied-state, network + status badges.
//   Token-driven (design "Primitives → CHIPS & BADGES"). Pill radius, 7/13 padding, 12px.

import type { CSSProperties, ReactNode } from 'react'

export type ChipTone = 'neutral' | 'positive' | 'warn' | 'danger'

interface ChipProps {
  tone?: ChipTone
  /** Leading element (icon or dot). */
  leading?: ReactNode
  /** Use the mono font for the label (addresses, hashes). */
  mono?: boolean
  children: ReactNode
  style?: CSSProperties
  onClick?: () => void
  title?: string
}

const TONES: Record<ChipTone, CSSProperties> = {
  neutral: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-body-dim)',
  },
  positive: {
    background: 'rgba(var(--positive-rgb), 0.12)',
    border: '1px solid transparent',
    color: 'var(--positive)',
  },
  warn: {
    background: 'rgba(var(--warn-rgb), 0.12)',
    border: '1px solid transparent',
    color: 'var(--warn-300)',
  },
  danger: {
    background: 'rgba(var(--danger-rgb), 0.12)',
    border: '1px solid transparent',
    color: 'var(--danger-300)',
  },
}

export default function Chip({ tone = 'neutral', leading, mono = false, children, style, onClick, title }: ChipProps) {
  return (
    <span
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '7px 13px',
        borderRadius: 'var(--r-pill)',
        fontSize: 12,
        fontWeight: 600,
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        cursor: onClick ? 'pointer' : 'default',
        ...TONES[tone],
        ...style,
      }}
    >
      {leading}
      {children}
    </span>
  )
}
