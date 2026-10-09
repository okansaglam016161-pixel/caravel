// The Burn page: the Caravel Burn Wallet's verified total, a way to add to it, and every burn.
//
// Its own section of the shell, laid out like the wallet page — the same column, header cluster,
// dark hero and list card — so it reads as part of the same app.
//
// NO ADDRESSES ANYWHERE. A burn row says how TARI was burned (public or private) and whether it was
// you, never who. The burn wallet's own address lives behind "Verify it yourself".

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { BURN_WALLET_COMPONENT, BURN_WALLET_REPO_URL } from '../../crypto/burnWallet'
import { explorerSubstateUrl, explorerTxUrl } from '../../crypto/explorer'
import { useBurnWallet, type HeroState, type ListState } from '../../hooks/useBurnWallet'
import ThemeToggle from '../primitives/ThemeToggle'
import { TICKER, fmt6 } from '../wallet/v2/format'
import { Flame, Refresh, Spinner } from '../wallet/v2/icons'
import { Body, HeaderIcon, ModalShell, RootHeader } from '../wallet/v2/primitives'
import { C, MONO, PAGE_MAX_WIDTH } from '../wallet/v2/tokens'
import BurnSheet from './BurnSheet'
import { burnTimeLabel, burnTitle, compactSupply, formatSupplyPercent, shortTx, type BurnRow } from './burnModel'

export default function BurnPage({ active }: { active: boolean }) {
  const { address } = useWallet()
  const { hero, list, refreshing, refresh, watchFor } = useBurnWallet(address, active)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [tab, setTab] = useState<'recent' | 'mine'>('recent')

  const baseline = hero.status === 'verified' ? hero.reading.totalDeposited
    : hero.status === 'updating' ? hero.last?.totalDeposited ?? null : null

  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      <div style={{
        width: '100%', maxWidth: PAGE_MAX_WIDTH, margin: '0 auto', boxSizing: 'border-box',
        padding: 'clamp(16px, 3vw, 32px) clamp(16px, 3vw, 32px) 48px',
      }}>
        <ModalShell chrome="page">
          <RootHeader title="Burn" chip="ESMERALDA TESTNET" chrome="page" right={<>
            <HeaderIcon label="Refresh the burn wallet" onClick={() => { void refresh() }} busy={refreshing}>
              <Refresh color="currentColor" />
            </HeaderIcon>
            <ThemeToggle size={30} />
          </>} />
          <Body gap={14} pageGap={12} chrome="page">
            <Hero hero={hero} refreshing={refreshing} onBurn={() => setSheetOpen(true)} onRetry={() => { void refresh() }} />
            <LottoTeaser />
            <BurnList list={list} tab={tab} onTab={setTab} />
          </Body>
        </ModalShell>
      </div>

      {sheetOpen && (
        <BurnSheet
          onClose={() => setSheetOpen(false)}
          onBurned={(amount, txId) => watchFor(baseline, amount, txId)}
        />
      )}
    </div>
  )
}

// ── Hero ──────────────────────────────────────────────────────────────────────

/**
 * The verified total, on the wallet hero's dark ground. Four states, per the design: loading,
 * verified, updating (nothing verified on the latest read — the last verified figure, dimmed), and
 * unreachable. A verified figure carries NO badge: every figure shown here is verified, so a badge
 * would only restate the rule. What is marked is the exception — "Updating…", while a refresh runs
 * or while no verified reading has answered, so an unconfirmed figure never reads as final.
 */
function Hero({ hero, refreshing, onBurn, onRetry }: { hero: HeroState; refreshing: boolean; onBurn: () => void; onRetry: () => void }) {
  return (
    <div data-theme="dark" style={{
      position: 'relative', overflow: 'hidden',
      background: 'var(--nav-ground)', border: '1px solid var(--border)',
      borderRadius: 18, padding: '36px 32px 32px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', color: C.bright,
    }}>
      {/* The large flame watermark the design draws behind the figure. */}
      <span aria-hidden="true" style={{ position: 'absolute', right: -90, bottom: -110, opacity: 0.07, color: 'var(--accent-400)', pointerEvents: 'none' }}>
        <Flame size={320} color="currentColor" width={1} />
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 36, height: 36, borderRadius: 10, background: 'rgba(var(--accent-400-rgb),0.18)', color: 'var(--accent-300)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Flame size={18} color="currentColor" /></span>
        <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>Caravel Burn Wallet</span>
      </div>

      {hero.status === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, margin: '34px 0 8px' }}>
          <Spinner size={18} />
          <div style={{ fontSize: 13, color: 'var(--vault-label)' }}>Reading the burn wallet…</div>
        </div>
      )}

      {hero.status === 'unreachable' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, margin: '28px 0 4px' }}>
          <span style={{
            width: 36, height: 36, borderRadius: '50%', background: 'rgba(var(--warn-rgb),0.14)', color: 'var(--warn)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12.5a7 7 0 0 1 14 0" /><path d="M8.5 15.5a4 4 0 0 1 7 0" /><path d="M12 18.5h.01" /></svg>
          </span>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Couldn’t reach the network</div>
          <div style={{ fontSize: 12, color: 'var(--vault-label)', lineHeight: 1.5, maxWidth: 260 }}>
            The burn total can’t be shown right now. Nothing has changed on chain.
          </div>
          <button onClick={onRetry} style={{
            marginTop: 4, padding: '7px 16px', borderRadius: 8, border: '1px solid var(--warn)', background: 'transparent',
            color: 'var(--warn)', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>Try again</button>
        </div>
      )}

      {(hero.status === 'verified' || hero.status === 'updating') && (() => {
        const reading = hero.status === 'verified' ? hero.reading : hero.last
        const dim = hero.status === 'updating'
        const updating = hero.status === 'updating' || refreshing
        return (
          <>
            <div style={{
              fontSize: 56, fontWeight: 600, letterSpacing: '-0.025em', fontFeatureSettings: "'tnum'",
              marginTop: 30, lineHeight: 1, color: dim ? 'var(--vault-label)' : C.bright,
            }}>{reading ? fmtBurned(reading.balance) : '—'}</div>
            <div style={{ fontFamily: MONO, fontSize: 13, color: 'var(--vault-label)', marginTop: 12 }}>tTARI burned forever</div>
            {/* Of the VERIFIED total only — the same reading as the figure, dimmed with it. */}
            {reading && (
              <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--vault-label)', marginTop: 6, opacity: dim ? 0.6 : 0.8 }}>
                {formatSupplyPercent(reading.balance)}% of {compactSupply()} supply
              </div>
            )}
            {updating && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, marginTop: 26,
                background: 'rgba(255,255,255,0.08)', color: 'var(--vault-label)', fontSize: 11.5, fontWeight: 600,
              }}><Spinner size={10} />Updating…</span>
            )}
            {dim && (
              <div style={{ fontSize: 11.5, color: 'var(--vault-label)', marginTop: 8 }}>
                {reading ? 'Last verified figure. Checking the chain.' : 'Waiting for a verified reading.'}
              </div>
            )}
          </>
        )
      })()}

      <button onClick={onBurn} className="cv-vault-action" style={{
        marginTop: 26, padding: '13px 28px', borderRadius: 12, border: 'none', cursor: 'pointer',
        background: 'var(--accent-400)', color: '#FFFFFF', fontFamily: 'inherit', fontSize: 15, fontWeight: 600,
        display: 'inline-flex', alignItems: 'center', gap: 8, position: 'relative',
      }}><Flame size={15} color="currentColor" width={2} />Burn TARI</button>

      <div style={{ display: 'flex', gap: 22, marginTop: 22, fontSize: 12.5, fontWeight: 500, position: 'relative' }}>
        <a href={explorerSubstateUrl(BURN_WALLET_COMPONENT)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-300)', textDecoration: 'none' }}>Verify it yourself</a>
        <a href={BURN_WALLET_REPO_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-300)', textDecoration: 'none' }}>GitHub</a>
      </div>
    </div>
  )
}

/** The headline figure: whole TARI grouped, decimals only when there are any. "1,000" / "1,000.2". */
function fmtBurned(microtari: bigint): string {
  const [whole, frac] = fmt6(microtari).split('.')
  const trimmed = frac.replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

// ── Lotto teaser ──────────────────────────────────────────────────────────────

/** A teaser, not a door: the Lotto gets its own page later, and this card will link there. */
function LottoTeaser() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--e1)',
    }}>
      <span style={{
        width: 38, height: 38, borderRadius: 11, flexShrink: 0, background: 'var(--accent-wash)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" /><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" />
          <circle cx="12" cy="12" r="1.3" fill="currentColor" />
          <circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" /><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.primary }}>Caravel Lotto</div>
        <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 2 }}>The Ootle’s first burn game. Coming soon.</div>
      </div>
      <span style={{
        padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border)',
        fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: C.mutedDim, flexShrink: 0,
      }}>SOON</span>
    </div>
  )
}

// ── Burns list ────────────────────────────────────────────────────────────────

function BurnList({ list, tab, onTab }: { list: ListState; tab: 'recent' | 'mine'; onTab: (t: 'recent' | 'mine') => void }) {
  const rows = list.status === 'ready' ? (tab === 'recent' ? list.rows : list.rows.filter(r => r.byYou)) : []
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
      boxShadow: 'var(--e1)', overflow: 'hidden',
    }}>
      <div role="tablist" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 12px 0', borderBottom: '1px solid var(--border)' }}>
        <Tab on={tab === 'recent'} onClick={() => onTab('recent')}>Recent burns</Tab>
        <Tab on={tab === 'mine'} onClick={() => onTab('mine')}>Your burns</Tab>
      </div>
      <div style={{ padding: '6px 8px 8px' }}>
        {list.status === 'loading' && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '28px 16px', fontSize: 12.5, color: C.mutedDim }}>
            <Spinner size={12} />Reading the burns…
          </div>
        )}
        {list.status === 'error' && (
          <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12.5, color: C.mutedDim }}>
            The burns couldn’t be read right now. Refresh to try again.
          </div>
        )}
        {list.status === 'ready' && rows.map(r => <BurnRowView key={r.key} row={r} />)}
        {list.status === 'ready' && rows.length === 0 && (
          <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12.5, color: C.mutedDim }}>
            {tab === 'mine' ? 'No burns from you yet. Yours will appear here once verified on chain.' : 'No burns yet.'}
          </div>
        )}
        {list.status === 'ready' && !list.complete && (
          <div style={{ padding: '10px 10px 4px', fontSize: 11.5, color: C.faint, textAlign: 'center' }}>
            The list is still catching up with the verified total.
          </div>
        )}
        {list.status === 'ready' && list.total > list.rows.length && (
          <div style={{ padding: '10px 10px 4px', fontSize: 11.5, color: C.faint, textAlign: 'center' }}>
            Showing the latest {list.rows.length} of {list.total.toLocaleString('en-US')} burns.
          </div>
        )}
      </div>
    </div>
  )
}

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <span role="tab" tabIndex={0} aria-selected={on} onClick={onClick} onKeyDown={e => e.key === 'Enter' && onClick()} style={{
      padding: '8px 12px 11px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', userSelect: 'none', marginBottom: -1,
      borderBottom: `2px solid ${on ? 'var(--accent-400)' : 'transparent'}`,
      color: on ? C.primary : C.mutedDim,
    }}>{children}</span>
  )
}

function BurnRowView({ row }: { row: BurnRow }) {
  const how = row.source === 'public' ? 'Public' : row.source === 'private' ? 'Private' : null
  const sub = [row.byYou ? how : null, burnTimeLabel(row.at, row.exact)].filter(Boolean).join(' · ')
  return (
    <div className="cv-activity-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderRadius: 9 }}>
      <span style={{
        width: 34, height: 34, borderRadius: 10, flexShrink: 0, background: 'var(--accent-wash)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Flame size={14} color="currentColor" /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.primary }}>{burnTitle(row)}</div>
        <div style={{ fontSize: 12, color: C.mutedDim, marginTop: 1, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <a href={explorerTxUrl(row.txId)} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }} title="View in the explorer">
            {shortTx(row.txId)}
          </a>{' · '}{sub}
        </div>
      </div>
      <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 500, flexShrink: 0, color: C.primary }}>{fmt6(row.amount)} {TICKER}</span>
    </div>
  )
}
