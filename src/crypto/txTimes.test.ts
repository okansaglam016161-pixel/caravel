// A transaction's time — and above all its ESTIMATE, when the indexer has forgotten the exact one —
// must be the same on every device, so every device sorts the same rows the same way. The estimate is
// a function of the transaction's epoch alone: no device clock, no "current epoch" at fetch time, no
// dependence on which answer arrived first.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const chain = vi.hoisted(() => ({
  /** created_at by tx id (absent: the indexer no longer has the body). */
  created: new Map<string, string>(),
  /** receipt epoch by tx id. */
  epoch: new Map<string, number>(),
  /** Artificial per-tx latency, to vary the order answers arrive in. */
  delay: new Map<string, number>(),
}))

vi.mock('./indexerConfig', async (importActual) => ({
  ...(await importActual<typeof import('./indexerConfig')>()),
  pointRead: async (path: string) => {
    const id = path.split('/').pop()!
    await new Promise(r => setTimeout(r, chain.delay.get(id) ?? 0))
    if (path.startsWith('/transactions/')) {
      const c = chain.created.get(id)
      return { answered: true, body: c ? { transaction: { created_at: c } } : null }
    }
    const e = chain.epoch.get(id)
    return { answered: true, body: e === undefined ? null : { receipt: { epoch: e } } }
  },
}))

const { EPOCH_ANCHOR, EPOCH_MS, estimateFromEpoch, txTime, __resetTxTimesForTests } = await import('./txTimes')
const { sortRecent } = await import('./market')
import type { RecentTrade } from './market'

beforeEach(() => {
  __resetTxTimesForTests()
  chain.created.clear(); chain.epoch.clear(); chain.delay.clear()
  vi.useRealTimers()
})

describe('estimateFromEpoch', () => {
  it('is a function of the epoch alone: the anchor, plus whole epochs', () => {
    expect(estimateFromEpoch(EPOCH_ANCHOR.epoch)).toBe(EPOCH_ANCHOR.at)
    expect(estimateFromEpoch(EPOCH_ANCHOR.epoch - 67)).toBe(EPOCH_ANCHOR.at - 67 * EPOCH_MS)
  })
})

describe('txTime', () => {
  it('the exact time when the indexer has it; the epoch estimate, marked, only when it does not', async () => {
    chain.created.set('t1', '2026-10-15 11:46:29.0')
    chain.epoch.set('t2', 12274)
    expect(await txTime('t1')).toEqual({ at: Date.UTC(2026, 9, 15, 11, 46, 29), estimated: false })
    expect(await txTime('t2')).toEqual({ at: estimateFromEpoch(12274), estimated: true })
  })
})

describe('two devices, independently, give the SAME order', () => {
  // Four fills the indexer has forgotten (only receipts left): two in one epoch, one each elsewhere.
  const fills = [
    { txId: 'f_c3', epoch: 12274 }, { txId: 'f_a9', epoch: 12274 }, { txId: 'f_77', epoch: 12280 }, { txId: 'f_02', epoch: 12100 },
  ]
  const trade = (txId: string, at: number | null): RecentTrade =>
    ({ orderId: 'o', txId, side: 0, n: 1n, p: 1n, price: { micro: 1n, exact: true }, at, atEstimated: true, yours: null })

  async function device(clock: number, fetchOrder: string[], delays: Record<string, number>): Promise<string[]> {
    __resetTxTimesForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(clock)
    for (const [id, ms] of Object.entries(delays)) chain.delay.set(id, ms)
    const times = new Map<string, number | null>()
    await Promise.all(fetchOrder.map(async id => { times.set(id, (await txTime(id)).at) }))
    vi.useRealTimers()
    return sortRecent(fills.map(f => trade(f.txId, times.get(f.txId)!))).map(t => t.txId)
  }

  it('different clocks, different fetch order, different arrival order — identical times and order', async () => {
    for (const f of fills) chain.epoch.set(f.txId, f.epoch)
    const a = await device(Date.UTC(2026, 9, 16, 9, 0), ['f_c3', 'f_a9', 'f_77', 'f_02'], { f_c3: 5, f_a9: 0 })
    const b = await device(Date.UTC(2026, 9, 19, 23, 59), ['f_02', 'f_77', 'f_a9', 'f_c3'], { f_a9: 5, f_c3: 0 })
    expect(a).toEqual(b)
    // Newest epoch first; the two in epoch 12274 by transaction id.
    expect(a).toEqual(['f_77', 'f_a9', 'f_c3', 'f_02'])
  })
})
