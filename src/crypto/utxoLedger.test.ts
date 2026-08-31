// The first-seen ledger.
//
// Everything here protects one direction of one error. A UTXO that looks NEWER than it is passes a
// guard it should have failed, and gets classified as a payment from a stranger when it is in fact
// the user's own change. Every rule below — first-write-wins, refusing truncated scans, a baseline
// that defaults to "pre-epoch" — exists to stop a date drifting forward.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetLedgerSessionForTests,
  captureBaseline, firstSeenAt, isPreEpoch, loadLedger, recordCompleteScan,
} from './utxoLedger'
import { OUTPUT_CREATING_ACTIONS, journalCovers, type JournalEpoch } from './journal'

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

const complete = (ids: string[]) => ({ utxoIds: ids, incomplete: false })
const truncated = (ids: string[]) => ({ utxoIds: ids, incomplete: true })

beforeEach(() => {
  failWrites = false
  globalThis.localStorage = memoryStorage()
  __resetLedgerSessionForTests()
})

describe('recording a complete scan', () => {
  it('stamps every UTXO it saw', () => {
    const { added } = recordCompleteScan(ADDR, complete([A, B]), 1_000)
    expect(added).toBe(2)
    const led = loadLedger(ADDR)
    expect(firstSeenAt(led, A)).toBe(1_000)
    expect(firstSeenAt(led, B)).toBe(1_000)
  })

  it('reads an unseen UTXO as null, not as zero or now', () => {
    expect(firstSeenAt(loadLedger(ADDR), C)).toBeNull()
  })

  it('reads an absent or corrupt store as empty rather than throwing', () => {
    expect(loadLedger(ADDR).firstSeen).toEqual({})
    localStorage.setItem('caravel.utxoseen.v1.' + ADDR, '{not json')
    expect(loadLedger(ADDR).firstSeen).toEqual({})
  })
})

describe('first write wins — a date never moves forward', () => {
  it('keeps the ORIGINAL date when a later scan sees the same UTXO', () => {
    // The core rule. A later sighting is not new information about when it appeared, and a date
    // that drifted forward would make an old output look recent — the direction that lies.
    recordCompleteScan(ADDR, complete([A]), 1_000)
    recordCompleteScan(ADDR, complete([A]), 9_999)
    expect(firstSeenAt(loadLedger(ADDR), A)).toBe(1_000)
  })

  it('stamps only the genuinely new one when a scan mixes old and new', () => {
    recordCompleteScan(ADDR, complete([A]), 1_000)
    const { added } = recordCompleteScan(ADDR, complete([A, B]), 2_000)
    expect(added).toBe(1)
    const led = loadLedger(ADDR)
    expect(firstSeenAt(led, A)).toBe(1_000)
    expect(firstSeenAt(led, B)).toBe(2_000)
  })

  it('does not forget a UTXO that has since been spent', () => {
    // Spending removes it from the owned set, not from history. Its date must survive, or a
    // re-derived ledger would have a hole where a known-old output used to be.
    recordCompleteScan(ADDR, complete([A, B]), 1_000)
    recordCompleteScan(ADDR, complete([B]), 2_000)
    expect(firstSeenAt(loadLedger(ADDR), A)).toBe(1_000)
  })

  it('writes nothing at all when a scan is entirely familiar', () => {
    recordCompleteScan(ADDR, complete([A]), 1_000)
    const res = recordCompleteScan(ADDR, complete([A]), 2_000)
    expect(res).toMatchObject({ added: 0, ok: true })
  })
})

describe('a truncated scan is refused, not partially applied', () => {
  it('records nothing from an incomplete scan', () => {
    // The indexer capped the set, so this scan saw a SUBSET. Stamping it would date the ones it
    // happened to see correctly and leave the missed ones to be stamped later — later than the
    // truth, which is exactly the permissive direction.
    const res = recordCompleteScan(ADDR, truncated([A, B]), 1_000)
    expect(res).toMatchObject({ added: 0, skipped: 'incomplete' })
    expect(loadLedger(ADDR).firstSeen).toEqual({})
  })

  it('still records once a later scan comes back complete', () => {
    recordCompleteScan(ADDR, truncated([A]), 1_000)
    recordCompleteScan(ADDR, complete([A]), 2_000)
    expect(firstSeenAt(loadLedger(ADDR), A)).toBe(2_000)
  })

  it('does not let a truncated scan disturb dates already recorded', () => {
    recordCompleteScan(ADDR, complete([A]), 1_000)
    recordCompleteScan(ADDR, truncated([A, B]), 2_000)
    const led = loadLedger(ADDR)
    expect(firstSeenAt(led, A)).toBe(1_000)
    expect(firstSeenAt(led, B)).toBeNull()
  })
})

describe('per-wallet isolation', () => {
  it('keeps two wallets’ sightings apart', () => {
    recordCompleteScan(ADDR, complete([A]), 1_000)
    recordCompleteScan(OTHER, complete([B]), 2_000)
    expect(firstSeenAt(loadLedger(ADDR), B)).toBeNull()
    expect(firstSeenAt(loadLedger(OTHER), A)).toBeNull()
  })

  it('gives a wallet with no ledger a clean empty one', () => {
    expect(loadLedger(OTHER)).toMatchObject({ firstSeen: {}, baseline: null, baselineAt: null })
  })
})

describe('the baseline', () => {
  it('is null until coverage completes, and everything is pre-epoch until then', () => {
    // The safe default. With no baseline, nothing is known to be new, so the honest answer to
    // "did this predate the journal" is yes — and nothing gets classified.
    recordCompleteScan(ADDR, complete([A]), 1_000)
    const led = loadLedger(ADDR)
    expect(led.baseline).toBeNull()
    expect(isPreEpoch(led, A)).toBe(true)
    expect(isPreEpoch(led, C)).toBe(true)
  })

  it('freezes the owned set, and anything arriving later is NOT pre-epoch', () => {
    captureBaseline(ADDR, complete([A, B]), 5_000)
    recordCompleteScan(ADDR, complete([A, B, C]), 6_000)
    const led = loadLedger(ADDR)
    expect(isPreEpoch(led, A)).toBe(true)
    expect(isPreEpoch(led, B)).toBe(true)
    expect(isPreEpoch(led, C)).toBe(false)      // arrived after coverage — classifiable
    expect(firstSeenAt(led, C)).toBe(6_000)
  })

  it('stamps the baselined UTXOs as seen, without overwriting older dates', () => {
    recordCompleteScan(ADDR, complete([A]), 1_000)
    captureBaseline(ADDR, complete([A, B]), 5_000)
    const led = loadLedger(ADDR)
    expect(firstSeenAt(led, A)).toBe(1_000)     // known earlier; not moved forward
    expect(firstSeenAt(led, B)).toBe(5_000)
  })

  it('is WRITE-ONCE — a second capture cannot re-baseline later arrivals', () => {
    // A re-baseline would silently erase every receive that had become classifiable.
    captureBaseline(ADDR, complete([A]), 5_000)
    const res = captureBaseline(ADDR, complete([A, B, C]), 9_000)
    expect(res.captured).toBe(false)
    const led = loadLedger(ADDR)
    expect(led.baseline).toEqual([A])
    expect(led.baselineAt).toBe(5_000)
    expect(isPreEpoch(led, C)).toBe(false)
  })

  it('refuses to baseline from a truncated scan', () => {
    // Worse here than when recording: a baseline missing a UTXO leaves that UTXO permanently
    // eligible for classification, which is a false receive waiting to happen.
    const res = captureBaseline(ADDR, truncated([A, B]), 5_000)
    expect(res.captured).toBe(false)
    expect(loadLedger(ADDR).baseline).toBeNull()
  })
})

describe('a lost write is recorded, never swallowed', () => {
  it('reports failure and marks the ledger degraded', () => {
    failWrites = true
    const res = recordCompleteScan(ADDR, complete([A]), 2_000)
    expect(res.ok).toBe(false)
    // Known immediately, even though the write that would persist it also failed.
    expect(loadLedger(ADDR).degradedAt).toBe(2_000)
  })

  it('does not report a date it failed to store', () => {
    failWrites = true
    recordCompleteScan(ADDR, complete([A]), 2_000)
    failWrites = false
    expect(firstSeenAt(loadLedger(ADDR), A)).toBeNull()
  })

  it('marks degraded on a failed baseline capture too', () => {
    failWrites = true
    expect(captureBaseline(ADDR, complete([A]), 3_000).captured).toBe(false)
    expect(loadLedger(ADDR).degradedAt).toBe(3_000)
  })
})

describe('the full conjunction — when a UTXO finally becomes classifiable', () => {
  // Both halves of the guard together, as reconciliation will compose them. The epoch half
  // (journalCovers) compares timestamps; the ledger half (isPreEpoch) compares set membership. A
  // timestamp can be fooled by an app that was closed or a truncated scan — both make an old UTXO
  // look new — and the set cannot. Each test breaks exactly one condition.

  const NEW = 'utxo_0101_new'

  function setup() {
    // Coverage completes at 5_000, the baseline freezes what was already owned, and one genuinely
    // new UTXO turns up afterwards.
    captureBaseline(ADDR, complete([A, B]), 5_000)
    recordCompleteScan(ADDR, complete([A, B, NEW]), 6_000)
    return {
      ledger: loadLedger(ADDR),
      epoch: {
        startedAt: 1_000,
        degradedAt: null,
        covers: [...OUTPUT_CREATING_ACTIONS],
        coverageCompleteAt: 5_000,
      } as JournalEpoch,
    }
  }

  const classifiable = (ledger: ReturnType<typeof loadLedger>, epoch: JournalEpoch, id: string) =>
    !isPreEpoch(ledger, id) && journalCovers(epoch, firstSeenAt(ledger, id) ?? 0)

  it('classifies a UTXO that is new AND post-coverage AND fully covered AND healthy', () => {
    const { ledger, epoch } = setup()
    expect(classifiable(ledger, epoch, NEW)).toBe(true)
  })

  it('refuses one that was already owned when coverage completed', () => {
    const { ledger, epoch } = setup()
    expect(classifiable(ledger, epoch, A)).toBe(false)
    expect(classifiable(ledger, epoch, B)).toBe(false)
  })

  it('refuses everything while coverage is incomplete', () => {
    const { ledger, epoch } = setup()
    expect(classifiable(ledger, { ...epoch, covers: [], coverageCompleteAt: null }, NEW)).toBe(false)
  })

  it('refuses everything once the journal is degraded', () => {
    const { ledger, epoch } = setup()
    expect(classifiable(ledger, { ...epoch, degradedAt: 7_000 }, NEW)).toBe(false)
  })

  it('refuses everything while no baseline has been taken', () => {
    // The state every wallet is in until stage D runs: nothing is known to be new.
    recordCompleteScan(OTHER, complete([NEW]), 6_000)
    const ledger = loadLedger(OTHER)
    const epoch: JournalEpoch = {
      startedAt: 1_000, degradedAt: null,
      covers: [...OUTPUT_CREATING_ACTIONS], coverageCompleteAt: 5_000,
    }
    expect(ledger.baseline).toBeNull()
    expect(classifiable(ledger, epoch, NEW)).toBe(false)
  })
})
