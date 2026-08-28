//   PasswordField — masked input with an eye toggle, used by every entry password field
//   (create set-password, restore set-password, unlock). A field WELL: the page ground inset into
//   the card, which reads as a field in both themes — in light the card is white and `raised` is
//   also white, so a raised field would have been invisible on it.

import { useState } from 'react'
import { MONO, fieldSurface } from './entryStyles'

interface PasswordFieldProps {
  value: string
  onChange: (v: string) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  placeholder?: string
  invalid?: boolean
  autoFocus?: boolean
}

export default function PasswordField({ value, onChange, onKeyDown, placeholder = '••••••••', invalid = false, autoFocus }: PasswordFieldProps) {
  const [show, setShow] = useState(false)
  const [focused, setFocused] = useState(false)

  const border = invalid
    ? '1px solid var(--danger-500)'
    : focused
      ? '1px solid var(--accent-400)'
      : '1px solid var(--border-strong)'
  // The foundation's focus ring, same as every other input in the app.
  const boxShadow = focused && !invalid ? '0 0 0 3px rgba(var(--accent-400-rgb),0.18)' : undefined

  return (
    <div style={{ ...fieldSurface, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', border, boxShadow }}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 14, color: 'var(--text-primary)', letterSpacing: show ? '0' : '0.2em', padding: 0 }}
      />
      <svg onClick={() => setShow(s => !s)} width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" style={{ cursor: 'pointer', flexShrink: 0 }}>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
        {!show && <path d="M4 4l16 16" />}
      </svg>
    </div>
  )
}
