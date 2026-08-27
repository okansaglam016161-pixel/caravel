//   Button — primary / secondary / quiet / danger, plus a busy state.
//   Token-driven (foundation "05 PRIMITIVES → Buttons"). Radius is the control step (md, 10px);
//   weight is 600 across every variant — v0.3 draws buttons at 600, not 700.

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
  borderRadius: 'var(--r-md)',
  fontSize: 14,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid transparent',
  width: '100%',
  boxSizing: 'border-box',
}

const VARIANTS: Record<ButtonVariant, CSSProperties> = {
  // Flat accent, not a gradient — the foundation forbids brand gradients.
  primary: { background: 'var(--accent-400)', color: 'var(--ink-on-accent)', fontWeight: 600 },
  secondary: {
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-primary)',
    fontWeight: 600,
  },
  // The foundation's GHOST: no border, accent ink, a tint only on interaction.
  quiet: {
    background: 'transparent',
    border: '1px solid transparent',
    color: 'var(--accent-300)',
    fontWeight: 600,
  },
  danger: {
    background: 'rgba(var(--danger-rgb), 0.10)',
    border: '1px solid rgba(var(--danger-rgb), 0.28)',
    color: 'var(--danger-300)',
    fontWeight: 600,
  },
}

const BUSY: CSSProperties = {
  background: 'var(--surface-raised)',
  border: '1px solid var(--border)',
  color: 'var(--text-disabled)',
  fontWeight: 600,
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
