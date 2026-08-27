//   CryptoBusy — full-panel "please wait" card for the ~600k-iteration PBKDF2 waits
//   (create / unlock / restore), which otherwise hang the form with no affordance (debt #9).
//   Transcribed from the entry-flows design canvas: 48px accent spinner + title + reassurance +
//   a mono "600,000 PBKDF2 iterations" pulse footer, in an xl-radius bordered card.
//   Renders AS the card (own border/padding), so an entry screen swaps its form card for this.

import type { CSSProperties } from 'react'

interface CryptoBusyProps {
  title: string
  /** Sub-line reassuring the user the wait is expected. */
  reassurance?: string
  style?: CSSProperties
}

export default function CryptoBusy({ title, reassurance, style }: CryptoBusyProps) {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 428,
        boxSizing: 'border-box',
        padding: '44px 26px',
        borderRadius: 'var(--r-xl)',
        background: 'var(--surface)',
        border: '1px solid var(--border-strong)',
        textAlign: 'center',
        ...style,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          width: 48,
          height: 48,
          borderRadius: '50%',
          border: '3px solid rgba(var(--accent-400-rgb), 0.20)',
          borderTopColor: 'var(--accent-400)',
          animation: 'cv-spin 0.9s linear infinite',
          marginBottom: 22,
        }}
      />
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>{title}</div>
      {reassurance && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 300, margin: '0 auto 18px' }}>
          {reassurance}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-teal-label)' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-400)', animation: 'cv-pulse 1.4s ease-in-out infinite' }} />
        600,000 PBKDF2 iterations
      </div>
    </div>
  )
}
