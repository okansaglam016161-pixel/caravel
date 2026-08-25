// The M4 modal's shared building blocks, transcribed from the design canvas.
//
// Everything here is PRESENTATIONAL — props in, markup out, no wallet state, no network, no
// bigint arithmetic beyond formatting what it is handed. That is what makes Stage 2 a reskin: the
// proven fund logic keeps computing the numbers and simply hands them to these.

import type { CSSProperties, ReactNode } from 'react'
import { C, MODAL_WIDTH, MONO, border, tealBorder, tealFill, warnBorder } from './tokens'
import { Copy, Spinner } from './icons'

// ── Shell ─────────────────────────────────────────────────────────────────────

export function ModalShell({ children }: { children: ReactNode }) {
  return (
    <div style={{
      width: `min(${MODAL_WIDTH}px, 94vw)`, borderRadius: 20, background: C.modal,
      border: border(0.14), boxShadow: '0 30px 80px rgba(0,0,0,0.55)', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>{children}</div>
  )
}

const headerBase: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '18px 22px', borderBottom: '1px solid rgba(120,150,210,0.1)', flexShrink: 0,
}

export const iconBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
  borderRadius: 9, background: C.raised, border: border(0.16), color: C.mutedDim,
  fontSize: 14, cursor: 'pointer', flexShrink: 0, userSelect: 'none',
}

/** Header for the modal's root view: name, network chip, and the global controls. */
export function RootHeader({ chip, right }: { chip?: string; right: ReactNode }) {
  return (
    <div style={headerBase}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: C.primary }}>Wallet</span>
        {chip && (
          <span style={{
            padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
            color: C.tealLabel, background: tealFill(0.07), border: tealBorder(0.22),
          }}>{chip}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>
    </div>
  )
}

/** Header for a sub-view: a back affordance, the view's name, and close. */
export function SubHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  return (
    <div style={headerBase}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {onBack && <span role="button" tabIndex={0} onClick={onBack} onKeyDown={e => e.key === 'Enter' && onBack()} style={{ ...iconBtn, fontSize: 15 }} aria-label="Back">←</span>}
        <span style={{ fontSize: 17, fontWeight: 700, color: C.primary }}>{title}</span>
      </div>
      <span role="button" tabIndex={0} onClick={onClose} onKeyDown={e => e.key === 'Enter' && onClose()} style={iconBtn} aria-label="Close">✕</span>
    </div>
  )
}

export function Body({ children, gap = 12 }: { children: ReactNode; gap?: number }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, padding: '20px 22px 22px' }}>{children}</div>
}

// ── Buttons ───────────────────────────────────────────────────────────────────

export type ButtonTone = 'primary' | 'neutral' | 'amber' | 'disabled'

const toneStyle: Record<ButtonTone, CSSProperties> = {
  // The routine action. Teal gradient, dark ink — the most confident control in the product.
  primary: { background: `linear-gradient(180deg, ${C.tealGradTop}, ${C.tealGradBottom})`, color: C.inkOnTeal, border: 'none' },
  neutral: { background: C.inset, color: C.body, border: border(0.28) },
  // The permanent action. Amber ground and text, NOT red: it will work exactly as described.
  amber: { background: C.amberGround, color: C.warn300, border: warnBorder(0.45) },
  disabled: { background: C.raised, color: C.ghost, border: border(0.12), cursor: 'not-allowed' },
}

export function Button({ tone = 'primary', children, onClick, flex }: {
  tone?: ButtonTone; children: ReactNode; onClick?: () => void; flex?: number
}) {
  const dead = tone === 'disabled'
  return (
    <span
      role="button" tabIndex={dead ? -1 : 0} aria-disabled={dead}
      onClick={dead ? undefined : onClick}
      onKeyDown={e => { if (!dead && e.key === 'Enter') onClick?.() }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '13px 0',
        borderRadius: 11, fontSize: 14.5, fontWeight: 700, cursor: dead ? 'not-allowed' : 'pointer',
        userSelect: 'none', ...(flex ? { flex } : {}), ...toneStyle[tone],
      }}
    >{children}</span>
  )
}

// ── Cards and rows ────────────────────────────────────────────────────────────

/** The recessed panel the fee and resulting-balance rows sit in. */
export function DetailCard({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 14, background: C.trough, border: border(0.14), overflow: 'hidden' }}>
      {children}
    </div>
  )
}

export function DetailRow({ label, value, valueColor = C.muted, last = false }: {
  label: string; value: ReactNode; valueColor?: string; last?: boolean
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      padding: '13px 18px', fontSize: 13,
      ...(last ? {} : { borderBottom: '1px solid rgba(120,150,210,0.08)' }),
    }}>
      <span style={{ color: C.mutedDim }}>{label}</span>
      <span style={{ fontFamily: MONO, color: valueColor, textAlign: 'right' }}>{value}</span>
    </div>
  )
}

/** Fee row that can be in flight — the design prices INSIDE review rather than on its own screen. */
export function FeeRow({ fee, last = false }: { fee: string | null; last?: boolean }) {
  return fee === null
    ? <DetailRow label="Network fee" last={last} value={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Spinner size={12} /><span style={{ fontSize: 12.5, color: C.faint, fontFamily: 'inherit' }}>Pricing…</span>
        </span>
      } />
    : <DetailRow label="Network fee" value={`${fee} TARI`} last={last} />
}

export function TxRow({ txId, onCopy }: { txId: string; onCopy?: () => void }) {
  const short = txId.length > 14 ? `${txId.slice(0, 6)}…${txId.slice(-6)}` : txId
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '11px 14px', borderRadius: 10, background: C.trough, border: border(0.1),
    }}>
      <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.faint }}>tx · {short}</span>
      <span role="button" tabIndex={0} onClick={onCopy} onKeyDown={e => e.key === 'Enter' && onCopy?.()} style={{ cursor: 'pointer', display: 'flex' }} aria-label="Copy transaction id">
        <Copy color={C.faint} />
      </span>
    </div>
  )
}

/** Centred icon + headline + sub-line. The shape every terminal state shares. */
export function StatusBlock({ ring, icon, title, sub }: {
  ring: { fill: string; border: string }; icon: ReactNode; title: ReactNode; sub: ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48,
        borderRadius: '50%', background: ring.fill, border: ring.border, flexShrink: 0,
      }}>{icon}</span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: C.bright, textAlign: 'center' }}>{title}</span>
        <span style={{ fontSize: 13, color: C.mutedDim, textAlign: 'center', lineHeight: 1.5 }}>{sub}</span>
      </span>
    </div>
  )
}

/**
 * The settling bar. Indeterminate on purpose: the move is FINISHED and we are waiting on an index,
 * so there is no percentage to report and pretending otherwise would be a lie about progress.
 */
export function SettleBar({ caption }: { caption: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ position: 'relative', height: 5, borderRadius: 3, background: C.raised, overflow: 'hidden' }}>
        <span style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: '40%', borderRadius: 3,
          background: `linear-gradient(90deg, ${tealFill(0.15)}, ${C.teal})`,
          animation: 'cv-slide 1.6s ease-in-out infinite',
        }} />
      </div>
      <span style={{ fontSize: 11.5, color: C.faintDim, textAlign: 'center' }}>{caption}</span>
    </div>
  )
}

/** Pulsing placeholder used by the loading balances. */
export function Skeleton({ w, h, fill, mt = 0 }: { w: number; h: number; fill: string; mt?: number }) {
  return <span style={{ display: 'block', width: w, height: h, borderRadius: h > 20 ? 7 : 5, background: fill, marginTop: mt, animation: 'cv-pulse 1.5s ease-in-out infinite' }} />
}

export const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: C.faintDim, padding: '0 2px' }}>{children}</span>
)
