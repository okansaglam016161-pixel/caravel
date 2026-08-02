//   PasswordField — masked input with an eye toggle, used by every entry password field
//   (create set-password, restore set-password, unlock). Transcribed from the entry-flows design:
//   surface-raised row, mono value with 0.2em tracking, teal focus ring, danger border when invalid.

import { useState } from 'react'
import { MONO } from './entryStyles'

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
    ? '1px solid rgba(var(--danger-rgb),0.5)'
    : focused
      ? '1px solid rgba(var(--teal-500-rgb),0.45)'
      : '1px solid rgba(var(--border-rgb),0.14)'
  const boxShadow = focused && !invalid ? '0 0 0 3px rgba(var(--teal-500-rgb),0.09)' : undefined

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 15px', borderRadius: 11, background: 'var(--surface-raised)', border, boxShadow }}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 15, color: 'var(--text-body)', letterSpacing: show ? '0' : '0.2em', padding: 0 }}
      />
      <svg onClick={() => setShow(s => !s)} width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" style={{ cursor: 'pointer', flexShrink: 0 }}>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
        {!show && <path d="M4 4l16 16" />}
      </svg>
    </div>
  )
}
