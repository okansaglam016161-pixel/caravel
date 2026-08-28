// The XTR asset page.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT ────────────────────────────────────────
//
// The BALANCES are real: the same scan and revealed reads the overview uses, degrading the same
// way, priced by the same fixed-rate formatter. The PRICE HISTORY is not real and this page says so
// rather than drawing it.
//
// The design fills the chart slot with a rising line and a "+2.4% today" pill. Both would be
// inventions: XTR has no market price on a testnet, the rate is one fixed constant, and a constant
// has no history and no daily change. A drawn line is the most persuasive kind of wrong number
// there is — it does not look like a placeholder, it looks like data. So the slot is built,
// designed and empty, and the change pill is absent entirely rather than showing a fabricated
// percentage or a hollow "0.0%".
//
// The timeframe tabs are kept and inert for the same reason: the control belongs to the layout, and
// removing it now would mean re-inventing the row at mainnet. Inert and visibly so beats a tab that
// responds by changing nothing.
//
// ── EVERY ACTION REUSES THE OVERVIEW'S ───────────────────────────────────────
//
// Shield, unshield, send and receive are the SAME callbacks the overview passes, so this page opens
// the same sheets over the same state machines. Nothing about a payment changes because it was
// started from here; there is no second copy of any flow.

import type { ReactNode } from 'react'
import { C, MONO } from './tokens'
import { Eye, Shield, Spinner } from './icons'
import { MASK_SHORT, fmt6 } from './format'
import { RATE_LABEL, fiatForBalance, fiatForTotal } from './fiat'
import type { BalanceView } from './balances'
import type { TotalView } from './total'
import { DIR, type EntryProps } from './move'
import { RecentActivity } from './panels'

const TIMEFRAMES = ['1D', '1W', '1M', '1Y'] as const

export interface AssetDetailProps {
  /** The SHIELDED balance. Prop keeps the name of the state it derives from. */
  privateBalance: BalanceView
  /** The UNSHIELDED balance. */
  publicBalance: BalanceView
  total: TotalView
  hidden: boolean
  /** The shield / unshield entries, with their disabled reasons — the overview's, unchanged. */
  entries: EntryProps[]
  activity: ReactNode[]
  onBack: () => void
  onSend: () => void
  onReceive: () => void
  onViewAllActivity: () => void
}

/** One side of the holdings split, with the move that acts on it. */
function HoldingSide({ kind, balance, hidden, entry }: {
  kind: 'shielded' | 'unshielded'; balance: BalanceView; hidden: boolean; entry?: EntryProps
}) {
  const Icon = kind === 'shielded' ? Shield : Eye
  // Shielded funds are what an UNSHIELD spends, and vice versa — the action on a card is the one
  // that moves the balance printed above it.
  const isUnshield = kind === 'shielded'
  const dead = !entry || !!entry.disabledReason

  const value = () => {
    if (hidden) return <div style={{ fontFamily: MONO, fontSize: 15, color: C.bright, marginTop: 5 }}>{MASK_SHORT}</div>
    if (balance.status === 'loading') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7 }}>
          <Spinner size={12} /><span style={{ fontSize: 12.5, color: 'var(--vault-label)' }}>Checking</span>
        </div>
      )
    }
    if (balance.status === 'unavailable') {
      return (
        <div style={{ marginTop: 6 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', padding: '3px 9px', borderRadius: 'var(--r-pill)',
            background: 'rgba(var(--warn-rgb),0.12)', color: 'var(--warn)', fontSize: 11, fontWeight: 600,
          }}>Unavailable</span>
        </div>
      )
    }
    return (
      <>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.bright, fontFeatureSettings: "'tnum'", marginTop: 5 }}>
          {fiatForBalance(balance) ?? fmt6(balance.microtari)}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--vault-label)', marginTop: 2 }}>
          {fmt6(balance.microtari)} XTR
        </div>
      </>
    )
  }

  return (
    <div style={{ background: 'var(--vault-card)', borderRadius: 11, padding: '13px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon size={11} color="var(--vault-label)" />
        <span style={{ fontSize: 11.5, fontWeight: 500, color: C.bodyDim }}>
          {kind === 'shielded' ? 'Shielded' : 'Unshielded'}
        </span>
      </div>
      {value()}

      <span
        role={dead ? undefined : 'button'} tabIndex={dead ? -1 : 0} aria-disabled={dead}
        title={entry?.disabledReason}
        onClick={dead ? undefined : entry!.onClick}
        onKeyDown={e => { if (!dead && e.key === 'Enter') entry!.onClick?.() }}
        style={{
          display: 'block', textAlign: 'center', marginTop: 11, padding: 8, borderRadius: 8,
          fontSize: 12, fontWeight: 600, userSelect: 'none',
          cursor: dead ? 'not-allowed' : 'pointer',
          opacity: dead ? 0.5 : 1,
          // Amber for the irreversible direction, blue for the routine one — the same pairing the
          // overview entries and the move sheet use, so the colour means one thing throughout.
          background: isUnshield ? 'var(--warn)' : 'var(--accent-400)',
          color: isUnshield ? 'var(--nav-ground)' : '#FFFFFF',
        }}
      >{isUnshield ? DIR.reveal.title : DIR.conceal.title}</span>

      {/* An absent control cannot explain itself, so a dead one states its reason here too. */}
      {entry?.disabledReason && (
        <div style={{ fontSize: 10.5, color: 'var(--vault-label)', marginTop: 6, lineHeight: 1.4 }}>
          {entry.disabledReason}
        </div>
      )}
    </div>
  )
}

export function AssetDetail(p: AssetDetailProps) {
  const conceal = p.entries.find(e => e.dir === 'conceal')
  const reveal = p.entries.find(e => e.dir === 'reveal')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span
        role="button" tabIndex={0} onClick={p.onBack} onKeyDown={e => e.key === 'Enter' && p.onBack()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
          fontSize: 13, fontWeight: 600, color: 'var(--accent-ink)', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Wallet
      </span>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
        <img src="/partner-tari.jpg" alt="" aria-hidden="true" style={{
          width: 44, height: 44, borderRadius: 13, objectFit: 'cover',
          border: '1px solid var(--border)', flexShrink: 0, display: 'block',
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em', color: C.primary }}>XTR</div>
          <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 1 }}>Tari · the Ootle</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 600, fontFeatureSettings: "'tnum'", color: C.primary }}>$0.0004</div>
          {/* No change pill. A fixed rate has no daily movement, and "0.0%" would imply a market
              that had held steady rather than one that does not exist yet. */}
          <div style={{ fontSize: 11.5, color: C.mutedDim, marginTop: 2 }}>{RATE_LABEL}</div>
        </div>
      </div>

      {/* ── Price history ──────────────────────────────────────────────────────
          A FLAT LINE, BECAUSE THE RATE IS FLAT. This is not a placeholder standing in for data — it
          is an accurate plot of a constant: XTR is priced by one fixed testnet rate, so its history
          is a horizontal line and drawing anything else would be invention.

          The whole risk of a flat line is that it reads as a broken chart, so the level is labelled
          on the plot and the corner says what it is. When a feed is wired at mainnet this becomes a
          real series and the labels come off; the slot, the axis and the tabs are already here. */}
      <div>
        <div style={{
          position: 'relative', height: 150, borderRadius: 'var(--r-lg)',
          border: '1px solid var(--border)', background: 'var(--surface-void)', overflow: 'hidden',
        }}>
          <svg viewBox="0 0 600 150" preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
            <path d="M0,66 L600,66 L600,150 L0,150 Z" fill="rgba(var(--accent-400-rgb),0.10)" />
            <path d="M0,66 L600,66" fill="none" stroke="var(--accent-400)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
          {/* The level, named on the plot — the one thing that turns a flat line from "broken" into
              "unchanged, and here is what it is unchanged at". */}
          {/* The plot is a fixed 150 tall and the line sits at y=66, so the label is placed against
              those numbers directly rather than through a percentage that would drift if either
              changed. */}
          <span style={{
            position: 'absolute', left: 14, top: 40,
            fontFamily: MONO, fontSize: 11.5, fontWeight: 500, color: C.mutedDim,
          }}>$0.0004 · fixed testnet rate</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 12 }}>
          <div
            aria-disabled
            title="Available at mainnet"
            style={{
              display: 'flex', gap: 4, padding: 3, borderRadius: 9,
              background: 'var(--surface-void)', border: '1px solid var(--border)',
              opacity: 0.55, cursor: 'not-allowed',
            }}
          >
            {TIMEFRAMES.map(t => (
              <span key={t} style={{ padding: '5px 13px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: C.mutedDim, userSelect: 'none' }}>{t}</span>
            ))}
          </div>
          <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.12em', color: C.mutedDim, flexShrink: 0 }}>
            ILLUSTRATIVE · FIXED TESTNET RATE
          </span>
        </div>
      </div>

      {/* ── Your holdings. The vault, navy in both themes — see TotalHero. ── */}
      <div data-theme="dark" style={{
        background: 'var(--nav-ground)', border: '1px solid var(--border)',
        borderRadius: 16, padding: 22,
      }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--vault-label)' }}>Your holdings</div>
        {p.hidden ? (
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 500, color: C.bright, marginTop: 8 }}>{MASK_SHORT}</div>
        ) : p.total.status === 'ready' ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.03em', color: C.bright, fontFeatureSettings: "'tnum'" }}>
              {fiatForTotal(p.total)}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12.5, color: 'var(--accent-300)' }}>{fmt6(p.total.microtari)} XTR</span>
          </div>
        ) : (
          // No total, no figure — the same rule the hero follows, for the same reason.
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10 }}>
            {p.total.status === 'settling' || p.total.status === 'loading' ? <Spinner size={14} /> : null}
            <span style={{ fontSize: 13.5, color: C.bodyDim }}>
              {p.total.status === 'settling' ? 'Settling, this can take a moment'
                : p.total.status === 'loading' ? 'Checking your balances'
                : 'Balance unreadable right now'}
            </span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
          <HoldingSide kind="shielded" balance={p.privateBalance} hidden={p.hidden} entry={reveal} />
          <HoldingSide kind="unshielded" balance={p.publicBalance} hidden={p.hidden} entry={conceal} />
        </div>
      </div>

      {/* ── Send / Receive — the overview's own callbacks ── */}
      <div style={{ display: 'flex', gap: 10 }}>
        <span role="button" tabIndex={0} onClick={p.onSend} onKeyDown={e => e.key === 'Enter' && p.onSend()}
          style={{
            flex: 1, textAlign: 'center', padding: 11, borderRadius: 'var(--r-md)',
            fontSize: 13.5, fontWeight: 600, cursor: 'pointer', userSelect: 'none',
            background: 'var(--accent-400)', color: '#FFFFFF',
          }}>Send</span>
        <span role="button" tabIndex={0} onClick={p.onReceive} onKeyDown={e => e.key === 'Enter' && p.onReceive()}
          style={{
            flex: 1, textAlign: 'center', padding: 11, borderRadius: 'var(--r-md)',
            fontSize: 13.5, fontWeight: 600, cursor: 'pointer', userSelect: 'none',
            background: 'transparent', color: C.primary, border: '1px solid var(--border-strong)',
          }}>Receive</span>
      </div>

      {/* ── This asset's activity. XTR is the only asset, so this is all of it. ── */}
      <RecentActivity rows={p.activity} onViewAll={p.onViewAllActivity} />
    </div>
  )
}
