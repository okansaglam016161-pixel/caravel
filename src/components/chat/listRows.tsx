// The LIST CARD and its rows — shared by the Profile panel and the wallet pill's menu, so the two
// draw the same facts the same way.
//
// A card is one bordered box of rows split by hairlines. Every row has the same padding, the same
// minimum height and the same label column (LABEL_W), so the values of every row start at one x.
// Rows that DO something (open a step, copy) take the quiet hover wash; rows that only state a fact
// do not.

import { useState, type CSSProperties, type ReactNode } from 'react'
import { linkBtn, shortenMiddle } from './listRowStyles'

const LABEL_W = 84
const ROW_PAD = '12px 14px'
const ROW_MIN_H = 44
const HAIRLINE = '1px solid var(--border)'
const MONO = 'var(--font-mono)'

const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-400)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
)
const Chevron = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M9 18l6-6-6-6" />
  </svg>
)

export function ListCard({ children, mt = 8 }: { children: ReactNode; mt?: number }) {
  return (
    <div style={{ marginTop: mt, borderRadius: 10, border: HAIRLINE, background: 'var(--surface)', overflow: 'hidden' }}>
      {children}
    </div>
  )
}

const rowBase = (first: boolean, clickable: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 10, padding: ROW_PAD, minHeight: ROW_MIN_H, boxSizing: 'border-box',
  borderTop: first ? 'none' : HAIRLINE, cursor: clickable ? 'pointer' : 'default',
})

const labelStyle: CSSProperties = { width: LABEL_W, flexShrink: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-muted-dim)' }
const valueStyle: CSSProperties = { flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-body-dim)', display: 'flex', alignItems: 'center', gap: 10 }

/** A label and a value that is just stated. `note` is a second line under the value, in its column. */
export function FactRow({ label, children, note, first = false }: { label: string; children: ReactNode; note?: ReactNode; first?: boolean }) {
  return (
    <div style={{ ...rowBase(first, false), flexWrap: 'wrap', rowGap: 4 }}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{children}</span>
      {note && <div style={{ flexBasis: '100%', paddingLeft: LABEL_W + 10, fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted-dim)' }}>{note}</div>}
    </div>
  )
}

/**
 * A label, a shortened preview and a copy control. IT COPIES THE FULL VALUE, ALWAYS — a
 * partially-copied address is an unrecoverable payment. Copy state is per row, so two rows can never
 * both claim "Copied".
 */
export function CopyRow({ label, value, missing, first = false }: { label: string; value: string | null; missing: string; first?: boolean }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    if (!value) return
    void navigator.clipboard?.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div
      role={value ? 'button' : undefined} tabIndex={value ? 0 : undefined}
      aria-label={value ? `Copy ${label}` : undefined} title={value ?? undefined}
      onClick={value ? copy : undefined}
      onKeyDown={value ? e => { if (e.key === 'Enter') copy() } : undefined}
      className={value ? 'cv-quiet-btn' : undefined}
      style={rowBase(first, !!value)}
    >
      <span style={labelStyle}>{label}</span>
      <span style={{
        flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11.5,
        color: value ? 'var(--text-body-dim)' : 'var(--text-faint)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{copied ? 'Copied' : value ? shortenMiddle(value) : missing}</span>
      {value && (copied ? <CheckIcon /> : <CopyIcon />)}
    </div>
  )
}

/** A row that opens another step: its title where the label column starts, a quiet hint, a chevron. */
export function NavRow({ title, hint, onOpen, first = false }: { title: string; hint?: string; onOpen: () => void; first?: boolean }) {
  return (
    <div
      role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter') onOpen() }}
      className="cv-quiet-btn"
      style={rowBase(first, true)}
    >
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{title}</span>
      {hint && <span style={{ fontSize: 11.5, color: 'var(--text-muted-dim)' }}>{hint}</span>}
      <Chevron />
    </div>
  )
}

/**
 * A row with an on/off switch: its title where the label column starts, a quiet hint under it, the
 * switch at the end. The whole row toggles; it is a `switch` for assistive tech.
 */
export function SwitchRow({ title, hint, on, onChange, first = false }: {
  title: string; hint?: string; on: boolean; onChange: (on: boolean) => void; first?: boolean
}) {
  return (
    <div
      role="switch" aria-checked={on} aria-label={title} tabIndex={0}
      onClick={() => onChange(!on)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(!on) } }}
      className="cv-quiet-btn"
      style={rowBase(first, true)}
    >
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{title}</span>
        {hint && <span style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-muted-dim)' }}>{hint}</span>}
      </span>
      <span aria-hidden="true" style={{
        position: 'relative', flexShrink: 0, width: 34, height: 20, borderRadius: 999,
        background: on ? 'var(--accent-400)' : 'var(--border-strong)', transition: 'background 0.15s',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: 999,
          background: '#FFFFFF', boxShadow: 'var(--e1)', transition: 'left 0.15s',
        }} />
      </span>
    </div>
  )
}

/** The card's foot: one small, quiet text action (Disconnect). */
export function QuietFootAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <div style={{ borderTop: HAIRLINE, padding: '9px 14px' }}>
      <button onClick={onClick} style={{ ...linkBtn, fontSize: 12, fontWeight: 500, color: 'var(--text-muted-dim)' }}>{children}</button>
    </div>
  )
}
