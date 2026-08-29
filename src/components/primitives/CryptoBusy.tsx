//   CryptoBusy — the "please wait" card for the ~600k-iteration PBKDF2 waits (create / unlock /
//   restore), which would otherwise hang a form with no affordance.
//
//   V3 frame 8e: a spinner, a title, and one line saying how long. It used to carry a mono
//   "600,000 PBKDF2 iterations" footer, which was a true and rather good detail and is dropped
//   here with the rest of the entry reskin — the frames answer "how long" instead of "why", and on
//   a screen someone meets before they have a wallet, the iteration count is our reassurance
//   rather than theirs. `reassurance` still carries whatever the caller wants said.
//
//   Renders AS the card, so an entry screen swaps its form card for this one.

import type { CSSProperties } from 'react'

interface CryptoBusyProps {
  title: string
  /** Sub-line saying what the wait is. Kept short — the frames use one sentence. */
  reassurance?: string
  style?: CSSProperties
}

export default function CryptoBusy({ title, reassurance, style }: CryptoBusyProps) {
  return (
    <div
      style={{
        width: '100%', maxWidth: 360, boxSizing: 'border-box',
        padding: '48px 32px', borderRadius: 18,
        background: 'var(--surface)', border: '1px solid var(--border)',
        boxShadow: 'var(--e1)', textAlign: 'center',
        ...style,
      }}
    >
      <span
        style={{
          display: 'inline-block', width: 28, height: 28, borderRadius: '50%',
          border: '3px solid var(--border)', borderTopColor: 'var(--accent-400)',
          animation: 'cv-spin 1s linear infinite',
        }}
      />
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', marginTop: 18 }}>{title}</div>
      {reassurance && (
        <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginTop: 6, lineHeight: 1.55, textWrap: 'pretty' }}>
          {reassurance}
        </div>
      )}
    </div>
  )
}
