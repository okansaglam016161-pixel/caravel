//   CryptoBusy — full-panel "please wait" for heavy in-browser crypto (the ~600k-iteration
//   PBKDF2 unlock/create/restore waits that otherwise hang the card with no affordance).
//   Composed from tokens (md Spinner + primary title + muted reassurance); appears in the
//   entry-flows design. Not a design-grid primitive — assembled from the token scale.

import type { CSSProperties } from 'react'
import Spinner from './Spinner'

interface CryptoBusyProps {
  title: string
  /** Sub-line reassuring the user the wait is expected (e.g. "This can take a few seconds"). */
  reassurance?: string
  style?: CSSProperties
}

export default function CryptoBusy({ title, reassurance, style }: CryptoBusyProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 28,
        textAlign: 'center',
        ...style,
      }}
    >
      <Spinner size="md" />
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
      {reassurance && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 320 }}>{reassurance}</div>
      )}
    </div>
  )
}
