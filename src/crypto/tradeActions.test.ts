// The closing transaction of an order, on record, so its "Order filled" row has the chain's time.
//
// The 0.47 end-to-end run: four fills from the 15th and 16th, found by a seed restore, all showed the
// moment of the restore, because recovery recorded no closing transaction and the row fell back to
// when this device noticed them. These pin that recovery, and a refresh of records an older version
// wrote, look the closing transaction up from the order's own events.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const ORDERS: Record<string, { status: number; key: string; closeTx: string | null }> = {}

vi.mock('./tradeRead', async (actual) => ({
  ...(await actual<typeof import('./tradeRead')>()),
  listBoardOrderIds: vi.fn(async () => Object.keys(ORDERS)),
  readOrder: vi.fn(async (id: string) => {
    const o = ORDERS[id]
    const { TRADE_ORDER_TEMPLATE, TRADE_BOARD_ADDRESS } = await import('./tradeConfig')
    return o && {
      id, template: TRADE_ORDER_TEMPLATE, board: TRADE_BOARD_ADDRESS, cancelKeyHex: o.key, status: o.status,
      side: 0, n: 1_000_000n, p: 1_000_000n, fee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n,
      payoutStatement: null, payoutAccount: 'component_payout',
    }
  }),
  orderOutcomeFromEvents: vi.fn(async (id: string) => {
    const o = ORDERS[id]
    if (!o?.closeTx) return null
    return { state: o.status === 1 ? 'filled' as const : 'cancelled' as const, txId: o.closeTx }
  }),
}))

// Cancel key i's public key is i's 32-byte big-endian encoding: enough to match orders by key.
vi.mock('./derivation', async (actual) => ({
  ...(await actual<typeof import('./derivation')>()),
  cancelKeyFor: (_root: Uint8Array, i: number) => ({ getPublicKey: async () => { const b = new Uint8Array(32); b[31] = i; return b } }),
}))

const { recoverTradeState, refreshOwnOrders } = await import('./tradeActions')
const { loadTradeState, recordTrade } = await import('./tradeStore')
const { setStoreKey } = await import('./sessionKey')

const keyHex = (i: number) => '00'.repeat(31) + i.toString(16).padStart(2, '0')
const ADDR = 'otl_esm_1tradeactionstest'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k) }, setItem: (k: string, v: string) => { m.set(k, v) },
  }
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(new Uint8Array(32).fill(5))
  for (const k of Object.keys(ORDERS)) delete ORDERS[k]
})

describe('recoverTradeState records the transaction that closed each order', () => {
  it('a recovered filled or cancelled order carries its closing transaction; an open one none', async () => {
    ORDERS['component_filled'] = { status: 1, key: keyHex(0), closeTx: 'tx_fill_oct15' }
    ORDERS['component_cancelled'] = { status: 2, key: keyHex(1), closeTx: 'tx_cancel' }
    ORDERS['component_open'] = { status: 0, key: keyHex(2), closeTx: null }
    await recoverTradeState({ address: ADDR, tradeRoot: new Uint8Array(32) })
    const byOrder = Object.fromEntries(loadTradeState(ADDR).records.map(r => [r.orderId, r]))
    expect(byOrder['component_filled']).toMatchObject({ orderState: 'filled', closedTxId: 'tx_fill_oct15', filledSeenAt: null })
    expect(byOrder['component_cancelled']).toMatchObject({ orderState: 'cancelled', closedTxId: 'tx_cancel' })
    expect(byOrder['component_open']).toMatchObject({ orderState: 'open', closedTxId: null })
  })
})

describe('refreshOwnOrders backfills a closed order recorded without its closing transaction', () => {
  it('finds it once from the order\'s events, and then leaves the record alone', async () => {
    ORDERS['component_old'] = { status: 1, key: keyHex(0), closeTx: 'tx_fill' }
    recordTrade(ADDR, {
      journalId: 'recovered-component_old', action: 'place', txId: null, at: 1, side: 0, n: 1_000_000n, p: 1_000_000n,
      tradeFee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n, pays: null, gets: null, orderId: 'component_old',
      cancelIndex: 0, cusdOutputIds: [], cusdSpentIds: [], outcome: 'committed', payoutOutputId: null,
      orderState: 'filled', filledSeenAt: 12345, closedTxId: null,
    })
    // Two things recorded once: its closing transaction, and (found before payouts were) how it pays.
    expect(await refreshOwnOrders(ADDR)).toBe(2)
    expect(loadTradeState(ADDR).records[0]).toMatchObject({ orderState: 'filled', closedTxId: 'tx_fill', gets: { mode: 'public' }, payoutOutputId: null })
    expect(await refreshOwnOrders(ADDR)).toBe(0)
  })
})
