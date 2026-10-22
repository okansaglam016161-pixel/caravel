// A filled BUY order of ours: ONE Activity row, "Order filled +0.99 TARI" — never "Received".
//
// The 0.47 matrix, in Brave: wallet A's BUY orders (placed by the harness) were filled, and its Activity
// showed no "Order filled" row for them — only "Received · Sender unknown +0.99 / +1.98". Two causes:
//
//   1. The wallet's refresh re-read only orders its store already held. An order placed on another
//      device reached the store only via the Trade page or the one-time search before a first placement
//      here, so these were never learned of, and had no "Order filled" row at all.
//   2. A maker's PRIVATE TARI payout is created by the TAKER's transaction, so no journal entry of ours
//      holds it, and reconcile classed it as an unknown receive. (A SELL's payout is cUSD, which
//      reconcile never sees — why the sells looked right.) Orders found on chain recorded no payout id.
//
// b1's stored payout statement (live, esmeralda) is the golden vector: the id computed from it is the
// output the fill really created in wallet A.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import b1 from './payoutStatement.b1.json'
import type { OrderInfo } from './tradeRead'

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)))
const ORDERS = new Map<string, OrderInfo>()
const reads = new Map<string, number>()
const CLOSED = new Map<string, string>()

vi.mock('./tradeRead', async (actual) => ({
  ...(await actual<typeof import('./tradeRead')>()),
  listBoardOrderIds: vi.fn(async () => [...ORDERS.keys()]),
  readOrder: vi.fn(async (id: string) => { reads.set(id, (reads.get(id) ?? 0) + 1); return ORDERS.get(id) ?? null }),
  orderOutcomeFromEvents: vi.fn(async (id: string) => (CLOSED.has(id) ? { state: 'filled' as const, txId: CLOSED.get(id)! } : null)),
}))

const cfg = await import('./tradeConfig')
const { payoutOutputIdOf, foundOrderRecord } = await import('./tradeRead')
const { discoverOwnOrders, recoverTradeState, syncOwnOrders } = await import('./tradeActions')
const { knownPayoutIds, loadTradeState, recordTrade } = await import('./tradeStore')
const { buildActivity, knownReceiveIds } = await import('./activity')
const { reconcile } = await import('./reconcile')
const { OUTPUT_CREATING_ACTIONS } = await import('./journal')
const { cancelKeyFor } = await import('./derivation')
const { setStoreKey } = await import('./sessionKey')

const ROOT = new Uint8Array(32).fill(7)
const ADDR = 'otl_esm_1tradepayouts'
const keyHex = async (i: number) => Array.from(await cancelKeyFor(ROOT, i).getPublicKey(), b => b.toString(16).padStart(2, '0')).join('')

/** An order of ours on the Board, by cancel key index; b1's real terms and payout by default. */
async function boardOrder(id: string, cancelIndex: number, over: Partial<OrderInfo> = {}): Promise<OrderInfo> {
  return {
    id, version: 2, template: cfg.TRADE_ORDER_TEMPLATE, side: b1.side as 0 | 1, status: cfg.ORDER_FILLED, board: cfg.TRADE_BOARD_ADDRESS,
    badge: cfg.TRADE_BOARD_BADGE, quote: cfg.TRADE_QUOTE, n: BigInt(b1.n), p: BigInt(b1.p), fee: BigInt(b1.fee),
    caravelCut: 7_000n, burnCut: 3_000n, caravelAccount: cfg.TRADE_CARAVEL_FEE_ACCOUNT, burnWallet: cfg.TRADE_BURN_WALLET,
    payoutStatement: hexBytes(b1.payoutStatementHex), payoutAccount: null, escrowVault: 'vault_' + 'ee'.repeat(32),
    cancelKeyHex: await keyHex(cancelIndex), ...over,
  }
}

beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    get length() { return store.size }, clear: () => store.clear(), key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => { store.delete(k) }, setItem: (k: string, v: string) => { store.set(k, v) },
  } as Storage
  setStoreKey(new Uint8Array(32).fill(5))
  ORDERS.clear(); reads.clear(); CLOSED.clear()
})

describe('payoutOutputIdOf — the maker\'s payout output, from the statement the order stores', () => {
  it('b1 (live): exactly the output its fill created in wallet A', async () => {
    expect(payoutOutputIdOf(await boardOrder(b1.order, 0))).toBe(b1.payoutOutputId)
  })

  it('a public payout creates no output: null', async () => {
    expect(payoutOutputIdOf(await boardOrder('component_pub', 0, { payoutStatement: null, payoutAccount: 'component_' + 'ab'.repeat(32) }))).toBeNull()
  })

  it('a found order records how it pays, and the id — an unreadable statement records the leg alone', async () => {
    expect(foundOrderRecord(await boardOrder(b1.order, 0), 0, b1.fillTxId)).toMatchObject({
      payoutOutputId: b1.payoutOutputId, gets: { resource: TARI_RESOURCE_ADDRESS, amount: 990_000n, mode: 'private' },
      closedTxId: b1.fillTxId, orderState: 'filled',
    })
    expect(foundOrderRecord(await boardOrder('component_bad', 0, { payoutStatement: new Uint8Array([1, 2, 3]) }), 0, null))
      .toMatchObject({ payoutOutputId: null, gets: { mode: 'private' } })
  })
})

describe('orders placed ELSEWHERE are found by the wallet\'s own refresh', () => {
  it('a restore (recoverTradeState) records the right payout id', async () => {
    ORDERS.set(b1.order, await boardOrder(b1.order, 0))
    CLOSED.set(b1.order, b1.fillTxId)
    await recoverTradeState({ address: ADDR, tradeRoot: ROOT })
    expect(loadTradeState(ADDR).records).toMatchObject([{ orderId: b1.order, payoutOutputId: b1.payoutOutputId, closedTxId: b1.fillTxId }])
    expect(knownPayoutIds(ADDR)).toEqual([b1.payoutOutputId])
  })

  it('the refresh finds an order the store never held — the Brave case — with its payout id and fill', async () => {
    // Known here: index 0, placed on this device. Not known: index 1 (b1), placed by the harness.
    ORDERS.set('component_here', await boardOrder('component_here', 0, { status: cfg.ORDER_OPEN, payoutStatement: null, payoutAccount: 'component_' + 'ab'.repeat(32) }))
    ORDERS.set(b1.order, await boardOrder(b1.order, 1))
    ORDERS.set('component_someone_else', await boardOrder('component_someone_else', 0, { cancelKeyHex: 'ff'.repeat(32) }))
    CLOSED.set(b1.order, b1.fillTxId)
    recordTrade(ADDR, {
      journalId: 'j-here', action: 'place', txId: 'tx_here', at: 1, side: cfg.SELL, n: 1_000_000n, p: 1_000_000n,
      tradeFee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n, pays: null, gets: { resource: cfg.TRADE_QUOTE, amount: 1_000_000n, mode: 'public' },
      orderId: 'component_here', cancelIndex: 0, cusdOutputIds: [], cusdSpentIds: [], outcome: 'committed', payoutOutputId: null,
      orderState: 'open', filledSeenAt: null, closedTxId: null,
    })
    const cache = new Map<string, string | null>()
    expect(await discoverOwnOrders({ address: ADDR, tradeRoot: ROOT }, cache)).toBe(1)
    const found = loadTradeState(ADDR).records.find(r => r.orderId === b1.order)
    expect(found).toMatchObject({ cancelIndex: 1, orderState: 'filled', payoutOutputId: b1.payoutOutputId, closedTxId: b1.fillTxId })
    expect(loadTradeState(ADDR).records.some(r => r.orderId === 'component_someone_else')).toBe(false)
    expect(loadTradeState(ADDR).nextCancelIndex).toBe(2)

    // Each Board order is read once per session: a second refresh reads nothing it has read.
    const before = new Map(reads)
    expect(await discoverOwnOrders({ address: ADDR, tradeRoot: ROOT }, cache)).toBe(0)
    expect(reads).toEqual(before)
  })

  it('an order unreadable right now is not cached as "not ours": the next refresh finds it', async () => {
    ORDERS.set(b1.order, await boardOrder(b1.order, 0))
    const cache = new Map<string, string | null>()
    const { readOrder } = await import('./tradeRead')
    vi.mocked(readOrder).mockRejectedValueOnce(new Error('not served verified'))
    expect(await discoverOwnOrders({ address: ADDR, tradeRoot: ROOT }, cache)).toBe(0)
    expect(await discoverOwnOrders({ address: ADDR, tradeRoot: ROOT }, cache)).toBe(1)
  })
})

describe('Activity: a filled BUY of ours is ONE row — "Order filled +0.99 TARI" — and real receives still show', () => {
  const FILL_AT = Date.UTC(2026, 9, 22, 9, 52, 39)
  const UNKNOWN = 'utxo_' + '01'.repeat(32) + '_' + '7a'.repeat(32)
  const scanned = (id: string, amount: bigint) => ({ id, commitment: id.slice(-64), amount, payRef: '', message: '' })

  async function activityAfterRefresh() {
    ORDERS.set(b1.order, await boardOrder(b1.order, 0))
    CLOSED.set(b1.order, b1.fillTxId)
    await syncOwnOrders({ address: ADDR, tradeRoot: ROOT })
    const trades = loadTradeState(ADDR).records
    // The wallet's scan holds the payout (made by the taker's fill) and one genuine receive, both seen
    // after reconcile's coverage began — so both would be classified, absent attribution.
    const owned = [scanned(b1.payoutOutputId, 990_000n), scanned(UNKNOWN, 5_000_000n)]
    const receives = reconcile({
      owned, journal: [],
      ledger: { firstSeen: { [b1.payoutOutputId]: FILL_AT, [UNKNOWN]: FILL_AT }, baseline: [], baselineAt: 1_000, degradedAt: null },
      epoch: { startedAt: 500, degradedAt: null, covers: [...OUTPUT_CREATING_ACTIONS], coverageCompleteAt: 1_000 },
      knownReceiveUtxoIds: knownReceiveIds([], trades),
    }).receives
    return buildActivity([], [], [], receives, new Map(), trades, new Map([[b1.fillTxId, FILL_AT]]))
  }

  it('the payout is the order\'s "Order filled" row, at the fill\'s time, and never "Received"', async () => {
    const rows = await activityAfterRefresh()
    const filled = rows.filter(r => r.kind === 'trade' && r.tradeKind === 'order-filled')
    expect(filled).toMatchObject([{ orderId: b1.order, tariDelta: 990_000n, cusdDelta: null, timestamp: FILL_AT, txId: b1.fillTxId }])
    expect(rows.filter(r => r.kind === 'received-unattributed').map(r => r.id)).not.toContain(b1.payoutOutputId)
  })

  it('a genuine unknown receive still shows as "Received"', async () => {
    const rows = await activityAfterRefresh()
    expect(rows.filter(r => r.kind === 'received-unattributed').map(r => r.id)).toEqual([UNKNOWN])
  })

  it('exactly two rows in all: the fill and the real receive', async () => {
    expect(await activityAfterRefresh()).toHaveLength(2)
  })
})
