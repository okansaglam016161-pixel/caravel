// The spend record.
//
// Everything here protects one direction of one error, and it is the opposite direction to
// utxoLedger's. There, a UTXO that looks NEWER than it is gets misread as a stranger's payment.
// Here, a coin that looks UNSPENT when it is not gets counted into the balance and — far worse —
// selected as an input again, producing a transaction the chain rejects after taking its fee. So
// every rule below errs towards keeping a coin excluded: locks survive a timeout, releases only
// undo a lock, and forgetting needs several complete scans to agree plus a time floor.

import { beforeEach, describe, expect, it } from 'vitest'
import { clearStoreKey, setStoreKey } from './sessionKey'
import {
  ABSENT_SCANS_TO_FORGET, MIN_RETENTION_MS, UNRESOLVED_AFTER_ATTEMPTS, UNRESOLVED_AFTER_MS,
  __resetSpentSessionForTests,
  excludedIds, heldOutOfBalance, loadExcludedIds, loadSpentOutputs, lockedTxIds,
  markLocked, promoteToSpent, reconcileSpentOutputs, recordSweepAttempt, release,
} from './spentOutputs'

const STORE_KEY = new Uint8Array(32).fill(7)

let failWrites = false
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => {
      if (failWrites) throw new DOMException('quota', 'QuotaExceededError')
      map.set(k, v)
    },
  }
}

const ADDR = 'otl_esm_1tnay4uzgpe0cvu4tzwfmhdhtvc3pq97s'
const OTHER = 'otl_esm_1someoneelsesaddress0000000000000'
const A = 'utxo_0101_aaa'
const B = 'utxo_0101_bbb'
const C = 'utxo_0101_ccc'
const TX = 'tx_a2a814'
const TX2 = 'tx_b71f09'

const complete = (presentIds: string[]) => ({ presentIds, incomplete: false })
const truncated = (presentIds: string[]) => ({ presentIds, incomplete: true })

/** Old enough to clear the retention floor, so a spec can isolate the scan-count rule. */
const AGED = MIN_RETENTION_MS + 1

beforeEach(() => {
  failWrites = false
  globalThis.localStorage = memoryStorage()
  __resetSpentSessionForTests()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

describe('locking at submit', () => {
  it('excludes the inputs as soon as they are locked', () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A, B]))
  })

  it('records the transaction that consumed each one', () => {
    markLocked(ADDR, [A], TX, 1_000)
    expect(loadSpentOutputs(ADDR).records[A]).toEqual({ status: 'locked', txId: TX, at: 1_000, absent: 0, attempts: 0 })
  })

  it('keeps identities apart', () => {
    markLocked(ADDR, [A], TX, 1_000)
    expect(loadExcludedIds(OTHER).size).toBe(0)
  })

  it('locking nothing is not a write', () => {
    expect(markLocked(ADDR, [], TX, 1_000)).toEqual({ ok: true, locked: 0 })
  })

  // A guess must never overwrite a verdict.
  it('does not downgrade an already-spent record', () => {
    markLocked(ADDR, [A], TX, 1_000)
    promoteToSpent(ADDR, TX, 2_000)
    markLocked(ADDR, [A], TX2, 3_000)
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
    expect(loadSpentOutputs(ADDR).records[A]!.txId).toBe(TX)
  })
})

describe('resolving the verdict', () => {
  it('Accept promotes the locks to spent, still excluded', () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    expect(promoteToSpent(ADDR, TX, 2_000).promoted).toBe(2)
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A, B]))
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('spent')
  })

  it('Reject releases them — the coins were never consumed', () => {
    markLocked(ADDR, [A, B], TX, 1_000)
    expect(release(ADDR, TX, 2_000).released).toBe(2)
    expect(loadExcludedIds(ADDR).size).toBe(0)
  })

  it('a release only touches its own transaction', () => {
    markLocked(ADDR, [A], TX, 1_000)
    markLocked(ADDR, [B], TX2, 1_000)
    release(ADDR, TX, 2_000)
    expect(loadExcludedIds(ADDR)).toEqual(new Set([B]))
  })

  // The one outcome worse than over-counting: putting a genuinely spent coin back in the pot.
  it('a release never undoes a spent record', () => {
    markLocked(ADDR, [A], TX, 1_000)
    promoteToSpent(ADDR, TX, 2_000)
    expect(release(ADDR, TX, 3_000).released).toBe(0)
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })

  // A timeout is not a verdict — neither resolver is called, and the lock stands.
  it('leaves a lock in place when nothing resolves it', () => {
    markLocked(ADDR, [A], TX, 1_000)
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
    expect(lockedTxIds(loadSpentOutputs(ADDR))).toEqual([TX])
  })
})

describe('reconciliation', () => {
  it('a truncated scan changes nothing — it saw a subset', () => {
    markLocked(ADDR, [A], TX, 0)
    promoteToSpent(ADDR, TX, 0)
    const r = reconcileSpentOutputs(ADDR, truncated([]), AGED)
    expect(r.skipped).toBe('incomplete')
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })

  it('forgets only after enough complete scans agree', () => {
    markLocked(ADDR, [A], TX, 0)
    promoteToSpent(ADDR, TX, 0)
    for (let i = 1; i < ABSENT_SCANS_TO_FORGET; i++) {
      reconcileSpentOutputs(ADDR, complete([]), AGED)
      expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
    }
    expect(reconcileSpentOutputs(ADDR, complete([]), AGED).forgotten).toBe(1)
    expect(loadExcludedIds(ADDR).size).toBe(0)
  })

  // The measured failure: indexer-a was missing 79 live outputs that indexer-b listed. A listing
  // that drops a row can bring it back, so absence must be consecutive to count.
  it('a single reappearance restarts the count', () => {
    markLocked(ADDR, [A], TX, 0)
    promoteToSpent(ADDR, TX, 0)
    reconcileSpentOutputs(ADDR, complete([]), AGED)
    reconcileSpentOutputs(ADDR, complete([A]), AGED)   // the indexer flaps it back
    expect(loadSpentOutputs(ADDR).records[A]!.absent).toBe(0)

    for (let i = 1; i < ABSENT_SCANS_TO_FORGET; i++) reconcileSpentOutputs(ADDR, complete([]), AGED)
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))   // still short by one
    reconcileSpentOutputs(ADDR, complete([]), AGED)
    expect(loadExcludedIds(ADDR).size).toBe(0)
  })

  it('will not forget inside the retention floor, however many scans agree', () => {
    markLocked(ADDR, [A], TX, 0)
    promoteToSpent(ADDR, TX, 0)
    for (let i = 0; i < ABSENT_SCANS_TO_FORGET + 5; i++) {
      reconcileSpentOutputs(ADDR, complete([]), MIN_RETENTION_MS - 1)
    }
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })

  it('leaves a still-listed record alone', () => {
    markLocked(ADDR, [A, B], TX, 0)
    promoteToSpent(ADDR, TX, 0)
    for (let i = 0; i < ABSENT_SCANS_TO_FORGET + 2; i++) {
      reconcileSpentOutputs(ADDR, complete([A]), AGED)
    }
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))   // B forgotten, A still listed
  })
})

describe('degradation', () => {
  // Blocked storage must not take down a send that has already left the wallet.
  it('a failed write is reported, not thrown', () => {
    failWrites = true
    expect(() => markLocked(ADDR, [A], TX, 1_000)).not.toThrow()
    expect(markLocked(ADDR, [B], TX, 1_000).ok).toBe(false)
    expect(loadSpentOutputs(ADDR).degradedAt).toBe(1_000)
  })

  // The honest consequence, stated: with no store key nothing can be sealed, so nothing is
  // excluded and the wallet degrades to exactly its pre-fix behaviour rather than to something
  // worse. There is no fail-closed option — excluding everything would zero a working wallet.
  it('reads as empty with no store key rather than excluding blindly', () => {
    markLocked(ADDR, [A], TX, 1_000)
    clearStoreKey()
    expect(loadExcludedIds(ADDR).size).toBe(0)
  })
})

describe('excludedIds', () => {
  it('is both states together — locked and spent alike', () => {
    markLocked(ADDR, [A], TX, 1_000)
    markLocked(ADDR, [B], TX2, 1_000)
    promoteToSpent(ADDR, TX, 2_000)
    expect(excludedIds(loadSpentOutputs(ADDR))).toEqual(new Set([A, B]))
    expect(loadExcludedIds(ADDR).has(C)).toBe(false)
  })
})

describe('reconciliation never forgets a lock', () => {
  // THE STAGE 1b CORRECTION. Reconcile used to iterate every record, so a `locked` entry had two
  // exits: the sweep, and simply being absent from the listing for long enough. The second is
  // unsound — a lock is held precisely because the transaction's fate is unknown, and the listing
  // that would "prove" absence was measured dropping 79 live outputs. Forgetting one could make a
  // coin selectable again while its first transaction was still in flight.
  it('leaves a locked entry alone however absent and however old', () => {
    markLocked(ADDR, [A], TX, 0)
    for (let i = 0; i < ABSENT_SCANS_TO_FORGET + 10; i++) {
      reconcileSpentOutputs(ADDR, complete([]), MIN_RETENTION_MS * 100)
    }
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
    expect(loadSpentOutputs(ADDR).records[A]!.status).toBe('locked')
  })

  it('still forgets a spent one beside it — the two are disjoint', () => {
    markLocked(ADDR, [A], TX, 0)      // stays locked
    markLocked(ADDR, [B], TX2, 0)
    promoteToSpent(ADDR, TX2, 0)      // resolved, so collectable
    for (let i = 0; i < ABSENT_SCANS_TO_FORGET; i++) {
      reconcileSpentOutputs(ADDR, complete([]), AGED)
    }
    expect(loadExcludedIds(ADDR)).toEqual(new Set([A]))
  })
})

describe('the safety net', () => {
  const held = (ids: string[], each: bigint, now: number) =>
    heldOutOfBalance(loadSpentOutputs(ADDR), ids.map(id => ({ id, microtari: each })), now)

  // Only coins the indexer is STILL listing subtract from anything — the scan never sees the rest.
  it('totals what the exclusion is actually costing the displayed balance', () => {
    markLocked(ADDR, [A, B], TX, 0)
    expect(held([A, B], 500n, 0).totalMicrotari).toBe(1_000n)
    expect(held([A], 500n, 0).totalMicrotari).toBe(500n)
    expect(held([], 500n, 0).totalMicrotari).toBe(0n)
  })

  // A spend in flight is not a problem and must not be reported as one.
  it('reports nothing unresolved while the lock is young', () => {
    markLocked(ADDR, [A], TX, 0)
    expect(held([A], 500n, UNRESOLVED_AFTER_MS - 1).unresolved).toEqual([])
  })

  it('reports it once the lock outlives any explanation', () => {
    markLocked(ADDR, [A], TX, 0)
    const summary = held([A], 500n, UNRESOLVED_AFTER_MS + 1)
    expect(summary.unresolved).toHaveLength(1)
    expect(summary.unresolved[0]!.txId).toBe(TX)
    expect(summary.unresolved[0]!.microtari).toBe(500n)
  })

  it('or once enough sweeps have failed to settle it, whatever its age', () => {
    markLocked(ADDR, [A], TX, 0)
    for (let i = 0; i < UNRESOLVED_AFTER_ATTEMPTS; i++) recordSweepAttempt(ADDR, TX, 0)
    expect(held([A], 500n, 0).unresolved).toHaveLength(1)
  })

  // A `spent` record is a settled fact awaiting the listing, not something to chase.
  it('never reports a spent record as unresolved', () => {
    markLocked(ADDR, [A], TX, 0)
    promoteToSpent(ADDR, TX, 0)
    const summary = held([A], 500n, UNRESOLVED_AFTER_MS * 100)
    expect(summary.totalMicrotari).toBe(500n)
    expect(summary.unresolved).toEqual([])
  })

  it('groups several coins under the one transaction holding them', () => {
    markLocked(ADDR, [A, B], TX, 0)
    const summary = held([A, B], 500n, UNRESOLVED_AFTER_MS + 1)
    expect(summary.unresolved).toHaveLength(1)
    expect(summary.unresolved[0]!.microtari).toBe(1_000n)
  })
})
