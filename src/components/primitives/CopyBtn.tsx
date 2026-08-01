//   CopyBtn — copies `value` to the clipboard and shows a check + "Copied" for 1800ms.
//   variant 'chip' (default) renders a pill (mono `value` + copy icon) = the address chip;
//   the copied state flips the pill to the teal tone. variant 'button' is a plain text button.
//   Token-driven (design "Primitives → CHIPS & BADGES": address chip + Copied).

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import Chip from './Chip'

interface CopyBtnProps {
  /** Text copied to the clipboard. */
  value: string
  /** Visible label; defaults to `value` (chip) or "Copy" (button). */
  label?: ReactNode
  variant?: 'chip' | 'button'
  /** Mono label (addresses/hashes). Chip variant defaults to true. */
  mono?: boolean
  style?: CSSProperties
}

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
)

export default function CopyBtn({ value, label, variant = 'chip', mono, style }: CopyBtnProps) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard?.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  if (variant === 'button') {
    return (
      <button
        onClick={copy}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: mono ? 'var(--font-mono)' : 'inherit', fontSize: 12, fontWeight: 600,
          color: copied ? 'var(--teal-300)' : 'var(--text-muted)', padding: 0, ...style,
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? 'Copied' : (label ?? 'Copy')}
      </button>
    )
  }

  return (
    <Chip
      tone={copied ? 'teal' : 'neutral'}
      mono={mono ?? true}
      onClick={copy}
      leading={copied ? <CheckIcon /> : undefined}
      style={style}
    >
      {copied ? 'Copied' : (label ?? value)}
      {!copied && <CopyIcon />}
    </Chip>
  )
}
