// The first-seen ledger.
//
// Everything here protects one direction of one error. A UTXO that looks NEWER than it is passes a
// guard it should have failed, and gets classified as a payment from a stranger when it is in fact
// the user's own change. Every rule below — first-write-wins, refusing truncated scans, a baseline
// that defaults to "pre-epoch" — exists to stop a date drifting forward.

import { beforeEach, describe, expect, it } from 'vitest'
import { clearStoreKey, setStoreKey } from './sessionKey'
import {
  __resetLedgerSessionForTests,
  captureBaseline, firstSeenAt, isPreEpoch, loadLedger, recordCompleteScan,
} from './utxoLedger'
import { OUTPUT_CREATING_ACTIONS, draftToEntry, journalCovers, type JournalEpoch } from './journal'
import { reconcile } from './reconcile'

const LEDGER_STORE_KEY = new Uint8Array(32).fill(42)

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

// The ledger is sealed at rest from stage 3 on, so these specs run the ENCRYPTED path.
beforeEach(() => {
  failWrites = false
  globalThis.localStorage = memoryStorage()
  __resetLedgerSessionForTests()
  setStoreKey(Uint8Array.from(LEDGER_STORE_KEY))
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


// ── At rest (stage 3) ─────────────────────────────────────────────────────────

describe('ledger: encryption at rest', () => {
  const LKEY = 'caravel.utxoseen.v1.' + ADDR

  it('writes ciphertext, not readable JSON', () => {
    recordCompleteScan(ADDR, complete([A, B]), 1_000)
    const stored = localStorage.getItem(LKEY)!
    expect(stored).not.toContain(A)
    expect(stored).not.toContain('firstSeen')
    expect(JSON.parse(stored).v).toBe(2)
  })

  it('round-trips firstSeen and the baseline', () => {
    recordCompleteScan(ADDR, complete([A, B]), 1_000)
    captureBaseline(ADDR, complete([A, B]), 2_000)
    const ledger = loadLedger(ADDR)
    expect(firstSeenAt(ledger, A)).toBe(1_000)
    expect(ledger.baseline).toEqual(expect.arrayContaining([A, B]))
  })

  it('reads a plaintext ledger written before encryption existed, then seals it', () => {
    localStorage.setItem(LKEY, JSON.stringify({
      firstSeen: { [A]: 500 }, baseline: [A], baselineAt: 600, degradedAt: null,
    }))
    expect(firstSeenAt(loadLedger(ADDR), A)).toBe(500)

    recordCompleteScan(ADDR, complete([A, B]), 1_000)

    expect(JSON.parse(localStorage.getItem(LKEY)!).v).toBe(2)
    const ledger = loadLedger(ADDR)
    expect(firstSeenAt(ledger, A)).toBe(500)     // first-write-wins survived migration
    expect(firstSeenAt(ledger, B)).toBe(1_000)
    expect(ledger.baseline).toEqual([A])
  })
})

describe('ledger: FAILS CLOSED — an unreadable ledger classifies nothing', () => {
  it('reads as EMPTY under a wrong key, so every utxo is pre-epoch', () => {
    // The property that makes encrypting this store safe for reconciliation: a key failure must
    // produce NO receives, never wrong ones. isPreEpoch answers true for everything when there is
    // no baseline, and reconcile suppresses on exactly that.
    recordCompleteScan(ADDR, complete([A, B]), 1_000)
    captureBaseline(ADDR, complete([A]), 2_000)
    expect(isPreEpoch(loadLedger(ADDR), B)).toBe(false)   // classifiable with the right key

    setStoreKey(new Uint8Array(32).fill(7))
    const blind = loadLedger(ADDR)
    expect(blind.baseline).toBeNull()
    expect(blind.firstSeen).toEqual({})
    expect(isPreEpoch(blind, B)).toBe(true)               // suppressed, not fabricated
    expect(firstSeenAt(blind, B)).toBeNull()
  })

  it('reads as EMPTY with no key at all', () => {
    recordCompleteScan(ADDR, complete([A]), 1_000)
    clearStoreKey()
    expect(loadLedger(ADDR)).toEqual({ firstSeen: {}, baseline: null, baselineAt: null, degradedAt: null })
  })
})

describe('ledger: refusing to write', () => {
  const LKEY = 'caravel.utxoseen.v1.' + ADDR

  it('will not write with no store key', () => {
    clearStoreKey()
    recordCompleteScan(ADDR, complete([A]), 1_000)
    expect(localStorage.getItem(LKEY)).toBeNull()
  })

  it('NEVER OVERWRITES A LEDGER IT COULD NOT READ — including via markDegraded', () => {
    // The worst case this guard exists for: markDegraded loads the ledger and writes it back with a
    // stamp, so under a wrong key it would persist EMPTY over firstSeen and baseline — destroying
    // the reconciliation data in the very act of recording that something went wrong.
    recordCompleteScan(ADDR, complete([A, B]), 1_000)
    captureBaseline(ADDR, complete([A]), 2_000)
    const original = localStorage.getItem(LKEY)!

    setStoreKey(new Uint8Array(32).fill(7))
    recordCompleteScan(ADDR, complete([A, B]), 5_000)     // write is refused
    expect(localStorage.getItem(LKEY)).toBe(original)

    setStoreKey(Uint8Array.from(LEDGER_STORE_KEY))
    const ledger = loadLedger(ADDR)
    expect(firstSeenAt(ledger, A)).toBe(1_000)            // untouched
    expect(ledger.baseline).toEqual([A])
  })
})


// ── Reconciliation, end to end over the ENCRYPTED store ───────────────────────
//
// The ledger tests above cover the store; reconcile.test.ts covers the pure classifier over a
// hand-built ledger value. Neither on its own proves the pair still works once the store is sealed,
// which is the thing to be sure of before shipping this. These two run the real classifier over a
// ledger that came back out of localStorage through XChaCha20-Poly1305.

describe('reconciliation over an encrypted ledger', () => {
  const RECEIVED = 'utxo_0101_incoming'
  const CHANGE = 'utxo_0101_ourchange'
  const COVERAGE_AT = 5_000

  const scanned = (id: string) => ({ id, commitment: id.slice(-6), amount: 1_000_000n, payRef: '', message: '' })

  const epoch: JournalEpoch = {
    startedAt: 1_000,
    degradedAt: null,
    covers: [...OUTPUT_CREATING_ACTIONS],
    coverageCompleteAt: COVERAGE_AT,
  }

  /** A send whose own change output is journalled, so reconcile can subtract it. */
  const sendEntry = {
    ...draftToEntry({
      kind: 'send', amountMicrotari: 1n, feeMicrotari: null,
      from: 'private', to: 'external', counterparty: null, note: null,
      source: 'local-journal', selfOutputIds: [CHANGE],
    }, 1_500),
    outcome: 'committed' as const,
  }

  function seedEncryptedLedger() {
    // Baseline captured at coverage; both utxos first seen AFTER it, so the incoming one is
    // genuinely classifiable and the change one is subtracted by the journal.
    captureBaseline(ADDR, complete([]), COVERAGE_AT)
    recordCompleteScan(ADDR, complete([RECEIVED, CHANGE]), 6_000)
    // ...and it really is sealed on disk.
    expect(JSON.parse(localStorage.getItem('caravel.utxoseen.v1.' + ADDR)!).v).toBe(2)
  }

  it('STILL CLASSIFIES A RECEIVE after the ledger is encrypted', () => {
    seedEncryptedLedger()
    const result = reconcile({
      owned: [scanned(RECEIVED), scanned(CHANGE)],
      journal: [sendEntry],
      ledger: loadLedger(ADDR),
      epoch,
    })
    expect(result.receives.map(r => r.utxoId)).toEqual([RECEIVED])
    expect(result.receives[0].firstSeenAt).toBe(6_000)
  })

  it('claims NOTHING when the ledger cannot be opened — no fabricated receives', () => {
    seedEncryptedLedger()
    setStoreKey(new Uint8Array(32).fill(7))
    const result = reconcile({
      owned: [scanned(RECEIVED), scanned(CHANGE)],
      journal: [sendEntry],
      ledger: loadLedger(ADDR),
      epoch,
    })
    expect(result.receives).toEqual([])
    expect(result.suppressed.map(s => s.reason)).toEqual(['pre-epoch'])
  })
})


// ── Migrate on read ───────────────────────────────────────────────────────────

describe('ledger: migrates on READ, not just on write', () => {
  const LKEY = 'caravel.utxoseen.v1.' + ADDR

  function seedPlaintext() {
    localStorage.setItem(LKEY, JSON.stringify({
      firstSeen: { [A]: 500 }, baseline: [A], baselineAt: 600, degradedAt: null,
    }))
  }
  const sealed = () => JSON.parse(localStorage.getItem(LKEY)!).v === 2

  it('re-persists a plaintext ledger SEALED on the first load', () => {
    // The gap this closes: recordCompleteScan returns before save() when a scan brings no new UTXO,
    // and captureBaseline is skipped once a baseline exists — so a wallet that is not transacting
    // never writes, and the ledger would stay plaintext indefinitely.
    seedPlaintext()
    expect(sealed()).toBe(false)

    loadLedger(ADDR)

    expect(sealed()).toBe(true)
  })

  it('loses nothing in the process', () => {
    seedPlaintext()
    loadLedger(ADDR)
    const ledger = loadLedger(ADDR)
    expect(firstSeenAt(ledger, A)).toBe(500)
    expect(ledger.baseline).toEqual([A])
    expect(ledger.baselineAt).toBe(600)
  })

  it('does NOT rewrite a record that is already sealed', () => {
    // Without the legacy check every single load would re-encrypt the store — a fresh nonce and a
    // fresh write on every render that reads it.
    recordCompleteScan(ADDR, complete([A]), 1_000)
    const afterWrite = localStorage.getItem(LKEY)!
    loadLedger(ADDR)
    loadLedger(ADDR)
    expect(localStorage.getItem(LKEY)).toBe(afterWrite)
  })

  it('does NOT write over a record it could not open', () => {
    recordCompleteScan(ADDR, complete([A]), 1_000)
    const original = localStorage.getItem(LKEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    expect(loadLedger(ADDR).baseline).toBeNull()      // unreadable → reads EMPTY
    expect(localStorage.getItem(LKEY)).toBe(original) // ...and is left exactly as it was
  })

  it('leaves a plaintext ledger alone when there is no key to seal it with', () => {
    // A legacy record still READS without a key — nothing to decrypt — but cannot be sealed, so it
    // waits for an unlocked session rather than being lost or rewritten.
    seedPlaintext()
    clearStoreKey()
    expect(firstSeenAt(loadLedger(ADDR), A)).toBe(500)
    expect(sealed()).toBe(false)
  })

  it('does not persist a SESSION-ONLY degradation as a side effect of reading', () => {
    // The migration writes `stored`, NOT the session-merged value returned to the caller. A
    // degradation known only to this session must not become a durable one just because somebody
    // read the ledger — that would turn a transient failure into a permanent stamp.
    seedPlaintext()

    // Provoke an in-session degradation: a write that fails takes the stamp but cannot persist it.
    failWrites = true
    recordCompleteScan(ADDR, complete([A, B]), 1_000)
    failWrites = false
    expect(sealed()).toBe(false)                       // nothing landed while writes were failing

    // The read migrates, and reports the session stamp to its caller.
    expect(loadLedger(ADDR).degradedAt).not.toBeNull()
    expect(sealed()).toBe(true)

    // But the bytes it wrote carry the STORED value. Drop the session record and the stamp is gone,
    // which it would not be had the merged value been persisted.
    __resetLedgerSessionForTests()
    expect(loadLedger(ADDR).degradedAt).toBeNull()
    expect(firstSeenAt(loadLedger(ADDR), A)).toBe(500)
  })
})
