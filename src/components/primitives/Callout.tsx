//   Callout — inline banner. Tones: warn / error / note (confidential note).
//   Token-driven (design "Primitives → CALLOUTS"). This replaces the old WarnBox
//   (warn/error tones) and adds the confidential-note tone. Padding 12/14, r-11, 13px.

import type { CSSProperties, ReactNode } from 'react'

export type CalloutTone = 'warn' | 'error' | 'note'

interface CalloutProps {
  tone?: CalloutTone
  /** Optional leading icon/element. */
  icon?: ReactNode
  children: ReactNode
  style?: CSSProperties
}

const TONES: Record<CalloutTone, CSSProperties> = {
  warn: {
    background: 'rgba(var(--warn-rgb), 0.10)',
    border: '1px solid rgba(var(--warn-rgb), 0.28)',
    color: 'var(--warn-300)',
  },
  error: {
    background: 'rgba(var(--danger-rgb), 0.10)',
    border: '1px solid rgba(var(--danger-rgb), 0.28)',
    color: 'var(--danger-300)',
  },
  note: {
    background: 'rgba(var(--accent-400-rgb), 0.08)',
    border: '1px solid rgba(var(--accent-400-rgb), 0.22)',
    color: 'var(--accent-300)',
  },
}

export default function Callout({ tone = 'warn', icon, children, style }: CalloutProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 'var(--r-md)',
        fontSize: 13,
        lineHeight: 1.5,
        ...TONES[tone],
        ...style,
      }}
    >
      {icon}
      <div>{children}</div>
    </div>
  )
}
