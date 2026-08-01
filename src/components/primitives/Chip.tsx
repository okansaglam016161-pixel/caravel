//   Chip — pill container. Tones: neutral / teal / warn / danger.
//   Base for address chips, copied-state, network + status badges.
//   Token-driven (design "Primitives → CHIPS & BADGES"). Pill radius, 7/13 padding, 12px.

import type { CSSProperties, ReactNode } from 'react'

export type ChipTone = 'neutral' | 'teal' | 'warn' | 'danger'

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
    background: 'var(--surface-raised)',
    border: '1px solid rgba(var(--border-rgb), 0.14)',
    color: 'var(--text-body-dim)',
  },
  teal: {
    background: 'rgba(var(--teal-500-rgb), 0.07)',
    border: '1px solid rgba(var(--teal-500-rgb), 0.3)',
    color: 'var(--teal-300)',
  },
  warn: {
    background: 'rgba(var(--warn-rgb), 0.06)',
    border: '1px solid rgba(var(--warn-rgb), 0.3)',
    color: 'var(--warn-300)',
  },
  danger: {
    background: 'rgba(var(--danger-rgb), 0.07)',
    border: '1px solid rgba(var(--danger-rgb), 0.3)',
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
        borderRadius: 100,
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
