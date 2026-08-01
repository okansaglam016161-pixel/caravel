//   Input — native input wrapper. States: placeholder / focused / invalid / disabled.
//   Optional `unit` renders a right-aligned unit label (e.g. "TARI") with a mono value.
//   Token-driven (design "Primitives → INPUTS"). Padding 13/15, r-11, 14px.

import { forwardRef, useState } from 'react'
import type { CSSProperties, InputHTMLAttributes } from 'react'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> {
  invalid?: boolean
  /** Right-aligned unit label; also switches the value to the mono font. */
  unit?: string
  style?: CSSProperties
  wrapperStyle?: CSSProperties
}

const FIELD: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '13px 15px',
  borderRadius: 11,
  fontSize: 14,
  fontFamily: 'inherit',
  background: 'var(--surface-raised)',
  border: '1px solid rgba(var(--border-rgb), 0.14)',
  color: 'var(--text-body)',
  outline: 'none',
}

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, unit, disabled, style, wrapperStyle, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false)

  // Border + shadow precedence: invalid > focused > default.
  const border = invalid
    ? '1px solid rgba(var(--danger-rgb), 0.45)'
    : focused
      ? '1px solid rgba(var(--teal-500-rgb), 0.45)'
      : disabled
        ? '1px solid rgba(var(--border-rgb), 0.1)'
        : '1px solid rgba(var(--border-rgb), 0.14)'
  const boxShadow = focused && !invalid ? '0 0 0 3px rgba(var(--teal-500-rgb), 0.09)' : 'none'
  const bg = disabled ? 'rgba(16, 21, 31, 0.5)' : 'var(--surface-raised)'
  const color = disabled ? 'var(--text-disabled)' : 'var(--text-body)'

  const field = (
    <input
      {...rest}
      ref={ref}
      disabled={disabled}
      onFocus={(e) => { setFocused(true); rest.onFocus?.(e) }}
      onBlur={(e) => { setFocused(false); rest.onBlur?.(e) }}
      style={{
        ...FIELD,
        background: unit ? 'transparent' : bg,
        border: unit ? 'none' : border,
        boxShadow: unit ? 'none' : boxShadow,
        color,
        padding: unit ? 0 : FIELD.padding,
        fontFamily: unit ? 'var(--font-mono)' : 'inherit',
        flex: unit ? 1 : undefined,
        ...style,
      }}
    />
  )

  if (!unit) return field

  // Amount-with-unit row: field + right-aligned teal unit label.
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '13px 15px',
        borderRadius: 11,
        background: bg,
        border,
        boxShadow,
        boxSizing: 'border-box',
        ...wrapperStyle,
      }}
    >
      {field}
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--teal-500)' }}>{unit}</span>
    </div>
  )
})

export default Input
