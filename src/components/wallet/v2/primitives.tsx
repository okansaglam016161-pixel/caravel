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
      width: `min(${MODAL_WIDTH}px, 94vw)`, maxHeight: '88vh', borderRadius: 'var(--r-xl)', background: C.modal,
      border: '1px solid var(--border)', boxShadow: 'var(--e3)', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>{children}</div>
  )
}

const headerBase: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '18px 22px', borderBottom: '1px solid var(--border)', flexShrink: 0,
}

export const iconBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
  borderRadius: 'var(--r-md)', background: C.raised, border: '1px solid var(--border)', color: C.mutedDim,
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
            padding: '3px 10px', borderRadius: 'var(--r-pill)', fontSize: 11, fontWeight: 600,
            color: C.tealLabel, background: tealFill(0.07), border: tealBorder(0.22),
          }}>{chip}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>
    </div>
  )
}

/**
 * Header for a sub-view: a back affordance, the view's name, and close.
 *
 * `onClose` is optional because the wallet also renders as a PAGE, where there is nothing to close
 * — the shell is what it would close back to. The ✕ is omitted rather than made inert: a control
 * that visibly does nothing is worse than one that is not offered.
 */
export function SubHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose?: () => void }) {
  return (
    <div style={headerBase}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {onBack && <span role="button" tabIndex={0} onClick={onBack} onKeyDown={e => e.key === 'Enter' && onBack()} style={{ ...iconBtn, fontSize: 15 }} aria-label="Back">←</span>}
        <span style={{ fontSize: 17, fontWeight: 700, color: C.primary }}>{title}</span>
      </div>
      {onClose && <span role="button" tabIndex={0} onClick={onClose} onKeyDown={e => e.key === 'Enter' && onClose()} style={iconBtn} aria-label="Close">✕</span>}
    </div>
  )
}

// Scrolls rather than growing: with tabs and panels the overview can outrun the viewport, and a
// modal that pushes its own confirm button off-screen is worse than one that scrolls.
export function Body({ children, gap = 12 }: { children: ReactNode; gap?: number }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap, padding: '20px 22px 22px',
      overflowY: 'auto', minHeight: 0,
    }}>{children}</div>
  )
}

// ── Buttons ───────────────────────────────────────────────────────────────────

export type ButtonTone = 'primary' | 'neutral' | 'amber' | 'disabled'

const toneStyle: Record<ButtonTone, CSSProperties> = {
  // The routine action. FLAT accent — the foundation forbids brand gradients.
  primary: { background: C.teal, color: C.inkOnTeal, border: 'none' },
  neutral: { background: C.inset, color: C.body, border: '1px solid var(--border-strong)' },
  // The permanent action. Amber ground and text, NOT red: it will work exactly as described.
  amber: { background: C.amberGround, color: C.warn300, border: warnBorder(0.40) },
  disabled: { background: C.raised, color: C.ghost, border: '1px solid var(--border)', cursor: 'not-allowed' },
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
        borderRadius: 'var(--r-md)', fontSize: 14, fontWeight: 600, cursor: dead ? 'not-allowed' : 'pointer',
        userSelect: 'none', ...(flex ? { flex } : {}), ...toneStyle[tone],
      }}
    >{children}</span>
  )
}

// ── Cards and rows ────────────────────────────────────────────────────────────

/** The recessed panel the fee and resulting-balance rows sit in. */
export function DetailCard({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 'var(--r-lg)', background: C.trough, border: '1px solid var(--border)', overflow: 'hidden' }}>
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
      ...(last ? {} : { borderBottom: '1px solid var(--border)' }),
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
      padding: '11px 14px', borderRadius: 'var(--r-md)', background: C.trough, border: '1px solid var(--border)',
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

export const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: C.faintDim, padding: '0 2px' }}>{children}</span>
)

// ── Panels, fields and tabs ───────────────────────────────────────────────────
//
// Added for the panels the Claude Design canvas never covered — faucet, send, receive, ONS. They
// are built from the SAME vocabulary the designed screens use (the card radii, the trough insets,
// the four button tones, the teal/amber split) rather than a parallel set, so the modal reads as
// one product whichever tab you are on.

export type PanelTone = 'neutral' | 'teal' | 'amber' | 'danger'

const panelTone: Record<PanelTone, { bg: string; bd: string }> = {
  neutral: { bg: C.raised, bd: '1px solid var(--border)' },
  teal: { bg: tealFill(0.08), bd: tealBorder(0.22) },
  amber: { bg: 'var(--card-warn)', bd: '1px solid var(--card-warn-border)' },
  danger: { bg: 'var(--card-danger)', bd: '1px solid var(--card-danger-border)' },
}

/**
 * A standalone card inside a tab — the faucet and ONS panels.
 *
 * Same 14px radius and 18px padding as the balance cards, so a panel sitting under the hero reads
 * as part of the same stack rather than a bolted-on widget.
 */
export function Panel({ tone = 'neutral', title, titleColor, meta, metaColor, children }: {
  tone?: PanelTone; title: ReactNode; titleColor?: string; meta?: ReactNode; metaColor?: string; children: ReactNode
}) {
  const t = panelTone[tone]
  return (
    <div style={{ padding: 20, borderRadius: 'var(--r-lg)', background: t.bg, border: t.bd }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 14, fontWeight: 700, color: titleColor ?? C.primary }}>{title}</span>
        {meta && <span style={{ fontFamily: MONO, fontSize: 12, color: metaColor ?? C.faintDim, flexShrink: 0 }}>{meta}</span>}
      </div>
      {children}
    </div>
  )
}

export const PanelText = ({ children, color = C.mutedDim }: { children: ReactNode; color?: string }) => (
  <div style={{ fontSize: 13, color, lineHeight: 1.5, marginBottom: 14 }}>{children}</div>
)

/** Small caps label above a field. */
export const FieldLabel = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: C.faintDim, marginBottom: 8 }}>{children}</div>
)

export function TextField({ value, onChange, placeholder, mono = true, invalid, multiline, prefix, ariaLabel, readOnly }: {
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean
  invalid?: boolean; multiline?: boolean; prefix?: ReactNode; ariaLabel?: string; readOnly?: boolean
}) {
  const shell: CSSProperties = {
    display: 'flex', alignItems: multiline ? 'flex-start' : 'center', gap: 9,
    padding: '13px 15px', borderRadius: 'var(--r-md)', background: C.trough,
    border: invalid ? '1px solid var(--danger-500)' : '1px solid var(--border-strong)',
  }
  const inner: CSSProperties = {
    flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', padding: 0,
    fontFamily: mono ? MONO : 'inherit', fontSize: 13.5, color: C.body, resize: 'vertical',
  }
  return (
    <div style={shell}>
      {prefix}
      {multiline
        ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={2} aria-label={ariaLabel} readOnly={readOnly} style={inner} />
        : <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} aria-label={ariaLabel} readOnly={readOnly} style={inner} />}
    </div>
  )
}

/**
 * The generic amount input shell. The move flow's AmountCard is this plus direction copy —
 * ONE visual treatment for "type a number of TARI", wherever it appears.
 */
export function AmountField({ value, onChange, onMax, maxUsed, accent = 'teal', availableLabel, availableValue, note, error, readOnly }: {
  value: string; onChange: (v: string) => void
  onMax?: () => void; maxUsed?: boolean
  accent?: 'teal' | 'neutral'
  availableLabel?: string; availableValue?: ReactNode
  note?: ReactNode; error?: ReactNode; readOnly?: boolean
}) {
  const teal = accent === 'teal'
  return (
    <div style={{
      padding: '16px 18px', borderRadius: 'var(--r-lg)', background: C.trough,
      border: error ? '1px solid var(--danger-500)' : teal ? tealBorder(0.28) : '1px solid var(--border-strong)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: C.faintDim }}>AMOUNT</span>
        {availableLabel && (
          <span style={{ fontSize: 12, color: C.faint }}>
            {availableLabel} · <span style={{ fontFamily: MONO, color: C.muted }}>{availableValue}</span>
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <input
          value={value} onChange={e => onChange(e.target.value)} readOnly={readOnly}
          inputMode="decimal" placeholder="0.000000" aria-label="Amount in TARI"
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', padding: 0, fontFamily: MONO, fontSize: 26, fontWeight: 600, color: C.bright }}
        />
        <span style={{ fontFamily: MONO, fontSize: 14, color: C.tealDim, flexShrink: 0 }}>TARI</span>
        {onMax && (
          <span role="button" tabIndex={0} onClick={onMax} onKeyDown={e => e.key === 'Enter' && onMax()} style={{
            padding: '5px 12px', borderRadius: 'var(--r-sm)', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0, userSelect: 'none',
            background: maxUsed ? C.maxActive : teal ? tealFill(0.1) : C.inset,
            border: maxUsed ? border(0.4) : teal ? tealBorder(0.3) : border(0.22),
            color: maxUsed ? C.body : teal ? C.teal300 : C.muted,
          }}>MAX</span>
        )}
      </div>
      {error
        ? <div style={{ fontSize: 12, color: C.dangerText, marginTop: 10, lineHeight: 1.5 }}>{error}</div>
        : note ? <div style={{ fontSize: 12, color: C.mutedDim, marginTop: 10, lineHeight: 1.5 }}>{note}</div> : null}
    </div>
  )
}

/**
 * Top-level navigation.
 *
 * THE DESIGN CANVAS HAS NO TAB BAR — it draws one focused card and navigates by pushing sub-views
 * with a back arrow. But the shipped modal has four areas and dropping any of them would be an
 * information-architecture change, not a reskin. So both models coexist: tabs select the area,
 * and flows inside an area still push a sub-view. Styled from the same vocabulary — a trough rail
 * with a raised active pill, teal only on the selection.
 */
export function TabBar<T extends string>({ tabs, active, onSelect }: {
  tabs: readonly T[]; active: T; onSelect: (t: T) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 'var(--r-md)', background: C.trough, border: '1px solid var(--border)' }}>
      {tabs.map(t => {
        const on = t === active
        return (
          <span
            key={t} role="tab" tabIndex={0} aria-selected={on}
            onClick={() => onSelect(t)} onKeyDown={e => e.key === 'Enter' && onSelect(t)}
            style={{
              flex: 1, textAlign: 'center', padding: '8px 0', borderRadius: 'var(--r-md)', cursor: 'pointer',
              fontSize: 13, fontWeight: on ? 600 : 500, userSelect: 'none',
              background: on ? 'var(--nav-selected)' : 'transparent',
              color: on ? C.bright : C.muted,
              boxShadow: 'none',
            }}
          >{t.charAt(0).toUpperCase() + t.slice(1)}</span>
        )
      })}
    </div>
  )
}

/**
 * The scan diagnostic strip: what the last private scan actually did, paired with Refresh.
 *
 * DELIBERATELY LITERAL. The M4 report argued these figures were plumbing and recommended replacing
 * them with a freshness line ("Updated just now"). That recommendation is overridden here on
 * purpose: on a testnet wallet the raw counts are the fastest way to answer "did my scan run, and
 * did it see my outputs" — which is a question the user actually asks, and which "Updated just now"
 * cannot answer. It is a diagnostic, and it is placed and styled as one.
 *
 * THE COUNTS DESCRIBE THE PRIVATE SCAN ONLY. Public balance is a vault read — two short GETs
 * against a known substate, with nothing to enumerate — so there is no count to show for it and
 * pretending otherwise would be worse than silence.
 *
 * Refresh lives here rather than in the header so the control and the evidence of what it did sit
 * together, and so the literal figures have room to be literal.
 */
export interface ScanSummary {
  status: 'idle' | 'scanning' | 'done' | 'error'
  /** Total outputs the last completed scan examined. */
  scanned: number
  /** How many of them turned out to be ours. */
  owned: number
  /** Live count while a scan is running. */
  progressScanned: number
}

export function ScanStrip({ scan, refreshing, onRefresh }: {
  scan: ScanSummary; refreshing?: boolean; onRefresh: () => void
}) {
  const text = scan.status === 'scanning'
    ? `${scan.progressScanned.toLocaleString('en-US')} UTXOs scanned…`
    : scan.status === 'error'
      ? 'Scan failed'
      : scan.status === 'done' || scan.scanned > 0
        // The literal figures, as they were before the redesign.
        ? `${scan.scanned.toLocaleString('en-US')} UTXOs scanned · ${scan.owned.toLocaleString('en-US')} owned`
        : ''

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '8px 22px', borderBottom: '1px solid var(--border)',
      background: C.trough, flexShrink: 0,
    }}>
      <span style={{
        fontFamily: MONO, fontSize: 11, letterSpacing: '0.02em',
        color: scan.status === 'error' ? C.dangerText : C.faintDim,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{text}</span>
      {refreshing ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: C.tealDim, flexShrink: 0 }}>
          <Spinner size={11} />Refreshing…
        </span>
      ) : (
        <span role="button" tabIndex={0} onClick={onRefresh} onKeyDown={e => e.key === 'Enter' && onRefresh()}
          style={{ fontSize: 12, fontWeight: 700, color: C.teal, cursor: 'pointer', userSelect: 'none', flexShrink: 0 }}>
          Refresh
        </span>
      )}
    </div>
  )
}
