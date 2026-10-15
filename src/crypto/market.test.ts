// The market read: exact prices and ordering, the taker's legs after the 1% fee, which fills count,
// my orders — and the reader's rules: hide what fails, read final orders once, find "yours" by the
// seed's cancel keys, and report an unreachable Board instead of an empty book.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import { CUSD_ASSET } from './assets'
import {
  buildBook, comparePrice, MarketReader, MarketUnreachable, myOrdersFrom, parseFillEvents, pricePerTari, spreadOf,
  takerLegs, toBookEntry,
} from './market'
import { BUY, SELL, TRADE_BOARD_ADDRESS, TRADE_BOARD_BADGE, TRADE_ORDER_TEMPLATE, TRADE_QUOTE, TRADE_BURN_WALLET, TRADE_CARAVEL_FEE_ACCOUNT } from './tradeConfig'
import type { BoardInfo, OrderInfo, PayoutCheck } from './tradeRead'
import { loadTradeState, type TradeRecord } from './tradeStore'
import { cancelKeyFor } from './derivation'
import { setStoreKey } from './sessionKey'

const order = (id: string, over: Partial<OrderInfo> = {}): OrderInfo => ({
  id, version: 1, template: TRADE_ORDER_TEMPLATE, side: SELL, status: 0, board: TRADE_BOARD_ADDRESS,
  badge: TRADE_BOARD_BADGE, quote: TRADE_QUOTE, n: 1_000_000n, p: 2_000_000n, fee: 10_000n, caravelCut: 7_000n,
  burnCut: 3_000n, caravelAccount: TRADE_CARAVEL_FEE_ACCOUNT, burnWallet: TRADE_BURN_WALLET, payoutStatement: null,
  payoutAccount: 'component_' + 'ab'.repeat(32), escrowVault: 'vault_x', cancelKeyHex: null, ...over,
})

describe('prices', () => {
  it('P/N per whole tTARI, flagged when it does not end at six decimals', () => {
    expect(pricePerTari(1_000_000n, 2_000_000n)).toEqual({ micro: 2_000_000n, exact: true })       // 2 cUSD
    expect(pricePerTari(1_500_000n, 2_500_000n)).toEqual({ micro: 1_666_666n, exact: false })       // 1.666666…
    expect(pricePerTari(3_000_000n, 1n)).toEqual({ micro: 0n, exact: false })
  })
  it('compares exactly — never on the rounded figure', () => {
    // 1.666666… vs 1.666666 : equal when rounded, not equal in truth.
    expect(comparePrice({ n: 1_500_000n, p: 2_500_000n }, { n: 1_000_000n, p: 1_666_666n })).toBe(1)
    expect(comparePrice({ n: 2n, p: 4n }, { n: 1n, p: 2n })).toBe(0)
  })
})

describe('takerLegs — what filling costs and returns, after the 1% fee', () => {
  it('a SELL order: pay P cUSD, receive N − fee tTARI', () => {
    expect(takerLegs(order('a'))).toEqual({ pays: { resource: CUSD_ASSET.resource, amount: 2_000_000n }, receives: { resource: TARI_RESOURCE_ADDRESS, amount: 990_000n } })
  })
  it('a BUY order: pay N tTARI (the maker\'s side carries the fee), receive P cUSD', () => {
    expect(takerLegs(order('a', { side: BUY }))).toEqual({ pays: { resource: TARI_RESOURCE_ADDRESS, amount: 1_000_000n }, receives: { resource: CUSD_ASSET.resource, amount: 2_000_000n } })
  })
})

describe('buildBook', () => {
  const e = (id: string, side: 0 | 1, n: bigint, p: bigint, seq: number, mine = new Map<string, number>()) =>
    toBookEntry(order(id, { side, n, p, fee: n / 100n }), seq, mine)

  it('sells cheapest first, buys dearest first, the older first at one price; the spread between them', () => {
    const book = buildBook([
      e('s3', SELL, 1_000_000n, 2_500_000n, 0), e('s1', SELL, 1_000_000n, 2_200_000n, 1), e('s2', SELL, 2_000_000n, 4_400_000n, 2),
      e('b1', BUY, 1_000_000n, 1_800_000n, 3), e('b2', BUY, 1_000_000n, 1_900_000n, 4),
    ])
    expect(book.sells.map(x => x.orderId)).toEqual(['s1', 's2', 's3'])
    expect(book.buys.map(x => x.orderId)).toEqual(['b2', 'b1'])
    expect(book.spread).toEqual({ micro: 300_000n, exact: true })   // 2.2 − 1.9
  })
  it('a crossed book has a negative spread; one side alone has none', () => {
    expect(spreadOf({ n: 1_000_000n, p: 1_000_000n }, { n: 1_000_000n, p: 1_500_000n }).micro).toBe(-500_000n)
    expect(buildBook([e('s', SELL, 1_000_000n, 2_000_000n, 0)]).spread).toBeNull()
  })
  it('marks this wallet\'s own orders, with the cancel key index Cancel needs', () => {
    const x = e('s', SELL, 1_000_000n, 2_000_000n, 0, new Map([['s', 3]]))
    expect(x).toMatchObject({ yours: true, cancelIndex: 3 })
    expect(e('t', SELL, 1_000_000n, 2_000_000n, 0)).toMatchObject({ yours: false, cancelIndex: null })
  })
})

describe('parseFillEvents — only the engine\'s word counts', () => {
  const ev = (tx: string, id: string, topic = 'CaravelTradeOrder.Filled', template = TRADE_ORDER_TEMPLATE) =>
    [tx, { substate_id: id, template_address: template, topic, payload: {} }]
  it('keeps fills of orders verified legitimate at some read, newest first, one per order', () => {
    // o3 was last READ open: its fill landed after, and the engine-stamped event is what proves it.
    const legit = new Map([['o1', order('o1', { status: 1 })], ['o2', order('o2', { status: 1 })], ['o3', order('o3', { status: 0 })]])
    const page = { events: [
      ev('t1', 'o1'), ev('t1b', 'o1'),                                      // a duplicate for o1
      ev('t2', 'o2', 'CaravelTradeOrder.Filled', 'ff'.repeat(32)),           // look-alike template
      ev('t3', 'o3'),                                                       // filled after our last read
      ev('t4', 'o9'),                                                       // never verified legitimate
      ev('t5', 'o2', 'CaravelTradeOrder.Cancelled'),
    ] }
    expect(parseFillEvents(page, legit)).toEqual([{ orderId: 'o1', txId: 't1' }, { orderId: 'o3', txId: 't3' }])
  })
})

describe('myOrdersFrom', () => {
  const rec = (over: Partial<TradeRecord>): TradeRecord => ({
    journalId: 'j', action: 'place', txId: 't', at: 10, side: SELL, n: 1_000_000n, p: 2_000_000n, tradeFee: 10_000n,
    caravelCut: 7_000n, burnCut: 3_000n, pays: null, gets: null, orderId: 'o', cancelIndex: 0, cusdOutputIds: [],
    cusdSpentIds: [], outcome: 'committed', payoutOutputId: null, orderState: 'open', filledSeenAt: null, ...over,
  })
  it('the chain\'s state wins; open first; recovered orders have no placed time; failed placements are not orders', () => {
    const records = [
      rec({ journalId: 'a', orderId: 'oa', at: 1 }),
      rec({ journalId: 'recovered-ob', orderId: 'ob', cancelIndex: 1 }),
      rec({ journalId: 'c', orderId: 'oc', at: 3 }),
      rec({ journalId: 'd', orderId: 'od', outcome: 'rejected' }),
      rec({ journalId: 'e', action: 'fill', orderId: 'oe' }),
    ]
    const chain = new Map([['oa', order('oa', { status: 1 })], ['oc', order('oc')]])
    const mine = myOrdersFrom(records, chain)
    expect(mine.map(m => [m.orderId, m.state])).toEqual([['oc', 'open'], ['ob', 'open'], ['oa', 'filled']])
    expect(mine.find(m => m.orderId === 'ob')!.placedAt).toBeNull()
  })

  it('an order not readable verified right now is UNCONFIRMED — filled if its fill event is in, else as last known', () => {
    const records = [rec({ journalId: 'a', orderId: 'oa' }), rec({ journalId: 'b', orderId: 'ob' })]
    const lastKnown = new Map([['oa', order('oa')], ['ob', order('ob')]])   // both last read open
    const mine = myOrdersFrom(records, new Map(), lastKnown, new Set(['oa']))
    expect(mine.find(m => m.orderId === 'oa')).toMatchObject({ state: 'filled', confirmed: false })
    expect(mine.find(m => m.orderId === 'ob')).toMatchObject({ state: 'open', confirmed: false })
  })
})

// ── The reader, with the network mocked ──────────────────────────────────────

const net = vi.hoisted(() => ({
  ids: [] as string[],
  orders: new Map<string, unknown>(),
  reads: new Map<string, number>(),
  payout: new Map<string, unknown>(),
  boardFails: false,
  fills: { events: [] as unknown[] },
}))

vi.mock('./tradeRead', async (importActual) => {
  const actual = await importActual<typeof import('./tradeRead')>()
  return {
    ...actual,
    readBoard: async () => {
      if (net.boardFails) throw new Error('no indexer answered')
      return { badge: TRADE_BOARD_BADGE } as BoardInfo
    },
    listBoardOrderIds: async () => net.ids,
    readOrder: async (id: string) => {
      net.reads.set(id, (net.reads.get(id) ?? 0) + 1)
      const o = net.orders.get(id)
      if (o === 'unreadable') throw new Error('not verified')
      return (o as OrderInfo) ?? null
    },
    checkPayout: async (o: OrderInfo) => (net.payout.get(o.id) as PayoutCheck) ?? { ok: true, outputId: null },
  }
})
vi.mock('./indexerRetry', async (importActual) => ({
  ...(await importActual<typeof import('./indexerRetry')>()),
  fetchWithRetry: async () => new Response(JSON.stringify(net.fills), { status: 200 }),
}))
vi.mock('./indexerConfig', async (importActual) => ({
  ...(await importActual<typeof import('./indexerConfig')>()),
  pointRead: async (path: string) => ({ answered: true, body: path.startsWith('/transactions/') ? { transaction: { created_at: '2026-10-15 11:46:29.0' } } : null }),
}))

describe('MarketReader', () => {
  beforeEach(() => {
    net.ids = []; net.orders.clear(); net.reads.clear(); net.payout.clear(); net.boardFails = false; net.fills = { events: [] }
  })

  it('shows only what is legitimate, open and payable — everything else is hidden', async () => {
    net.ids = ['ok', 'fake', 'gone', 'copied', 'dark']
    net.orders.set('ok', order('ok'))
    net.orders.set('fake', order('fake', { badge: 'resource_' + '99'.repeat(32) }))
    net.orders.set('gone', order('gone', { status: 1 }))
    net.orders.set('copied', order('copied'))
    net.orders.set('dark', 'unreadable')
    net.payout.set('copied', { ok: false, reason: 'This order\'s payout output already exists, so filling it would fail. It cannot be filled.' })
    const data = await new MarketReader().refresh()
    expect(data.book.sells.map(s => s.orderId)).toEqual(['ok'])
    expect(data.hidden.map(h => h.orderId).sort()).toEqual(['copied', 'dark', 'fake'])
    expect(data.discovered).toBe(5)
  })

  it('reads a filled or cancelled order once, ever; an open one every refresh', async () => {
    net.ids = ['open', 'done']
    net.orders.set('open', order('open'))
    net.orders.set('done', order('done', { status: 2 }))
    const r = new MarketReader()
    await r.refresh(); await r.refresh(); await r.refresh()
    expect(net.reads.get('done')).toBe(1)
    expect(net.reads.get('open')).toBe(3)
  })

  it('an order that fills drops off the book and appears in recent trades', async () => {
    net.ids = ['o']
    net.orders.set('o', order('o'))
    const r = new MarketReader()
    expect((await r.refresh()).book.sells).toHaveLength(1)
    net.orders.set('o', order('o', { status: 1 }))
    net.fills = { events: [['tx1', { substate_id: 'o', template_address: TRADE_ORDER_TEMPLATE, topic: 'CaravelTradeOrder.Filled', payload: {} }]] }
    const data = await r.refresh()
    expect(data.book.sells).toHaveLength(0)
    expect(data.recent).toMatchObject([{ orderId: 'o', txId: 'tx1', at: Date.UTC(2026, 9, 15, 11, 46, 29), atEstimated: false, yours: null }])
  })

  it('a just-filled order served unverified: off the book, yet its fill shows and My orders says filled (unconfirmed)', async () => {
    net.ids = ['o']
    net.orders.set('o', order('o'))
    const r = new MarketReader()
    await r.refresh()
    net.orders.set('o', 'unreadable')
    net.fills = { events: [['tx9', { substate_id: 'o', template_address: TRADE_ORDER_TEMPLATE, topic: 'CaravelTradeOrder.Filled', payload: {} }]] }
    const data = await r.refresh()
    expect(data.book.sells).toHaveLength(0)
    expect(data.recent?.map(t => t.txId)).toEqual(['tx9'])
  })

  it('an unreachable Board is reported as such — never as an empty book', async () => {
    net.boardFails = true
    await expect(new MarketReader().refresh()).rejects.toBeInstanceOf(MarketUnreachable)
  })
})

describe('MarketReader — "yours", from the seed alone (a restore)', () => {
  it('matches an order\'s cancel key to this wallet\'s derived keys, flags it, and records it', async () => {
    net.ids = []; net.orders.clear(); net.reads.clear(); net.payout.clear(); net.boardFails = false; net.fills = { events: [] }
    const map = new Map<string, string>()
    globalThis.localStorage = {
      get length() { return map.size }, clear: () => map.clear(), getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null, removeItem: (k: string) => { map.delete(k) }, setItem: (k: string, v: string) => { map.set(k, v) },
    } as Storage
    setStoreKey(new Uint8Array(32).fill(4))
    const root = new Uint8Array(32).fill(7)
    const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
    const ADDR = 'otl_esm_1marketrestore'
    net.ids = ['mine', 'theirs']
    net.orders.set('mine', order('mine', { cancelKeyHex: hex(await cancelKeyFor(root, 2).getPublicKey()) }))
    net.orders.set('theirs', order('theirs', { cancelKeyHex: hex(await cancelKeyFor(new Uint8Array(32).fill(8), 0).getPublicKey()) }))
    const data = await new MarketReader({ walletAddress: ADDR, tradeRoot: root }).refresh()
    expect(data.book.sells.find(e => e.orderId === 'mine')).toMatchObject({ yours: true, cancelIndex: 2 })
    expect(data.book.sells.find(e => e.orderId === 'theirs')).toMatchObject({ yours: false })
    expect(data.mine).toMatchObject([{ orderId: 'mine', state: 'open', cancelIndex: 2, placedAt: null }])
    expect(loadTradeState(ADDR).nextCancelIndex).toBe(3)   // index 2 is in use: never handed out again
  })
})
