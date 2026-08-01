//   Button — primary / secondary / quiet / danger, plus a busy state.
//   Token-driven (design "Primitives → BUTTONS"). All variants: padding 13px, r-* 12px, 14px.

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import Spinner from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** Show a spinner and disable the button while an action is in flight. */
  busy?: boolean
  children: ReactNode
}

const BASE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 9,
  padding: 13,
  borderRadius: 12,
  fontSize: 14,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid transparent',
  width: '100%',
  boxSizing: 'border-box',
}

const VARIANTS: Record<ButtonVariant, CSSProperties> = {
  primary: { background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontWeight: 700 },
  secondary: {
    background: 'var(--surface-raised)',
    border: '1px solid rgba(var(--teal-500-rgb), 0.26)',
    color: 'var(--text-bright)',
    fontWeight: 700,
  },
  quiet: {
    background: 'transparent',
    border: '1px solid rgba(var(--border-rgb), 0.2)',
    color: 'var(--text-muted)',
    fontWeight: 600,
  },
  danger: {
    background: 'rgba(var(--danger-rgb), 0.08)',
    border: '1px solid rgba(var(--danger-rgb), 0.3)',
    color: 'var(--danger-300)',
    fontWeight: 700,
  },
}

const BUSY: CSSProperties = {
  background: 'var(--surface-raised)',
  border: '1px solid rgba(var(--border-rgb), 0.14)',
  color: 'var(--text-faint-dim)',
  fontWeight: 700,
  cursor: 'default',
}

export default function Button({ variant = 'primary', busy = false, disabled, children, style, ...rest }: ButtonProps) {
  const isDisabled = disabled || busy
  return (
    <button
      {...rest}
      disabled={isDisabled}
      style={{
        ...BASE,
        ...(busy ? BUSY : VARIANTS[variant]),
        ...(isDisabled && !busy ? { opacity: 0.5, cursor: 'default' } : {}),
        ...style,
      }}
    >
      {busy && <Spinner size="xs" tone="muted" />}
      {children}
    </button>
  )
}
