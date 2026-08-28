// The assets list — the portfolio, as far as it currently goes.
//
// ── ONE REAL ASSET, PRESENTED AS A LIST ──────────────────────────────────────
//
// Caravel holds exactly one token. TARI_RESOURCE_ADDRESS is hardwired at 41 sites under
// src/crypto, the scan decrypts one resource, and the revealed read looks in one vault. So there is
// no multi-asset MODEL here and this file does not pretend otherwise: it takes the same two
// balances and the same total the hero takes, and lays them out as the first row of a list that
// will grow.
//
// That distinction is worth keeping sharp. A row per asset is a presentation; a portfolio is a data
// model with per-resource scanning, per-resource ceilings and per-resource settle watches. Building
// the second one to satisfy the first would be a large change to the parts of the wallet that move
// money, for a screen that today has one row on it.
//
// ── THE HONESTY RULES APPLY HERE TOO ─────────────────────────────────────────
//
// This row shows the same figures as the hero, so it degrades the same way, from the same unions.
// A side that could not be read says so rather than showing a zero, and the row's total goes
// through totalPillValue — the same function the service rail and the chat pill use — so a settling
// or unreadable total cannot become a confident number here just because the type is smaller.
//
// NO FIAT YET. The design's right-hand column is a dollar figure with the token amount beneath it.
// There is no price source in the app, so the token amount is the primary figure for now and the
// dollar line arrives with the price wiring. An invented or zeroed dollar value would be the exact
// confident-wrong-number this wallet is built to refuse.

import { C, MONO } from './tokens'
import { Eye, Shield } from './icons'
import { fiatForTotal } from './fiat'
import { MASK_SHORT, fmt6 } from './format'
import type { BalanceView } from './balances'
import { totalPillValue } from './TotalHero'
import type { TotalView } from './total'

const rowBase = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '11px 14px', borderRadius: 'var(--r-md)',
} as const

const iconTile = {
  width: 36, height: 36, borderRadius: 11, overflow: 'hidden',
  border: '1px solid var(--border)', flexShrink: 0, display: 'block',
} as const

/** One side's amount in the compact sub-row. Small, mono, and never a zero it cannot vouch for. */
function SideAmount({ kind, balance, hidden }: {
  kind: 'shielded' | 'unshielded'; balance: BalanceView; hidden: boolean
}) {
  const Icon = kind === 'shielded' ? Shield : Eye
  const label = kind === 'shielded' ? 'Shielded' : 'Unshielded'

  const text = () => {
    if (hidden) return MASK_SHORT
    if (balance.status === 'loading') return 'checking…'
    if (balance.status === 'unavailable') return 'unavailable'
    return fmt6(balance.microtari)
  }

  return (
    <span
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        color: !hidden && balance.status === 'unavailable' ? 'var(--warn)' : 'var(--text-muted-dim)',
      }}
    >
      <Icon size={9} color="currentColor" />
      <span>{text()}</span>
    </span>
  )
}

export interface AssetsPanelProps {
  /** The SHIELDED balance — prop keeps the name of the state it derives from. */
  privateBalance: BalanceView
  /** The UNSHIELDED balance. */
  publicBalance: BalanceView
  /** The row's right-hand figure. Same union, same rules, as the hero's. */
  total: TotalView
  hidden: boolean
  /**
   * Opens the asset's own page.
   *
   * OPTIONAL, AND THE AFFORDANCE FOLLOWS IT. The detail page does not exist yet, so no handler is
   * passed and the row renders inert — no chevron, no pointer, no hover. A row that looked
   * clickable and did nothing would be a dead control, which is worse than one not yet offered.
   * Stage 9 passes a handler and the affordance appears with it.
   */
  onOpen?: () => void
}

export function AssetsPanel({ privateBalance, publicBalance, total, hidden, onOpen }: AssetsPanelProps) {
  const live = !!onOpen

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)', padding: 6, boxShadow: 'var(--e1)',
    }}>
      <div style={{ padding: '12px 14px 8px', fontSize: 13.5, fontWeight: 600, color: C.primary }}>Assets</div>

      {/* ── XTR: the one real asset ── */}
      <div
        role={live ? 'button' : undefined}
        tabIndex={live ? 0 : undefined}
        onClick={onOpen}
        onKeyDown={live ? (e => e.key === 'Enter' && onOpen()) : undefined}
        className={live ? 'cv-asset-row' : undefined}
        style={{ ...rowBase, cursor: live ? 'pointer' : 'default' }}
      >
        <img src="/partner-tari.jpg" alt="" aria-hidden="true" style={{ ...iconTile, objectFit: 'cover' }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.primary }}>XTR</span>
          <span style={{
            display: 'flex', alignItems: 'center', gap: 12, marginTop: 3, flexWrap: 'wrap',
            fontFamily: MONO, fontSize: 11,
          }}>
            <SideAmount kind="shielded" balance={privateBalance} hidden={hidden} />
            <SideAmount kind="unshielded" balance={publicBalance} hidden={hidden} />
          </span>
        </span>
        <span style={{ textAlign: 'right', flexShrink: 0 }}>
          <span style={{
            display: 'block', fontSize: 14, fontWeight: 600, fontFeatureSettings: "'tnum'",
            // Bright only when the figure is a fact. `···` and `—` stay muted, so the row can never
            // look like it is reporting a holding it is in fact refusing to state.
            color: hidden || total.status === 'ready' ? C.primary : C.mutedDim,
          }}>
            {/* The dollar figure only exists when the balance does; otherwise this is the same
                `···` / `—` the hero and the rail show, and there is nothing to price. */}
            {hidden ? totalPillValue(total, hidden) : fiatForTotal(total) ?? totalPillValue(total, hidden)}
          </span>
          {!hidden && total.status === 'ready' && (
            <span style={{
              display: 'block', fontFamily: MONO, fontSize: 11,
              color: 'var(--text-muted-dim)', marginTop: 2, whiteSpace: 'nowrap',
            }}>{fmt6(total.microtari)} XTR</span>
          )}
        </span>
        {live && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M9 18l6-6-6-6" />
          </svg>
        )}
      </div>

      {/* ── Wrapped XTM: announced, not yet real ── */}
      <div style={{ ...rowBase, opacity: 0.75, cursor: 'default' }}>
        <img
          src="/partner-tari.jpg" alt="" aria-hidden="true"
          style={{ ...iconTile, objectFit: 'cover', filter: 'grayscale(1)', opacity: 0.7 }}
        />
        <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-body-dim)' }}>Wrapped XTM</span>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--text-muted-dim)' }}>wXTM</span>
        </span>
        <span style={{
          padding: '3px 9px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border)',
          fontSize: 11, fontWeight: 600, color: 'var(--text-muted-dim)', flexShrink: 0,
        }}>Coming soon</span>
      </div>

      {/* ── The shape of the thing, said once ── */}
      <div style={{
        ...rowBase, margin: '2px 6px 6px',
        border: '1px dashed var(--border-strong)',
      }}>
        <span style={{
          width: 30, height: 30, borderRadius: 9, border: '1px solid var(--border)',
          color: 'var(--text-muted-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-muted-dim)' }}>More assets coming</span>
          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted-dim)', opacity: 0.8, marginTop: 1, lineHeight: 1.45 }}>
            The Ootle is multi-token. Your portfolio grows here.
          </span>
        </span>
      </div>
    </div>
  )
}
