import { beforeEach, describe, expect, it } from 'vitest'
import { setStoreKey } from './sessionKey'
import { recordCusdClaim } from './cusdStore'
import {
  claimCancelIndex, knownCusdIds, loadTradeState, observeOrder, ownOpenOrders, peekCancelIndex, recordRecovery,
  recordTrade, spentCusdIds, type TradeRecord,
} from './tradeStore'
import { CUSD_ASSET } from './assets'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

const ADDR = 'otl_esm_1tradestoretest0000000000000000000'
const cusd = (c: string) => `utxo_${CUSD_ASSET.resourceHex}_${c.repeat(64).slice(0, 64)}`

function rec(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    journalId: 'j1', action: 'place', txId: 'tx1', at: 1, side: 0, n: 1_000_000n, p: 2_000_000n,
    tradeFee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n,
    pays: { resource: 'resource_tari', amount: 1_000_000n, mode: 'private' },
    gets: { resource: CUSD_ASSET.resource, amount: 2_000_000n, mode: 'private' },
    orderId: 'component_o1', cancelIndex: 0, cusdOutputIds: [], cusdSpentIds: [], outcome: 'committed',
    payoutOutputId: null, orderState: 'open', filledSeenAt: null,
    ...over,
  }
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(new Uint8Array(32).fill(9))
})

describe('cancel key index', () => {
  it('a preview only peeks; claiming moves it on, and refuses an index already taken', () => {
    expect(peekCancelIndex(ADDR)).toBe(0)
    expect(peekCancelIndex(ADDR)).toBe(0)
    claimCancelIndex(ADDR, 0)
    expect(peekCancelIndex(ADDR)).toBe(1)
    expect(() => claimCancelIndex(ADDR, 0)).toThrow(/used meanwhile/)
  })
  it('recovery never moves it backwards, and adds only orders not already recorded', () => {
    claimCancelIndex(ADDR, 0); claimCancelIndex(ADDR, 1); claimCancelIndex(ADDR, 2)
    recordTrade(ADDR, rec({ orderId: 'component_known' }))
    recordRecovery(ADDR, 1, [rec({ journalId: 'recovered-a', orderId: 'component_known' }), rec({ journalId: 'recovered-b', orderId: 'component_new' })])
    const s = loadTradeState(ADDR)
    expect(s.nextCancelIndex).toBe(3)
    expect(s.recoveredAt).not.toBeNull()
    expect(s.records.map(r => r.orderId)).toEqual(['component_known', 'component_new'])
  })
})

describe('records', () => {
  it('round-trip through the sealed store with bigints intact, replacing by journal id', () => {
    recordTrade(ADDR, rec())
    recordTrade(ADDR, rec({ txId: 'tx2' }))
    const [r] = loadTradeState(ADDR).records
    expect(loadTradeState(ADDR).records).toHaveLength(1)
    expect(r.txId).toBe('tx2')
    expect(r.n).toBe(1_000_000n)
    expect(r.pays?.amount).toBe(1_000_000n)
  })
  it('an order seen filled keeps its first-seen moment; open ones are what the watcher re-reads', () => {
    recordTrade(ADDR, rec())
    expect(ownOpenOrders(ADDR)).toHaveLength(1)
    observeOrder(ADDR, 'component_o1', 'filled', null, 1000)
    observeOrder(ADDR, 'component_o1', 'filled', null, 2000)
    expect(loadTradeState(ADDR).records[0].filledSeenAt).toBe(1000)
    expect(ownOpenOrders(ADDR)).toHaveLength(0)
  })
  it('keeps the transaction that closed the order, learned even after the state was', () => {
    recordTrade(ADDR, rec())
    observeOrder(ADDR, 'component_o1', 'filled')                 // seen filled, tx not known yet
    observeOrder(ADDR, 'component_o1', 'filled', 'tx_fill')      // the fill event names it later
    expect(loadTradeState(ADDR).records[0].closedTxId).toBe('tx_fill')
  })
})

describe('cUSD bookkeeping', () => {
  it('known ids: claims and trade outputs; a maker payout only once its order is filled', () => {
    recordCusdClaim(ADDR, { journalId: 'c1', txId: 't', outputId: cusd('a'), units: 1n, at: 1 })
    recordTrade(ADDR, rec({ cusdOutputIds: [cusd('b')], payoutOutputId: cusd('c') }))
    expect(new Set(knownCusdIds(ADDR))).toEqual(new Set([cusd('a'), cusd('b')]))
    observeOrder(ADDR, 'component_o1', 'filled')
    expect(new Set(knownCusdIds(ADDR))).toEqual(new Set([cusd('a'), cusd('b'), cusd('c')]))
  })
  it('spent ids: held out unless the trade was rejected or failed (a pending or timed-out spend stays held)', () => {
    recordTrade(ADDR, rec({ journalId: 'j1', cusdSpentIds: [cusd('1')], outcome: 'committed' }))
    recordTrade(ADDR, rec({ journalId: 'j2', cusdSpentIds: [cusd('2')], outcome: 'pending' }))
    recordTrade(ADDR, rec({ journalId: 'j3', cusdSpentIds: [cusd('3')], outcome: 'timeout' }))
    recordTrade(ADDR, rec({ journalId: 'j4', cusdSpentIds: [cusd('4')], outcome: 'rejected' }))
    recordTrade(ADDR, rec({ journalId: 'j5', cusdSpentIds: [cusd('5')], outcome: 'failed' }))
    expect(spentCusdIds(ADDR)).toEqual(new Set([cusd('1'), cusd('2'), cusd('3')]))
  })
})

describe('a claim recorded with the wrong resource prefix (before the fix)', () => {
  it('is still asked for by id — under cUSD\'s prefix, the same commitment', () => {
    const commitment = 'ab'.repeat(32)
    recordCusdClaim(ADDR, { journalId: 'old', txId: 't', outputId: `utxo_${'01'.repeat(32)}_${commitment}`, units: 1n, at: 1 })
    expect(knownCusdIds(ADDR)).toEqual([`utxo_${CUSD_ASSET.resourceHex}_${commitment}`])
  })
})
