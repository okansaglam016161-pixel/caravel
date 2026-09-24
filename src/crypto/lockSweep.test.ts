// Resolving a lock against the chain.
//
// THE ASYMMETRY UNDER TEST is the one that inverts txResult's rule: releasing a coin that was
// genuinely spent returns it to coin selection and produces a transaction the chain rejects after
// taking its fee, while keeping a live coin excluded costs a delay and an honest message. So every
// outcome this cannot read as a definite failure must KEEP the lock. Half these specs exist to pin
// that direction.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setStoreKey } from './sessionKey'
import {
  __resetSpentSessionForTests, loadExcludedIds, loadSpentOutputs, markLocked, promoteToSpent,
  resolveLockAction,
} from './spentOutputs'
import { STALE_LOCK_MS, sweepLocks, type CoinState } from './lockSweep'

const STORE_KEY = new Uint8Array(32).fill(9)

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

const ADDR = 'otl_esm_1tnay4uzgpe0cvu4tzwfmhdhtvc3pq97s'
const A = 'utxo_0101_aaa'
const B = 'utxo_0101_bbb'
const TX = 'tx_814f1cb9'
const TX2 = 'tx_deadbeef'

/** The committed shape: result.Finalized.execution_result.finalize.result. */
const finalized = (result: unknown, decision = 'Commit') => ({
  result: { Finalized: { final_decision: decision, execution_result: { finalize: { result } } } },
})
const ACCEPT = finalized({ Accept: {} })
const REJECT = finalized({ Reject: { ExecutionFailure: 'Input substate utxo_… is down' } })
const FEE_ONLY = finalized({ AcceptFeeRejectRest: [{}, { SubstateNotFound: 'vault_6a6de7ab' }] })
const UNDECIDED = { result: { Finalized: { final_decision: '' } } }
const UNREADABLE = finalized({ SomethingNewAndUnknown: {} })

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  __resetSpentSessionForTests()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

describe('resolveLockAction', () => {
  it('Accept spends the coins', () => {
    expect(resolveLockAction({ kind: 'accept' })).toBe('promote')
  })

  it('Reject gives them back', () => {
    expect(resolveLockAction({ kind: 'reject', reason: 'nope' })).toBe('release')
  })

  // The fee committed and the body did not, so the inputs were never consumed.
  it('AcceptFeeRejectRest gives them back too', () => {
    expect(resolveLockAction({ kind: 'fee-only', reason: 'nope' })).toBe('release')
  })

  it('no verdict yet keeps the lock', () => {
    expect(resolveLockAction(null)).toBe('keep')
  })

  // txResult would call this a failure. Here it must not release — see the header.
  it('a decided-but-unreadable result KEEPS the lock rather than releasing it', () => {
    expect(resolveLockAction({ kind: 'unreadable', reason: 'shape we do not know' })).toBe('keep')
  })
})

describe('sweeping', () => {
  it('does nothing, and asks nothing, when no lock is held', async () => {
    const fetchResult = vi.fn()
    const r = await sweepLocks(ADDR, { fetchResult })
    expect(r).toEqual({ swept: 0, resolved: 0, steps: [] })
    expect(fetchResult).not.toHaveBeenCalled()
  })

  it('promotes on Accept — the coins stay excluded, as spent', async () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    const r = await sweepLocks(ADDR, { fetchResult: async () => ACCEPT, now: 2_000 })
    expect(r.resolved).toBe(1)
    expect(r.steps[0]!.action).toBe('promote')
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A, B]))
  })

  it('releases on Reject — the coins come back', async () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    const r = await sweepLocks(ADDR, { fetchResult: async () => REJECT, now: 2_000 })
    expect(r.resolved).toBe(1)
    expect(r.steps[0]!.action).toBe('release')
    expect(loadExcludedIds(ADDR).size).toBe(0)
  })

  it('releases on a fee-only commit', async () => {
    markLocked(ADDR, [A], TX, 1_000)
    await sweepLocks(ADDR, { fetchResult: async () => FEE_ONLY, now: 2_000 })
    expect(loadExcludedIds(ADDR).size).toBe(0)
  })

  it('keeps an undecided transaction locked, and counts the attempt', async () => {
    markLocked(ADDR, [A], TX, 1_000)
    const r = await sweepLocks(ADDR, { fetchResult: async () => UNDECIDED, now: 2_000 })
    expect(r.resolved).toBe(0)
    expect(r.steps[0]!.action).toBe('keep')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
    expect(loadSpentOutputs(ADDR).records[A]!.attempts).toBe(1)
  })

  // A dead indexer must never be read as "this transaction failed".
  it('keeps the lock when the result cannot be fetched at all', async () => {
    markLocked(ADDR, [A], TX, 1_000)
    await sweepLocks(ADDR, { fetchResult: async () => null, now: 2_000 })
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
    expect(loadSpentOutputs(ADDR).records[A]!.attempts).toBe(1)
  })

  it('counts an attempt per sweep, so the safety net can eventually speak up', async () => {
    markLocked(ADDR, [A], TX, 1_000)
    for (let i = 0; i < 3; i++) await sweepLocks(ADDR, { fetchResult: async () => null, now: 2_000 })
    expect(loadSpentOutputs(ADDR).records[A]!.attempts).toBe(3)
  })

  it('resolves each locked transaction independently', async () => {
    markLocked(ADDR, [A], TX, 1_000)
    markLocked(ADDR, [B], TX2, 1_000)
    await sweepLocks(ADDR, {
      fetchResult: async (txId) => (txId === TX ? ACCEPT : REJECT),
      now: 2_000,
    })
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
    expect(loadSpentOutputs(ADDR).records[B]).toBeUndefined()
  })

  it('an unreadable verdict keeps the lock rather than releasing the coin', async () => {
    markLocked(ADDR, [A], TX, 1_000)
    await sweepLocks(ADDR, { fetchResult: async () => UNREADABLE, now: 2_000 })
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })

  // Already resolved: lockedTxIds returns nothing, so a settled transaction is never re-fetched.
  it('does not re-ask about a transaction it has already settled', async () => {
    markLocked(ADDR, [A], TX, 1_000)
    promoteToSpent(ADDR, TX, 1_500)
    const fetchResult = vi.fn()
    expect((await sweepLocks(ADDR, { fetchResult })).swept).toBe(0)
    expect(fetchResult).not.toHaveBeenCalled()
  })
})

describe('the substate fallback', () => {
  // The finding that forced this to exist: BOTH transactions committed earlier the same day —
  // a faucet claim and a confidential send — answered `404 not found` on the result endpoint
  // within hours. Results are pruned, so an old strand can never be resolved from one.
  const pruned = async () => null
  const coins = (state: CoinState) => async () => state
  const AGED = STALE_LOCK_MS + 1

  it('is not used while the lock is young enough to be a transaction in flight', async () => {
    markLocked(ADDR, [A], TX, 0)
    const probeCoin = vi.fn(coins('live'))
    const r = await sweepLocks(ADDR, { fetchResult: pruned, probeCoin, now: STALE_LOCK_MS - 1 })
    expect(probeCoin).not.toHaveBeenCalled()
    expect(r.steps[0]!.action).toBe('keep')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })

  it('releases once the coins are provably still live and the lock is stale', async () => {
    markLocked(ADDR, [A, B], TX, 0)
    const r = await sweepLocks(ADDR, { fetchResult: pruned, probeCoin: coins('live'), now: AGED })
    expect(r.steps[0]!.action).toBe('release')
    expect(r.steps[0]!.via).toBe('substate')
    expect(loadExcludedIds(ADDR).size).toBe(0)
  })

  it('promotes once the coins are provably gone', async () => {
    markLocked(ADDR, [A, B], TX, 0)
    const r = await sweepLocks(ADDR, { fetchResult: pruned, probeCoin: coins('gone'), now: AGED })
    expect(r.steps[0]!.action).toBe('promote')
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
  })

  // A transaction consumes all of its inputs or none of them, so a mixed answer is not a reading
  // we understand — and an unreadable one must never move money on a screen.
  it('keeps the lock on a mixed answer', async () => {
    markLocked(ADDR, [A, B], TX, 0)
    const r = await sweepLocks(ADDR, {
      fetchResult: pruned,
      probeCoin: async (id) => (id === A ? 'live' : 'gone'),
      now: AGED,
    })
    expect(r.steps[0]!.action).toBe('keep')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A, B]))
  })

  it('keeps the lock when even one coin cannot be read', async () => {
    markLocked(ADDR, [A, B], TX, 0)
    const r = await sweepLocks(ADDR, {
      fetchResult: pruned,
      probeCoin: async (id) => (id === A ? 'live' : 'unknown'),
      now: AGED,
    })
    expect(r.steps[0]!.action).toBe('keep')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A, B]))
  })

  // The result endpoint stays the primary oracle — it is a direct statement about the transaction.
  it('is never consulted when the transaction result answered', async () => {
    markLocked(ADDR, [A], TX, 0)
    const probeCoin = vi.fn(coins('live'))
    const r = await sweepLocks(ADDR, { fetchResult: async () => ACCEPT, probeCoin, now: AGED })
    expect(probeCoin).not.toHaveBeenCalled()
    expect(r.steps[0]!.via).toBe('result')
    expect(r.steps[0]!.action).toBe('promote')
  })
})
