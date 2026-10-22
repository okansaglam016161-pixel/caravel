// A cancelled order of ours: ONE Activity row, "Cancelled", dated by the cancelling transaction — and
// its outputs are never "Received · Sender unknown".
//
// The 0.47 matrix, in Brave: wallet A's sell (1 tTARI @ 5) was cancelled back to private from the
// harness (tx 23a7d7a1…, 09:58:31). Brave's journal never held that cancel, so it had no "Cancelled"
// row, and the cancel's two outputs — the 1 tTARI escrow back, and the fee's change 0.697293 — were
// classed as receives from a stranger, dated when Brave first noticed them. A cancel needs this
// wallet's cancel key, so everything it creates is this wallet's own.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TradeRecord } from './tradeStore'

const CANCEL_TX = '23a7d7a1e4fcfabd1ff2b2e7c97fd88762c533157a7a13b83edf4c2144e6e759'
const ESCROW_BACK = 'utxo_' + '01'.repeat(32) + '_f68f61e2f7771c598684a07941f11b93e5f93d1fcb92c69e1919d563a22b3a52'
const FEE_CHANGE = 'utxo_' + '01'.repeat(32) + '_fee0da2824397288cd6584dffbd79f8d118f32061108619144ebdba16548055d'
const STRANGER = 'utxo_' + '01'.repeat(32) + '_' + '7a'.repeat(32)
const CANCELLED_AT = Date.UTC(2026, 9, 22, 9, 58, 31)
const created = new Map<string, string[] | null>()

vi.mock('./txOutputs', () => ({ fetchCreatedUtxoIds: vi.fn(async (txId: string) => created.get(txId) ?? null) }))
vi.mock('./tradeRead', async (actual) => ({
  ...(await actual<typeof import('./tradeRead')>()),
  readOrder: vi.fn(async () => null),
  orderOutcomeFromEvents: vi.fn(async () => null),
}))

const cfg = await import('./tradeConfig')
const { refreshOwnOrders } = await import('./tradeActions')
const { loadTradeState, recordTrade } = await import('./tradeStore')
const { buildActivity, knownReceiveIds } = await import('./activity')
const { reconcile } = await import('./reconcile')
const { OUTPUT_CREATING_ACTIONS, draftToEntry } = await import('./journal')
const { setStoreKey } = await import('./sessionKey')

const ADDR = 'otl_esm_1tradecancels'

/** Order x1 as a device that did NOT cancel it knows it: found on chain, cancelled, closing tx known. */
const x1 = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  journalId: 'recovered-component_x1', action: 'place', txId: null, at: 1, side: cfg.SELL, n: 1_000_000n, p: 5_000_000n,
  tradeFee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n, pays: null,
  gets: { resource: cfg.TRADE_QUOTE, amount: 5_000_000n, mode: 'private' },
  orderId: 'component_x1', cancelIndex: 20, cusdOutputIds: [], cusdSpentIds: [], outcome: 'committed', payoutOutputId: null,
  orderState: 'cancelled', filledSeenAt: null, closedTxId: CANCEL_TX, ...over,
})

/** A BUY (cUSD escrow) cancelled back to public: no private output at all. */
const x2 = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  ...x1(), journalId: 'recovered-component_x2', side: cfg.BUY, n: 1_000_000n, p: 500_000n, orderId: 'component_x2', cancelIndex: 21,
  gets: { resource: 'resource_' + '01'.repeat(32), amount: 990_000n, mode: 'private' }, closedTxId: 'tx_x2_cancel', ...over,
})

const scanned = (id: string, amount: bigint) => ({ id, commitment: id.slice(-64), amount, payRef: '', message: '' })

/** What WalletModal does: reconcile with the attributions, then build the list. */
function activity(trades: TradeRecord[], journal: ReturnType<typeof draftToEntry>[] = []) {
  const owned = [scanned(ESCROW_BACK, 1_000_000n), scanned(FEE_CHANGE, 697_293n), scanned(STRANGER, 5_000_000n)]
  const firstSeen = Object.fromEntries(owned.map(u => [u.id, CANCELLED_AT + 3_600_000]))   // noticed an hour later
  const receives = reconcile({
    owned, journal,
    ledger: { firstSeen, baseline: [], baselineAt: 1_000, degradedAt: null },
    epoch: { startedAt: 500, degradedAt: null, covers: [...OUTPUT_CREATING_ACTIONS], coverageCompleteAt: 1_000 },
    knownReceiveUtxoIds: knownReceiveIds([], trades),
  }).receives
  return buildActivity(journal, [], [], receives, new Map(), trades, new Map([[CANCEL_TX, CANCELLED_AT], ['tx_x2_cancel', CANCELLED_AT + 26_000]]))
}

beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    get length() { return store.size }, clear: () => store.clear(), key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => { store.delete(k) }, setItem: (k: string, v: string) => { store.set(k, v) },
  } as Storage
  setStoreKey(new Uint8Array(32).fill(5))
  created.clear()
})

describe('the refresh reads what a cancel of ours created, once', () => {
  it('records the closing transaction\'s outputs on the order', async () => {
    created.set(CANCEL_TX, [ESCROW_BACK, FEE_CHANGE])
    recordTrade(ADDR, x1())
    await refreshOwnOrders(ADDR)
    expect(loadTradeState(ADDR).records[0].closeOutputIds).toEqual([ESCROW_BACK, FEE_CHANGE])
  })

  it('an unreadable result is a hole, not "nothing": asked again next refresh', async () => {
    recordTrade(ADDR, x1())
    await refreshOwnOrders(ADDR)
    expect(loadTradeState(ADDR).records[0].closeOutputIds ?? null).toBeNull()
    created.set(CANCEL_TX, [ESCROW_BACK, FEE_CHANGE])
    await refreshOwnOrders(ADDR)
    expect(loadTradeState(ADDR).records[0].closeOutputIds).toEqual([ESCROW_BACK, FEE_CHANGE])
  })

  it('a FILLED order\'s closing transaction is the taker\'s: nothing of it is recorded as ours', async () => {
    created.set('tx_fill', ['utxo_taker_change'])
    recordTrade(ADDR, x1({ orderState: 'filled', closedTxId: 'tx_fill' }))
    await refreshOwnOrders(ADDR)
    expect(loadTradeState(ADDR).records[0].closeOutputIds ?? null).toBeNull()
  })
})

describe('Activity on a device that did not make the cancel', () => {
  it('ONE "Cancelled +1 TARI" row at the cancel\'s time; its two outputs are never "Received"', () => {
    const rows = activity([x1({ closeOutputIds: [ESCROW_BACK, FEE_CHANGE] })])
    expect(rows.filter(r => r.kind === 'trade')).toMatchObject([
      { tradeKind: 'cancelled', tariDelta: 1_000_000n, cusdDelta: null, timestamp: CANCELLED_AT, txId: CANCEL_TX, orderId: 'component_x1' },
    ])
    const received = rows.filter(r => r.kind === 'received-unattributed').map(r => r.id)
    expect(received).not.toContain(ESCROW_BACK)
    expect(received).not.toContain(FEE_CHANGE)
  })

  it('a genuine receive still shows as "Received"', () => {
    const rows = activity([x1({ closeOutputIds: [ESCROW_BACK, FEE_CHANGE] })])
    expect(rows.filter(r => r.kind === 'received-unattributed').map(r => r.id)).toEqual([STRANGER])
  })

  it('a BUY cancelled to public gets its "Cancelled +0.5 cUSD" row too', () => {
    const rows = activity([x2({ closeOutputIds: [] })])
    expect(rows.filter(r => r.kind === 'trade')).toMatchObject([{ tradeKind: 'cancelled', tariDelta: null, cusdDelta: 500_000n, timestamp: CANCELLED_AT + 26_000 }])
  })

  it('no time for the cancel yet: no row — never this device\'s clock', () => {
    const rows = buildActivity([], [], [], [], new Map(), [x1()], new Map())
    expect(rows).toHaveLength(0)
  })
})

describe('on the device that DID make the cancel: the journal\'s row, and no second one', () => {
  it('exactly one "Cancelled" row — the journal\'s, with its fee', () => {
    const entry = {
      ...draftToEntry({
        kind: 'trade-cancel', amountMicrotari: 1_000_000n, feeMicrotari: 20_603n, from: 'private', to: 'private', counterparty: null,
        note: null, source: 'local-journal', selfOutputIds: [ESCROW_BACK, FEE_CHANGE], spentInputIds: null,
      }),
      outcome: 'committed' as const, txId: CANCEL_TX,
    }
    const cancelRecord: TradeRecord = { ...x1(), journalId: entry.id, action: 'cancel', txId: CANCEL_TX, orderState: null, closedTxId: null }
    const rows = activity([x1({ closeOutputIds: [ESCROW_BACK, FEE_CHANGE] }), cancelRecord], [entry])
    const trade = rows.filter(r => r.kind === 'trade')
    expect(trade).toHaveLength(1)
    expect(trade[0]).toMatchObject({ tradeKind: 'cancelled', source: 'local-journal', feeMicrotari: 20_603n, txId: CANCEL_TX })
  })
})
