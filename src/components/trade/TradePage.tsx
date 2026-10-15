// The Trade page (Caravel Trade.dc.html): balances, the order book, your orders, recent trades, and the
// sheet that places, fills and cancels. Laid out like the Burn page — same column, header cluster,
// dark cards and list card — so it reads as part of the same app.
//
// EVERY FIGURE IS THE T3 LOGIC'S. The book, your orders and recent trades come from hooks/useMarket
// (verified reads, filtered and sorted exactly — crypto/market); balances from hooks/useTradeBalances
// (a figure only once its read finished); fees only from a live quote in the sheet. Nothing here
// computes a price, a fee or a total of its own — tradeModel formats what those return.
//
// HONEST STATES, per the design (§03): reading (no figures), updating (a refresh you asked for — the
// rows dim), can't reach the network (the last data, dimmed, with the time it was read, and Retry),
// an empty book, and "taken" in the sheet. A background poll does not dim anything; the refresh icon
// spins.
//
// NO SPREAD. The design leaves it off the page and so does this.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { CUSD_ASSET } from '../../crypto/assets'
import type { BookEntry } from '../../crypto/market'
import { SELL, type OrderSide, type TradeMode } from '../../crypto/tradeConfig'
import { useMarket } from '../../hooks/useMarket'
import { useTradeBalances, type Amount } from '../../hooks/useTradeBalances'
import { useTrades } from '../../hooks/useTrades'
import ThemeToggle from '../primitives/ThemeToggle'
import CusdFaucetClaimPanel from '../wallet/CusdFaucetClaimPanel'
import { fmt6 } from '../wallet/v2/format'
import { Eye, Flame, Lock, Refresh, Spinner } from '../wallet/v2/icons'
import { Body, HeaderIcon, ModalShell, RootHeader } from '../wallet/v2/primitives'
import { C, MONO, PAGE_MAX_WIDTH } from '../wallet/v2/tokens'
import TradeSheet, { type SheetMode } from './TradeSheet'
import { TTARI, fmtCusd, fmtPrice, myOrderView, timeLabel, tradeRowView, usdOf, type MyOrderView } from './tradeModel'

type Tab = 'book' | 'mine' | 'trades'

export default function TradePage() {
  const { address, rescan } = useWallet()
  const market = useMarket()
  const balances = useTradeBalances()
  const records = useTrades(address)
  const [tab, setTab] = useState<Tab>('book')
  const [sheet, setSheet] = useState<SheetMode | null>(null)
  /** A refresh the person asked for: rows dim while it runs (a background poll does not). */
  const [manual, setManual] = useState(false)

  const data = market.data
  const refresh = () => {
    setManual(true)
    void market.refresh().finally(() => setManual(false))
  }
  const afterTrade = () => { rescan(); void market.refresh() }

  /** Where a cancelled order's escrow goes: back the way it came, as this device recorded it. */
  const cancelTo = (orderId: string): TradeMode =>
    records.find(r => r.action === 'place' && r.orderId === orderId)?.pays?.mode ?? 'private'
  const openCancel = (o: { orderId: string; side: OrderSide; n: bigint; p: bigint; price: BookEntry['price']; cancelIndex: number | null }) => {
    if (o.cancelIndex === null) return
    setSheet({ kind: 'cancel', order: { orderId: o.orderId, side: o.side, n: o.n, p: o.p, price: o.price, cancelIndex: o.cancelIndex, to: cancelTo(o.orderId) } })
  }

  const stale = market.status === 'unreachable' && data !== null
  const dim = stale ? 0.6 : manual && market.status === 'updating' ? 0.55 : 1

  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      <div style={{
        width: '100%', maxWidth: PAGE_MAX_WIDTH, margin: '0 auto', boxSizing: 'border-box',
        padding: 'clamp(16px, 3vw, 32px) clamp(16px, 3vw, 32px) 48px',
      }}>
        <ModalShell chrome="page">
          <RootHeader title="Trade" chip="ESMERALDA TESTNET" chrome="page" right={<>
            <HeaderIcon label="Refresh the market" onClick={refresh} busy={market.status === 'updating' || market.status === 'loading'}>
              <Refresh color="currentColor" />
            </HeaderIcon>
            <ThemeToggle size={30} />
          </>} />
          <Body gap={14} pageGap={14} chrome="page">
            <BalanceCards balances={balances} />
            <CusdFaucetClaimPanel />

            <div role="tablist" style={{ display: 'flex', gap: 18, borderBottom: '1px solid var(--border)' }}>
              <TabButton on={tab === 'book'} onClick={() => setTab('book')}>Order book</TabButton>
              <TabButton on={tab === 'mine'} onClick={() => setTab('mine')}>My orders</TabButton>
              <TabButton on={tab === 'trades'} onClick={() => setTab('trades')}>Recent trades</TabButton>
            </div>

            {stale && <UnreachableBar at={data!.at} onRetry={refresh} />}
            {manual && market.status === 'updating' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.mutedDim }}><Spinner size={11} />Updating…</div>
            )}

            {data === null && market.status !== 'unreachable' && <Loading />}
            {data === null && market.status === 'unreachable' && <Unreachable onRetry={refresh} />}

            {data !== null && tab === 'book' && (
              <div style={{ opacity: dim, transition: 'opacity .2s' }}>
                {data.book.sells.length + data.book.buys.length === 0
                  ? <EmptyBook onPlace={() => setSheet({ kind: 'place', side: 1 })} />
                  : (
                    <div className="cv-trade-book" style={{ border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', background: 'var(--surface)' }}>
                      <BookSide side={SELL} entries={data.book.sells} onFill={e => setSheet({ kind: 'fill', entry: e })} onCancel={openCancel} />
                      <BookSide side={1} entries={data.book.buys} onFill={e => setSheet({ kind: 'fill', entry: e })} onCancel={openCancel} />
                      <div style={{ gridColumn: '1 / -1', padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11.5, color: C.mutedDim, display: 'flex', alignItems: 'center', gap: 6 }}>
                        1% trade fee in {TTARI} · 0.7% Caravel, 0.3% burned <Flame size={11} color="var(--accent-ink)" />
                      </div>
                    </div>
                  )}
              </div>
            )}
            {data !== null && tab === 'book' && (
              <div className="cv-trade-actions" style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setSheet({ kind: 'place', side: SELL })} className="cv-quiet-btn" style={actionBtn(false)}>Place sell order</button>
                <button onClick={() => setSheet({ kind: 'place', side: 1 })} className="cv-vault-action" style={actionBtn(true)}>Place buy order</button>
              </div>
            )}

            {data !== null && tab === 'mine' && (
              <ListCard dim={dim}>
                {data.mine.length === 0
                  ? <EmptyLine>No orders yet. Orders you place appear here, including after a restore.</EmptyLine>
                  : data.mine.map(m => <MyOrderRow key={m.orderId} v={myOrderView(m)} onCancel={() => openCancel(m)} />)}
              </ListCard>
            )}

            {data !== null && tab === 'trades' && (
              <ListCard dim={dim}>
                <div className="cv-trade-trow" style={{ padding: '10px 16px', fontFamily: MONO, fontSize: 9.5, letterSpacing: '.1em', color: C.mutedDim }}>
                  <span>SIDE</span><span style={{ textAlign: 'right' }}>AMOUNT {TTARI}</span><span style={{ textAlign: 'right' }}>PRICE cUSD</span><span style={{ textAlign: 'right' }}>TIME</span>
                </div>
                {data.recent === null && <EmptyLine>Recent trades couldn’t be read just now.</EmptyLine>}
                {data.recent?.length === 0 && <EmptyLine>No trades yet.</EmptyLine>}
                {data.recent?.map(t => {
                  const v = tradeRowView(t)
                  return (
                    <div key={v.key} className="cv-trade-trow" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontFamily: MONO, fontSize: 12, alignItems: 'center' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, color: v.side === 'Buy' ? 'var(--positive)' : 'var(--danger-500)' }}>
                        {v.side}{v.yours && <YoursBadge />}
                      </span>
                      <span style={{ textAlign: 'right', color: C.primary }}>{v.amount}</span>
                      <span style={{ textAlign: 'right', color: C.primary }}>{v.price}</span>
                      <span style={{ textAlign: 'right', color: C.mutedDim }}>{v.time}</span>
                    </div>
                  )
                })}
              </ListCard>
            )}
          </Body>
        </ModalShell>
      </div>

      {sheet && (
        <TradeSheet mode={sheet} board={data?.board ?? null} onClose={() => setSheet(null)} onTraded={afterTrade} />
      )}
    </div>
  )
}

// ── Balances ─────────────────────────────────────────────────────────────────

/** A figure only when its read finished: `···` while reading, `—` when it could not be read. */
const fig = (a: Amount, f: (v: bigint) => string) => (a.status === 'ready' ? f(a.value) : a.status === 'loading' ? '···' : '—')

function BalanceCards({ balances }: { balances: ReturnType<typeof useTradeBalances> }) {
  const t = balances.tariTotal
  const tariTotal = t.status === 'ready' ? fmt6(t.microtari) : t.status === 'unreadable' ? '—' : '···'
  const cusdTotal = balances.cusd.total
  return (
    <div className="cv-trade-grid2" style={{ gap: 12 }}>
      <DarkCard tile="T" tileTone="accent" name={TTARI} figure={tariTotal}
        priv={fig(balances.tari.private, v => fmt6(v))} pub={fig(balances.tari.public, v => fmt6(v))} />
      <DarkCard tile="$" tileTone="positive" name={CUSD_ASSET.ticker}
        usd={cusdTotal.status === 'ready' ? `≈ ${usdOf(cusdTotal.value)}` : undefined}
        figure={fig(cusdTotal, fmtCusd)} priv={fig(balances.cusd.private, fmtCusd)} pub={fig(balances.cusd.public, fmtCusd)} />
    </div>
  )
}

function DarkCard({ tile, tileTone, name, usd, figure, priv, pub }: {
  tile: string; tileTone: 'accent' | 'positive'; name: string; usd?: string; figure: string; priv: string; pub: string
}) {
  return (
    <div data-theme="dark" style={{ background: 'var(--nav-ground)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', color: C.bright, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 26, height: 26, borderRadius: 99, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: MONO, fontSize: 10, fontWeight: 600,
          background: tileTone === 'accent' ? 'rgba(var(--accent-400-rgb),0.18)' : 'rgba(var(--positive-rgb),0.16)',
          color: tileTone === 'accent' ? 'var(--accent-300)' : 'var(--positive)',
        }}>{tile}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vault-label)' }}>{name}</span>
        {usd && <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--vault-label)', opacity: 0.75 }}>{usd}</span>}
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', fontFeatureSettings: "'tnum'", marginTop: 12, fontFamily: MONO, overflowWrap: 'anywhere' }}>{figure}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 10, fontFamily: MONO, fontSize: 11, color: 'var(--vault-label)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={9} color="currentColor" />{priv} private</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Eye size={9} color="currentColor" />{pub} public</span>
      </div>
    </div>
  )
}

// ── The book ─────────────────────────────────────────────────────────────────

function BookSide({ side, entries, onFill, onCancel }: {
  side: OrderSide; entries: BookEntry[]; onFill: (e: BookEntry) => void; onCancel: (e: BookEntry) => void
}) {
  const sell = side === SELL
  return (
    <div className="cv-trade-side" style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: sell ? 'var(--danger-500)' : 'var(--positive)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.primary }}>{sell ? 'Sell orders' : 'Buy orders'}</span>
        <span style={{ fontSize: 11.5, color: C.mutedDim }}>{sell ? 'cheapest first' : 'highest first'}</span>
      </div>
      <div className="cv-trade-brow" style={{ padding: '8px 16px', fontFamily: MONO, fontSize: 9.5, letterSpacing: '.1em', color: C.mutedDim }}>
        <span>PRICE</span><span style={{ textAlign: 'right' }}>AMOUNT</span><span style={{ textAlign: 'right' }}>TOTAL cUSD</span><span />
      </div>
      {entries.length === 0 && <div style={{ padding: '14px 16px', fontSize: 12, color: C.mutedDim, borderTop: '1px solid var(--border)' }}>None right now.</div>}
      {entries.map(e => (
        <div key={e.orderId} className="cv-trade-brow cv-activity-row" style={{ padding: '9px 16px', fontFamily: MONO, fontSize: 12, borderTop: '1px solid var(--border)', alignItems: 'center' }}>
          <span style={{ color: sell ? 'var(--danger-500)' : 'var(--positive)', fontWeight: 600 }} title="cUSD per tTARI">{fmtPrice(e.price)}</span>
          <span style={{ textAlign: 'right', color: C.primary }}>{fmt6(e.n)}</span>
          <span style={{ textAlign: 'right', color: C.bodyDim }}>{fmtCusd(e.p)}</span>
          {e.yours
            ? (
              <span role="button" tabIndex={0} onClick={() => onCancel(e)} onKeyDown={k => k.key === 'Enter' && onCancel(e)}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, cursor: 'pointer' }}>
                <YoursBadge />
                <span style={{ fontFamily: 'inherit', fontSize: 11, fontWeight: 600, color: C.bodyDim }}>Cancel</span>
              </span>
            )
            : (
              <span role="button" tabIndex={0} onClick={() => onFill(e)} onKeyDown={k => k.key === 'Enter' && onFill(e)} style={{
                textAlign: 'center', padding: '5px 0', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'var(--font-sans, inherit)',
                background: sell ? 'rgba(var(--positive-rgb),0.12)' : 'rgba(var(--danger-rgb),0.12)',
                color: sell ? 'var(--positive)' : 'var(--danger-500)',
              }}>{sell ? 'Buy' : 'Sell'}</span>
            )}
        </div>
      ))}
    </div>
  )
}

// ── My orders ────────────────────────────────────────────────────────────────

const PILL: Record<MyOrderView['status'], { bg: string; ink: string }> = {
  Open: { bg: 'var(--accent-wash)', ink: 'var(--accent-ink)' },
  Filled: { bg: 'rgba(var(--positive-rgb),0.12)', ink: 'var(--positive)' },
  Unconfirmed: { bg: 'rgba(var(--warn-rgb),0.12)', ink: 'var(--warn)' },
  Cancelled: { bg: 'var(--surface-void)', ink: C.mutedDim },
}

function MyOrderRow({ v, onCancel }: { v: MyOrderView; onCancel: () => void }) {
  const sell = v.side === 'SELL'
  const done = v.status === 'Cancelled'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', borderTop: '1px solid var(--border)' }}>
      <span style={{
        width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 600,
        background: done ? 'var(--surface-void)' : sell ? 'rgba(var(--danger-rgb),0.12)' : 'rgba(var(--positive-rgb),0.12)',
        color: done ? C.mutedDim : sell ? 'var(--danger-500)' : 'var(--positive)',
      }}>{v.side}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.primary }}>{v.title}</div>
        <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.mutedDim, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.sub}</div>
      </div>
      <span style={{ padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: PILL[v.status].bg, color: PILL[v.status].ink, flexShrink: 0 }}>{v.status}</span>
      {v.canCancel && (
        <span role="button" tabIndex={0} onClick={onCancel} onKeyDown={e => e.key === 'Enter' && onCancel()} className="cv-quiet-btn" style={{
          padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 12, fontWeight: 600, color: C.bodyDim, cursor: 'pointer', flexShrink: 0,
        }}>Cancel</span>
      )}
    </div>
  )
}

// ── States and small parts ───────────────────────────────────────────────────

function Loading() {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '38px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <Spinner size={18} />
      <div style={{ fontSize: 12.5, color: C.mutedDim }}>Reading the order book…</div>
    </div>
  )
}

const WifiGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
    <path d="M5 12.5a7 7 0 0 1 14 0" /><path d="M8.5 15.5a4 4 0 0 1 7 0" /><path d="M12 18.5h.01" />
  </svg>
)

function UnreachableBar({ at, onRetry }: { at: number; onRetry: () => void }) {
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 10, background: 'rgba(var(--warn-rgb),0.12)', fontSize: 12, color: C.bodyDim }}>
      <WifiGlyph />
      <span style={{ flex: 1 }}>Can’t reach the network, showing data from {timeLabel(at)}</span>
      <span role="button" tabIndex={0} onClick={onRetry} onKeyDown={e => e.key === 'Enter' && onRetry()} style={{ fontWeight: 600, color: 'var(--warn)', cursor: 'pointer' }}>Retry</span>
    </div>
  )
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '30px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
      <WifiGlyph />
      <div style={{ fontSize: 14, fontWeight: 600, color: C.primary }}>Can’t reach the network</div>
      <div style={{ fontSize: 12, color: C.mutedDim }}>The order book can’t be shown right now. Nothing has changed on chain.</div>
      <span role="button" tabIndex={0} onClick={onRetry} onKeyDown={e => e.key === 'Enter' && onRetry()} style={{
        padding: '7px 16px', borderRadius: 8, border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
      }}>Try again</span>
    </div>
  )
}

function EmptyBook({ onPlace }: { onPlace: () => void }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '30px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
      <span style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--accent-wash)', color: 'var(--accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h14M14 3l4 4-4 4" /><path d="M20 17H6M10 13l-4 4 4 4" /></svg>
      </span>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.primary }}>No orders yet</div>
      <div style={{ fontSize: 12, color: C.mutedDim }}>Place the first one.</div>
      <button onClick={onPlace} className="cv-vault-action" style={{
        padding: '8px 16px', borderRadius: 9, border: 'none', background: 'var(--accent-400)', color: '#FFFFFF', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
      }}>Place an order</button>
    </div>
  )
}

function ListCard({ dim, children }: { dim: number; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', background: 'var(--surface)', opacity: dim, transition: 'opacity .2s' }}>
      {children}
    </div>
  )
}

function EmptyLine({ children }: { children: string }) {
  return <div style={{ padding: '22px 16px', textAlign: 'center', fontSize: 12.5, color: C.mutedDim, borderTop: '1px solid var(--border)' }}>{children}</div>
}

function YoursBadge() {
  return <span style={{ fontFamily: 'var(--font-sans, inherit)', fontSize: 9.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'var(--accent-wash)', padding: '1px 6px', borderRadius: 99 }}>Yours</span>
}

function TabButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <span role="tab" tabIndex={0} aria-selected={on} onClick={onClick} onKeyDown={e => e.key === 'Enter' && onClick()} style={{
      padding: '8px 2px 12px', marginBottom: -1, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', userSelect: 'none',
      borderBottom: `3px solid ${on ? 'var(--accent-400)' : 'transparent'}`, color: on ? C.primary : C.mutedDim,
    }}>{children}</span>
  )
}

const actionBtn = (primary: boolean): React.CSSProperties => ({
  flex: 1, cursor: 'pointer', padding: 12, borderRadius: 11, fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
  border: primary ? 'none' : '1px solid var(--border-strong)',
  background: primary ? 'var(--accent-400)' : 'var(--surface)', color: primary ? '#FFFFFF' : C.primary,
})
