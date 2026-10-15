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
  resolveLockAction, settleLocks,
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
// The fee diff took down the fee coin A (and the account vault the fee bucket came from), not B.
const FEE_ONLY = finalized({ AcceptFeeRejectRest: [
  { up_substates: [], down_substates: [[A, 0], ['vault_6a6de7ab', 4]], fee_withdrawals: [] },
  { SubstateNotFound: 'vault_6a6de7ab' },
] })
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

  // The fee committed and the body did not: what the FEE INTENT spent is spent, the rest is not.
  it('AcceptFeeRejectRest settles coin by coin from its fee diff — never a blanket release', () => {
    expect(resolveLockAction({ kind: 'fee-only', reason: 'nope', consumed: [A] })).toBe('settle')
  })

  // Without the diff nobody can say which coins the fee intent took, so nothing is decided.
  it('AcceptFeeRejectRest with an unreadable diff KEEPS the lock', () => {
    expect(resolveLockAction({ kind: 'fee-only', reason: 'nope', consumed: null })).toBe('keep')
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

  // THE BUG THIS PINS: a timed-out transaction whose fee committed and whose body was rejected. Its
  // fee coin (A, spent in the fee intent) is gone; its main-intent coin (B) was never touched. The
  // sweep used to release both, putting a spent coin back into the balance and into coin selection.
  it('a timed-out fee-only commit: the fee coin STAYS SPENT, the untouched coin comes back', async () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    const r = await sweepLocks(ADDR, { fetchResult: async () => FEE_ONLY, now: 2_000 })
    expect(r.resolved).toBe(1)
    expect(r.steps[0]!.action).toBe('settle')
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
    expect(loadSpentOutputs(ADDR).records[B]).toBeUndefined()
    // Balance exact: exactly the consumed coin is held out of it.
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })

  it('a fee-only commit whose diff cannot be read keeps every lock; the coin probe settles each later', async () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    const noDiff = finalized({ AcceptFeeRejectRest: [{}, { SubstateNotFound: 'x' }] })
    const early = await sweepLocks(ADDR, { fetchResult: async () => noDiff, now: 2_000 })
    expect(early.steps[0]!.action).toBe('keep')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A, B]))
    // Once stale, the coins answer for themselves — a MIXED answer is exactly a fee-only commit.
    const probeCoin = async (id: string): Promise<CoinState> => (id === A ? 'gone' : 'live')
    const late = await sweepLocks(ADDR, { fetchResult: async () => noDiff, probeCoin, now: 1_000 + STALE_LOCK_MS })
    expect(late.steps[0]).toMatchObject({ action: 'settle', via: 'substate', affected: 2 })
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })

  it('a mixed probe with any coin unanswered still keeps the lock', async () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    const probeCoin = async (id: string): Promise<CoinState> => (id === A ? 'gone' : 'unknown')
    const r = await sweepLocks(ADDR, { fetchResult: async () => null, probeCoin, now: 1_000 + STALE_LOCK_MS })
    expect(r.steps[0]!.action).toBe('keep')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A, B]))
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

  // A mixed answer is NOT unreadable: it is what a fee-only commit leaves behind (the fee intent
  // consumed its coin; the rejected main intent consumed nothing). Each coin is settled by what the
  // chain says about IT — releasing B's partner A as well would hand back a spent coin.
  it('settles a mixed answer coin by coin: the gone coin stays spent, the live one comes back', async () => {
    markLocked(ADDR, [A, B], TX, 0)
    const r = await sweepLocks(ADDR, {
      fetchResult: pruned,
      probeCoin: async (id) => (id === A ? 'live' : 'gone'),
      now: AGED,
    })
    expect(r.steps[0]).toMatchObject({ action: 'settle', via: 'substate' })
    expect(loadSpentOutputs(ADDR).records[B]!.status).toBe('spent')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([B]))
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

describe('settleLocks — the rule every submit path applies once its transaction is decided', () => {
  it('Commit spends, a plain Reject releases (a tx that never landed gives its coins back), Timeout keeps', () => {
    markLocked(ADDR, [A], TX, 1_000)
    expect(settleLocks(ADDR, TX, 'Timeout', null)).toBe('keep')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
    expect(settleLocks(ADDR, TX, 'Reject', REJECT)).toBe('release')
    expect(loadExcludedIds(ADDR).size).toBe(0)
    markLocked(ADDR, [B], TX2, 1_000)
    expect(settleLocks(ADDR, TX2, 'Commit', ACCEPT)).toBe('promote')
    expect(loadSpentOutputs(ADDR).records[B]!.status).toBe('spent')
  })

  it('a Reject that was really a fee-only commit keeps the fee coin spent and releases the rest', () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    expect(settleLocks(ADDR, TX, 'Reject', FEE_ONLY)).toBe('settle')
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })
})
