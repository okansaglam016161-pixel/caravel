// Persistence rules for the journal.
//
// The interesting half is what happens when storage REFUSES a write. Every other store in this app
// swallows that and carries on, which is right for a cache and wrong for a ledger: a dropped
// journal entry leaves a hole, and a hole is what later makes the wallet call its own change output
// a payment from a stranger. These pin the degradation path as hard as the happy one.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSessionDegradationsForTests,
  beginEntry, ensureEpoch, journalSnapshot, loadEpoch, loadJournal, markDegraded, settleEntry,
  subscribeJournal,
} from './journalStore'
import { journalCovers, type JournalDraft } from './journal'

// localStorage does not exist under Vitest's node environment — the same in-memory Storage the
// other crypto specs use, with a switch that makes writes start failing on demand.
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

const DRAFT: JournalDraft = {
  kind: 'send',
  amountMicrotari: 1_500_000n,
  feeMicrotari: null,
  from: 'private',
  to: 'external',
  counterparty: { kind: 'address', value: 'otl_esm_1recipient' },
  note: 'lunch',
  source: 'local-journal',
  selfOutputIds: null,
}

beforeEach(() => {
  failWrites = false
  globalThis.localStorage = memoryStorage()
  __resetSessionDegradationsForTests()
})

describe('round-trip', () => {
  it('persists an entry and reads it back', () => {
    const { entry, ok } = beginEntry(ADDR, DRAFT)
    expect(ok).toBe(true)
    const [stored] = loadJournal(ADDR)
    expect(stored).toEqual(entry)
  })

  it('survives bigint amounts through JSON, including large ones', () => {
    // JSON cannot carry a bigint; amounts are stored as decimal strings. A figure past
    // Number.MAX_SAFE_INTEGER is the case that catches a `Number()` slipping in.
    const big = 9_007_199_254_740_993n
    beginEntry(ADDR, { ...DRAFT, amountMicrotari: big, feeMicrotari: 14_457n })
    const [stored] = loadJournal(ADDR)
    expect(stored.amountMicrotari).toBe(big)
    expect(stored.feeMicrotari).toBe(14_457n)
  })

  it('preserves a null amount as null across a reload — never as zero', () => {
    beginEntry(ADDR, { ...DRAFT, amountMicrotari: null, feeMicrotari: null })
    const [stored] = loadJournal(ADDR)
    expect(stored.amountMicrotari).toBeNull()
    expect(stored.feeMicrotari).toBeNull()
  })

  it('keeps [] and null distinct on selfOutputIds across a reload', () => {
    // The whole value of the field. [] is "this action made nothing for us"; null is "we do not
    // know what it made". Reconciliation may subtract the first and must refuse the second.
    beginEntry(ADDR, { ...DRAFT, selfOutputIds: [] })
    beginEntry(ADDR, { ...DRAFT, selfOutputIds: null })
    const [nullOne, emptyOne] = loadJournal(ADDR)   // newest first
    expect(nullOne.selfOutputIds).toBeNull()
    expect(emptyOne.selfOutputIds).toEqual([])
  })

  it('is newest-first', () => {
    beginEntry(ADDR, { ...DRAFT, note: 'first' })
    beginEntry(ADDR, { ...DRAFT, note: 'second' })
    expect(loadJournal(ADDR).map(e => e.note)).toEqual(['second', 'first'])
  })

  it('keeps wallets apart', () => {
    beginEntry(ADDR, DRAFT)
    expect(loadJournal(OTHER)).toEqual([])
  })

  it('reads an absent or corrupt store as empty rather than throwing', () => {
    expect(loadJournal(ADDR)).toEqual([])
    localStorage.setItem('caravel.journal.v1.' + ADDR, '{not json')
    expect(loadJournal(ADDR)).toEqual([])
  })
})

describe('the two-phase write — the throwing-action hole', () => {
  it('leaves a pending record before anything is submitted', () => {
    const { entry } = beginEntry(ADDR, DRAFT)
    const [stored] = loadJournal(ADDR)
    expect(stored.outcome).toBe('pending')
    expect(stored.txId).toBeNull()
    expect(stored.id).toBe(entry.id)
  })

  it('patches in the outcome the action reported', () => {
    const { entry } = beginEntry(ADDR, DRAFT)
    const res = settleEntry(ADDR, entry.id, {
      outcome: 'committed', txId: 'tx123', feeMicrotari: 14_457n, selfOutputIds: ['utxo_change'],
    })
    expect(res).toEqual({ ok: true, found: true })
    const [stored] = loadJournal(ADDR)
    expect(stored).toMatchObject({ outcome: 'committed', txId: 'tx123', feeMicrotari: 14_457n })
    expect(stored.selfOutputIds).toEqual(['utxo_change'])
  })

  it('records a THROWN action as failed rather than losing it', () => {
    // The behaviour this replaces: an exception mid-send left no trace at all, and the user saw an
    // error over a wallet whose history said nothing had happened.
    const { entry } = beginEntry(ADDR, DRAFT)
    settleEntry(ADDR, entry.id, { outcome: 'failed' })
    const [stored] = loadJournal(ADDR)
    expect(stored.outcome).toBe('failed')
    expect(stored.amountMicrotari).toBe(1_500_000n)   // what we attempted is still on the record
  })

  it('does NOT invent a row when the id is unknown', () => {
    // If beginEntry failed to persist, there is nothing to patch. Writing a fresh row here would
    // paper over the exact hole the epoch exists to record.
    const res = settleEntry(ADDR, 'never-existed', { outcome: 'committed' })
    expect(res).toEqual({ ok: false, found: false })
    expect(loadJournal(ADDR)).toEqual([])
  })
})

describe('the epoch', () => {
  it('is absent until the first write, then fixed', () => {
    expect(loadEpoch(ADDR)).toBeNull()
    const first = beginEntry(ADDR, DRAFT).entry.timestamp
    const epoch = loadEpoch(ADDR)
    expect(epoch?.degradedAt).toBeNull()
    expect(epoch!.startedAt).toBeLessThanOrEqual(first)
  })

  it('does not move once started', () => {
    ensureEpoch(ADDR, 1_000)
    ensureEpoch(ADDR, 9_999)
    expect(loadEpoch(ADDR)?.startedAt).toBe(1_000)
  })

  it('is per wallet — a restored wallet starts its own', () => {
    ensureEpoch(ADDR, 1_000)
    ensureEpoch(OTHER, 5_000)
    expect(loadEpoch(ADDR)?.startedAt).toBe(1_000)
    expect(loadEpoch(OTHER)?.startedAt).toBe(5_000)
  })

  it('degrades on a lost write, and the guard then refuses everything', () => {
    ensureEpoch(ADDR, 1_000)
    failWrites = true
    const { ok } = beginEntry(ADDR, DRAFT, 2_000)
    expect(ok).toBe(false)

    // KNOWN IMMEDIATELY, even though the write that would record it also failed. markDegraded is
    // called exactly when storage is refusing, so it cannot depend on storage to remember.
    const live = loadEpoch(ADDR)
    expect(live?.degradedAt).toBe(2_000)
    expect(journalCovers(live, 9_999)).toBe(false)

    // And once storage recovers, the stamp reaches disk.
    failWrites = false
    markDegraded(ADDR, 5_000)
    expect(loadEpoch(ADDR)?.degradedAt).toBe(2_000)   // the ORIGINAL moment, not the retry's
  })

  it('is safe across a reload even when NOTHING could be written', () => {
    // A browser with storage disabled outright: no epoch, no entries, nothing. The guard reads an
    // absent epoch as "claim nothing", so the unsafe combination — a journal that looks complete
    // but is not — cannot survive a reload either.
    failWrites = true
    beginEntry(ADDR, DRAFT, 2_000)
    __resetSessionDegradationsForTests()          // simulate the reload
    expect(loadEpoch(ADDR)).toBeNull()
    expect(journalCovers(loadEpoch(ADDR), 9_999)).toBe(false)
  })

  it('degrades on a lost SETTLE too, not only a lost begin', () => {
    const { entry } = beginEntry(ADDR, DRAFT, 1_000)
    failWrites = true
    expect(settleEntry(ADDR, entry.id, { outcome: 'committed' }, 3_000).ok).toBe(false)
    expect(loadEpoch(ADDR)?.degradedAt).toBe(3_000)
  })

  it('never un-degrades', () => {
    markDegraded(ADDR, 2_000)
    markDegraded(ADDR, 8_000)
    beginEntry(ADDR, DRAFT)
    expect(loadEpoch(ADDR)?.degradedAt).toBe(2_000)
  })
})

describe('the React snapshot', () => {
  // useSyncExternalStore compares snapshots BY IDENTITY. `loadJournal` parses JSON and returns a
  // fresh array every call, so handing it over unmemoised re-renders forever: React sees a new
  // array, re-reads, sees another new array, and never settles. These pin the cache that prevents
  // it — and pin that a write still invalidates it, or the list would never update.

  it('returns the IDENTICAL array when nothing has been written', () => {
    beginEntry(ADDR, DRAFT)
    const a = journalSnapshot(ADDR)
    const b = journalSnapshot(ADDR)
    expect(a).toBe(b)                 // reference equality, not deep equality
  })

  it('returns a different array after a write', () => {
    const a = journalSnapshot(ADDR)
    beginEntry(ADDR, DRAFT)
    expect(journalSnapshot(ADDR)).not.toBe(a)
  })

  it('invalidates on a settle too, not only on a begin', () => {
    const { entry } = beginEntry(ADDR, DRAFT)
    const a = journalSnapshot(ADDR)
    settleEntry(ADDR, entry.id, { outcome: 'committed' })
    const b = journalSnapshot(ADDR)
    expect(b).not.toBe(a)
    expect(b[0].outcome).toBe('committed')
  })

  it('re-reads when the wallet changes', () => {
    beginEntry(ADDR, DRAFT)
    const mine = journalSnapshot(ADDR)
    expect(journalSnapshot(OTHER)).toEqual([])
    expect(journalSnapshot(ADDR)).not.toBe(mine)   // cache is per address, so this re-parses
  })

  it('gives a stable empty array when there is no wallet', () => {
    // The locked case. A fresh [] each call would re-render forever just as surely.
    expect(journalSnapshot(null)).toBe(journalSnapshot(null))
    expect(journalSnapshot(null)).toEqual([])
  })

  it('notifies subscribers on every write, and stops after unsubscribe', () => {
    let calls = 0
    const unsubscribe = subscribeJournal(() => { calls++ })
    const { entry } = beginEntry(ADDR, DRAFT)
    settleEntry(ADDR, entry.id, { outcome: 'committed' })
    expect(calls).toBe(2)
    unsubscribe()
    beginEntry(ADDR, DRAFT)
    expect(calls).toBe(2)
  })
})
