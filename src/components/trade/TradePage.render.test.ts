// The Trade page and sheet, rendered (server-side, no DOM — the suite has no jsdom), with the hooks
// mocked. What is checked is the MARKUP a person would see, against the trade rules and the design's
// states: figures only when known, Cancel on your own orders, the 1% fee in tTARI, the seller paid the
// full cUSD, no spread, Private by default with the "Public: visible on-chain" hint, no invented
// network fee before a live quote.

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookEntry, MarketData } from '../../crypto/market'
import type { MarketSnapshot } from '../../crypto/marketFeed'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'

const state = vi.hoisted(() => ({ market: null as unknown, balances: null as unknown }))

vi.mock('../../context/WalletContext', () => ({
  useWallet: () => ({ address: 'otl_esm_1test', wallet: null, purposeKeys: null, rescan: () => {} }),
}))
vi.mock('../../hooks/useMarket', () => ({ useMarket: () => state.market }))
vi.mock('../../hooks/useTradeBalances', () => ({ useTradeBalances: () => state.balances }))
vi.mock('../../hooks/useTrades', () => ({ useTrades: () => [] }))
vi.mock('../wallet/CusdFaucetClaimPanel', () => ({ default: () => null }))
vi.mock('../primitives/ThemeToggle', () => ({ default: () => null }))

const { default: TradePage } = await import('./TradePage')
const { default: TradeSheet } = await import('./TradeSheet')

const CUSD = 'resource_d1f7fb8d5a70b5a7c7aeb98aefd73d3f87bae5625acfe6f39a072f4c5ba4edea'
const entry = (id: string, side: 0 | 1, n: bigint, p: bigint, yours = false): BookEntry => ({
  orderId: id, side, n, p, fee: n / 100n, caravelCut: (n / 100n) * 7n / 10n, burnCut: n / 100n - (n / 100n) * 7n / 10n, version: 1,
  price: { micro: p * 1_000_000n / n, exact: (p * 1_000_000n) % n === 0n },
  pays: side === 0 ? { resource: CUSD, amount: p } : { resource: TARI_RESOURCE_ADDRESS, amount: n },
  receives: side === 0 ? { resource: TARI_RESOURCE_ADDRESS, amount: n - n / 100n } : { resource: CUSD, amount: p },
  yours, cancelIndex: yours ? 4 : null, seq: 0, confirmed: true, placedTx: null, placedAt: null,
})
const data = (over: Partial<MarketData> = {}): MarketData => ({
  book: {
    sells: [entry('s1', 0, 1_000_000n, 2_200_000n), entry('s2', 0, 1_000_000n, 2_500_000n, true)],
    buys: [entry('b1', 1, 1_000_000n, 1_900_000n), entry('b2', 1, 1_000_000n, 1_800_000n, true)],
    spread: { micro: 300_000n, exact: true },
  },
  mine: [], recent: [], hidden: [], discovered: 4, at: Date.UTC(2026, 9, 15, 12, 4),
  board: { feeBps: 100n, caravelPct: 70n } as MarketData['board'],
  ...over,
})
const ready = (d: MarketData, status: MarketSnapshot['status'] = 'ready') => ({ status, data: d, error: null, refresh: async () => {} })
const amt = (v: bigint) => ({ status: 'ready' as const, value: v })

beforeEach(() => {
  state.balances = {
    tari: { private: amt(993_896_467n), public: amt(2_486_953n) },
    cusd: { private: amt(10_004_500_000n), public: amt(3_000_000n), total: amt(10_007_500_000n) },
    tariTotal: { status: 'ready', microtari: 996_383_420n },
  }
})

const page = () => renderToString(createElement(TradePage))
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/\s+/g, ' ')

describe('TradePage', () => {
  it('loading: no figures, "Reading the order book…"', () => {
    state.market = { status: 'loading', data: null, error: null, refresh: async () => {} }
    const t = text(page())
    expect(t).toContain('Reading the order book')
    expect(t).not.toContain('Sell orders')
  })

  it('the book: sides in order, Buy/Sell on others\' orders, Yours + Cancel on your own, the fee note — and no spread', () => {
    state.market = ready(data())
    const t = text(page())
    expect(t).toMatch(/Sell orders PRICE.*2\.2.*Buy 2\.5.*Yours Cancel Buy orders/)
    expect(t).toMatch(/Buy orders PRICE.*1\.9.*Sell 1\.8.*Yours Cancel/)
    expect(t).not.toMatch(/cheapest first|highest first/)
    expect(t).toContain('1% trade fee in tTARI · 0.7% Caravel, 0.3% burned')
    expect(t.toLowerCase()).not.toContain('spread')
    expect(t).toContain('Place sell order')
    expect(t).toContain('Place buy order')
  })

  it('balances: tTARI and cUSD, private and public; cUSD with ≈ $', () => {
    state.market = ready(data())
    const t = text(page())
    expect(t).toContain('996.38342')
    expect(t).toContain('10,007.5')
    expect(t).toContain('≈ $10,007.50')
    expect(t).toMatch(/993\.89646\d* private 2\.486953 public/)
  })

  it('a balance still being read shows no figure; one that failed shows a dash — never a zero', () => {
    state.market = ready(data())
    state.balances = {
      tari: { private: { status: 'loading' }, public: { status: 'unavailable' } },
      cusd: { private: { status: 'loading' }, public: { status: 'loading' }, total: { status: 'loading' } },
      tariTotal: { status: 'loading' },
    }
    const t = text(page())
    expect(t).toContain('··· private')
    expect(t).toContain('— public')
    expect(t).not.toContain('≈ $')
  })

  it('unreachable with data: the last book, dimmed, with the time it was read and Retry', () => {
    state.market = ready(data(), 'unreachable')
    const html = page()
    expect(text(html)).toMatch(/Can’t reach the network, showing data from .+ Retry/)
    expect(html).toContain('opacity:0.6')
  })

  it('unreachable with nothing read yet: no book at all', () => {
    state.market = { status: 'unreachable', data: null, error: 'down', refresh: async () => {} }
    const t = text(page())
    expect(t).toContain('The order book can’t be shown right now')
    expect(t).not.toContain('Sell orders')
  })

  it('your just-placed order, not yet served verified: Yours · Confirming…, no Cancel yet', () => {
    const fresh = { ...entry('s9', 0, 1_000_000n, 2_000_000n, true), confirmed: false }
    state.market = ready(data({ book: { sells: [fresh], buys: [], spread: null } }))
    const t = text(page())
    expect(t).toMatch(/2 1 2 Yours Confirming…/)
    expect(t).not.toMatch(/Yours Cancel/)
  })

  it('an empty book invites the first order', () => {
    state.market = ready(data({ book: { sells: [], buys: [], spread: null } }))
    expect(text(page())).toContain('No orders yet Place the first one. Place an order')
  })
})

describe('TradeSheet', () => {
  const sheet = (mode: Parameters<typeof TradeSheet>[0]['mode']) =>
    text(renderToString(createElement(TradeSheet, { mode, board: data().board, onClose: () => {}, onTraded: () => {} })))

  it('place: amount (min 1 tTARI), price, Private-by-default toggles with the Public hint, no network fee before review', () => {
    const t = sheet({ kind: 'place', side: 0 })
    expect(t).toContain('Place sell order')
    expect(t).toContain('min 1 tTARI')
    expect(t).toContain('Price per tTARI')
    expect(t).toMatch(/Pay from Private Public Get paid Private Public/)
    expect(t).toContain('Public: visible on-chain.')
    expect(t).toContain('Network fee priced at review')
    expect(t).toContain('Review order')
  })

  it('buying from a sell order: pay cUSD, the fee in tTARI, receive N − 1% tTARI', () => {
    const t = sheet({ kind: 'fill', entry: entry('s1', 0, 1_000_000n, 2_200_000n) })
    expect(t).toContain('Buy from this order')
    expect(t).toMatch(/You pay 2\.2 cUSD You receive 0\.99 tTARI Includes 1% trading fee Network fee priced at review/)
    expect(t).not.toMatch(/Caravel|burned/)
    expect(t).toMatch(/Pay with Private Public Receive as Private Public/)
  })

  it('selling into a buy order: pay N tTARI (fee out of it), receive the FULL cUSD', () => {
    const t = sheet({ kind: 'fill', entry: entry('b1', 1, 1_000_000n, 1_900_000n) })
    expect(t).toContain('Sell into this order')
    expect(t).toMatch(/You pay 1 tTARI You receive 1\.9 cUSD Includes 1% trading fee/)
  })

  it('place SELL form: you receive the full cUSD, the buyer note, the network fee row, the toggles', () => {
    const t = sheet({ kind: 'place', side: 0 })
    expect(t).toMatch(/You receive — Buyer receives — after the 1% trading fee Network fee priced at review/)
  })

  it('insufficient balance: said plainly, Review disabled, before anything is priced', () => {
    state.balances = {
      tari: { private: amt(5_000n), public: amt(0n) },
      cusd: { private: amt(1_000_000n), public: amt(0n), total: amt(1_000_000n) },
      tariTotal: { status: 'ready', microtari: 5_000n },
    }
    const html = renderToString(createElement(TradeSheet, { mode: { kind: 'fill', entry: entry('s1', 0, 1_000_000n, 2_200_000n) }, board: data().board, onClose: () => {}, onTraded: () => {} }))
    expect(text(html)).toContain('Insufficient balance.')
    expect(html).toMatch(/aria-disabled="true"[^>]*>Review</)
  })

  it('cancel: priced as it opens — the order, what returns, no invented fee', () => {
    const t = sheet({ kind: 'cancel', order: { orderId: 'o', side: 0, n: 1_000_000n, p: 2_500_000n, price: { micro: 2_500_000n, exact: true }, cancelIndex: 4, to: 'private' } })
    expect(t).toMatch(/Order Sell 1 tTARI @ 2\.5 Returns to you 1 tTARI Network fee pricing…/)
    expect(t).toContain('Everything comes back, no trade fee.')
    expect(t).toContain('Keep order')
  })
})
