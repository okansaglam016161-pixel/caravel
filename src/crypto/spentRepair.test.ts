// Giving back coins the 0.47 shape change condemned, and nothing else.
//
// The asymmetry under test: restoring a coin that IS spent lets the wallet build against a down
// input, while keeping one that is live only leaves money uncounted until the next run. So a coin
// comes back only on the strongest evidence (every node, verified, live, and its transaction not a
// known Accept), and every weaker answer keeps the record and repeats the run later.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setStoreKey } from './sessionKey'
import { STALE_LOCK_MS } from './lockSweep'
import {
  __resetSpentSessionForTests, loadExcludedIds, loadSpentOutputs, markLocked, promoteToSpent,
} from './spentOutputs'
import { repairShapeBreakSpends, type CoinReader, type NodeVote, type VerdictReader } from './spentRepair'
import type { TxVerdict } from './txResult'

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

const ADDR = 'otl_esm_1repairwallet'
const A = 'utxo_0101_aaa'
const B = 'utxo_0101_bbb'
const C = 'utxo_0101_ccc'
const TX = 'tx_stranded'
const TX2 = 'tx_accepted'
const NOW = 10 * STALE_LOCK_MS

/** Lock then promote, at `at`: the record the broken sweep left behind. */
function condemn(ids: string[], txId: string, at = 0) {
  markLocked(ADDR, ids, txId, at)
  promoteToSpent(ADDR, txId, at)
}

const coins = (votes: Record<string, NodeVote[]>): CoinReader => vi.fn(async (id: string) => votes[id] ?? ['unknown', 'unknown'])
const verdicts = (map: Record<string, TxVerdict | null> = {}): VerdictReader => vi.fn(async (txId: string) => map[txId] ?? null)
const LIVE: NodeVote[] = ['live', 'live']
const GONE: NodeVote[] = ['gone', 'gone']

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  __resetSpentSessionForTests()
  setStoreKey(new Uint8Array(32).fill(3))
})

describe('repairShapeBreakSpends', () => {
  it('restores a spent coin every node serves as verified and live, and marks the wallet done', async () => {
    condemn([A, B], TX)
    const r = await repairShapeBreakSpends(ADDR, { readCoin: coins({ [A]: LIVE, [B]: LIVE }), readTxVerdict: verdicts(), now: NOW })
    expect(r).toMatchObject({ candidates: 2, restored: [A, B], kept: 0, unresolved: 0, done: true })
    expect(loadExcludedIds(ADDR).size).toBe(0)
  })

  it('keeps a coin every node says is gone: that record was right', async () => {
    condemn([A], TX)
    const r = await repairShapeBreakSpends(ADDR, { readCoin: coins({ [A]: GONE }), readTxVerdict: verdicts(), now: NOW })
    expect(r).toMatchObject({ restored: [], kept: 1, done: true })
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
  })

  it('NEVER restores the inputs of an Accepted transaction, whatever an indexer serves', async () => {
    // An indexer has been measured serving a just-spent coin as verified and live.
    condemn([A], TX2)
    const readCoin = coins({ [A]: LIVE })
    const r = await repairShapeBreakSpends(ADDR, { readCoin, readTxVerdict: verdicts({ [TX2]: { kind: 'accept' } }), now: NOW })
    expect(r).toMatchObject({ restored: [], kept: 1, done: true })
    expect(readCoin).not.toHaveBeenCalled()
  })

  it('an unreadable verdict keeps the coins too, by the same asymmetry as the sweep', async () => {
    condemn([A], TX)
    const r = await repairShapeBreakSpends(ADDR, {
      readCoin: coins({ [A]: LIVE }), readTxVerdict: verdicts({ [TX]: { kind: 'unreadable', reason: '?' } }), now: NOW,
    })
    expect(r).toMatchObject({ restored: [], kept: 1 })
  })

  it('a split or unreadable answer restores nothing, marks nothing, and runs again next time', async () => {
    condemn([A, B, C], TX)
    const readCoin = coins({ [A]: ['live', 'gone'], [B]: ['live', 'unknown'], [C]: LIVE })
    const r = await repairShapeBreakSpends(ADDR, { readCoin, readTxVerdict: verdicts(), now: NOW })
    expect(r).toMatchObject({ restored: [C], unresolved: 2, done: false })
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')

    // Next unlock: the nodes now agree, and the run completes.
    const again = await repairShapeBreakSpends(ADDR, { readCoin: coins({ [A]: LIVE, [B]: GONE }), readTxVerdict: verdicts(), now: NOW })
    expect(again).toMatchObject({ skipped: false, restored: [A], kept: 1, unresolved: 0, done: true })
  })

  it('ignores records younger than the probe could ever have touched', async () => {
    condemn([A], TX, NOW - STALE_LOCK_MS + 1)
    const readCoin = coins({ [A]: LIVE })
    const r = await repairShapeBreakSpends(ADDR, { readCoin, readTxVerdict: verdicts(), now: NOW })
    expect(r).toMatchObject({ candidates: 0, done: true })
    expect(readCoin).not.toHaveBeenCalled()
  })

  it('leaves locked records to the sweep', async () => {
    markLocked(ADDR, [A], TX, 0)
    const r = await repairShapeBreakSpends(ADDR, { readCoin: coins({ [A]: LIVE }), readTxVerdict: verdicts(), now: NOW })
    expect(r.candidates).toBe(0)
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('locked')
  })

  it('is one-time: a done wallet is skipped without a single read', async () => {
    condemn([A], TX)
    await repairShapeBreakSpends(ADDR, { readCoin: coins({ [A]: GONE }), readTxVerdict: verdicts(), now: NOW })
    const readCoin = coins({ [A]: LIVE })
    const readTxVerdict = verdicts()
    const r = await repairShapeBreakSpends(ADDR, { readCoin, readTxVerdict, now: NOW })
    expect(r.skipped).toBe(true)
    expect(readCoin).not.toHaveBeenCalled()
    expect(readTxVerdict).not.toHaveBeenCalled()
  })

  it('is idempotent: a run cut off after restoring and repeated changes nothing twice', async () => {
    condemn([A, B], TX)
    // The first run restores A and cannot read B, so it is not done.
    await repairShapeBreakSpends(ADDR, { readCoin: coins({ [A]: LIVE }), readTxVerdict: verdicts(), now: NOW })
    const r = await repairShapeBreakSpends(ADDR, { readCoin: coins({ [A]: LIVE, [B]: LIVE }), readTxVerdict: verdicts(), now: NOW })
    expect(r).toMatchObject({ candidates: 1, restored: [B], done: true })
    expect(Object.keys(loadSpentOutputs(ADDR).records)).toEqual([])
  })

  it('survives a reader that throws, as unresolved', async () => {
    condemn([A], TX)
    const r = await repairShapeBreakSpends(ADDR, {
      readCoin: async () => { throw new Error('network') },
      readTxVerdict: async () => { throw new Error('network') },
      now: NOW,
    })
    expect(r).toMatchObject({ restored: [], unresolved: 1, done: false })
  })

  it('a record it cannot open is not an empty one: nothing is read and nothing is marked done', async () => {
    condemn([A], TX)
    setStoreKey(null as unknown as Uint8Array)   // locked wallet: the record reads as empty
    const readCoin = coins({ [A]: LIVE })
    const r = await repairShapeBreakSpends(ADDR, { readCoin, readTxVerdict: verdicts(), now: NOW })
    expect(r).toMatchObject({ candidates: 0, done: false })
    expect(readCoin).not.toHaveBeenCalled()
    // Unlocked again, the run happens.
    setStoreKey(new Uint8Array(32).fill(3))
    expect(await repairShapeBreakSpends(ADDR, { readCoin, readTxVerdict: verdicts(), now: NOW }))
      .toMatchObject({ restored: [A], done: true })
  })

  it('a lost write restores nothing on disk and is not marked done', async () => {
    condemn([A], TX)
    const real = globalThis.localStorage
    globalThis.localStorage = { ...real, getItem: real.getItem.bind(real), setItem: () => { throw new Error('quota') } } as Storage
    const r = await repairShapeBreakSpends(ADDR, { readCoin: coins({ [A]: LIVE }), readTxVerdict: verdicts(), now: NOW })
    globalThis.localStorage = real
    expect(r).toMatchObject({ restored: [], unresolved: 1, done: false })
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
  })
})
