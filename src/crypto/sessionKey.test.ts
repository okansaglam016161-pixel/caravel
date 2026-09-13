// Lifecycle tests for the store key.
//
// TWO HALVES, WITH DIFFERENT LIFESPANS. The session-state specs are permanent: holding one key for
// an unlocked session and dropping it on lock is what this module still does. The parameters and
// derivation specs are MIGRATION-ONLY and go in S3 with the code they cover — the live key is derived
// in derivation.ts from the wallet's seed and takes no password, and its specs live there.
//
// Hermetic and offline: Node exposes WebCrypto on globalThis.crypto, so the REAL PBKDF2 runs here
// rather than a shim — the same arrangement mediaCrypto.test.ts relies on.
//
// MOST DERIVATIONS RUN AT A LOW ITERATION COUNT, on purpose. The shipped work factor is 600 000,
// which is the point of it; running that in every assertion would add seconds to the suite to
// re-measure one constant. Because `iterations` is read from the RECORD rather than from the module
// constant, a test can write a cheap record and still exercise the identical code path — and one
// test below does pin the real figure. That the tests can do this at all is the from-the-record
// discipline paying for itself.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearStoreKey, deriveStoreKey, getStoreKey, hasStoreKey,
  loadKeyParams, setStoreKey, type StoreKeyParams,
} from './sessionKey'

// localStorage does not exist under Vitest's node environment. The same in-memory Storage
// messageStore.test.ts uses — one package, no jsdom, and it lets the tests assert what was actually
// WRITTEN rather than only what was returned.
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

const KEY = 'caravel.storekey.v1'

/** A cheap-to-derive record with a fixed salt, for the assertions that are about the KEY not the KDF. */
function params(over: Partial<StoreKeyParams> = {}): StoreKeyParams {
  return { version: 1, kdf: 'pbkdf2', iterations: 100, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', ...over }
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  clearStoreKey()
})

describe('session state — the lock/unlock contract', () => {
  it('has no key before anything sets one', () => {
    // "Absent before unlock." Nothing derives a key until a password has been supplied, so a
    // freshly loaded app — or a locked one — holds nothing.
    expect(getStoreKey()).toBeNull()
    expect(hasStoreKey()).toBe(false)
  })

  it('holds the key it was given', () => {
    const key = new Uint8Array(32).fill(7)
    setStoreKey(key)
    expect(hasStoreKey()).toBe(true)
    expect([...getStoreKey()!]).toEqual([...key])
  })

  it('has no key after clearing — the lock() path', () => {
    setStoreKey(new Uint8Array(32).fill(7))
    clearStoreKey()
    expect(getStoreKey()).toBeNull()
    expect(hasStoreKey()).toBe(false)
  })

  it('zeroes the buffer it was holding', () => {
    // Defence in depth, not erasure — see the note on clearStoreKey. What IS guaranteed is that the
    // array this module was handed no longer contains the key, which is what this pins.
    const key = new Uint8Array(32).fill(7)
    setStoreKey(key)
    clearStoreKey()
    expect([...key]).toEqual(new Array(32).fill(0))
  })

  it('clearing when there is nothing to clear is a no-op, not a throw', () => {
    // lock() may run without a preceding unlock — a failed unlock, or a lock on an already-locked
    // app. It must not throw there.
    expect(() => clearStoreKey()).not.toThrow()
    expect(getStoreKey()).toBeNull()
  })
})

// MIGRATION-ONLY (deleted in S3). Nothing writes this record any more, so what is left to cover is
// the READ — the one S3 depends on to re-derive the key a device's stores were sealed with before the
// change. The minting specs went with the minting code.
describe('the retired parameters record — read path only', () => {
  it('reads back nothing when none has been written', () => {
    expect(loadKeyParams()).toBeNull()
  })

  it('round-trips a record written by an older build, iterations and all', () => {
    // Written directly rather than through a helper, because the writer is gone — which is exactly
    // the situation S3 meets on a real device.
    localStorage.setItem(KEY, JSON.stringify(params({ iterations: 12_345 })))
    expect(loadKeyParams()!.iterations).toBe(12_345)
    expect(loadKeyParams()!.salt).toBe('AAAAAAAAAAAAAAAAAAAAAA==')
  })

  it('returns null rather than throwing on a corrupt or unusable record', () => {
    // Still the OPPOSITE of loadStoredWallet, and now harmless: there is nothing left to re-mint.
    // A record this build cannot read simply means S3 has nothing to convert from.
    for (const bad of ['not json at all', '{"version":99}', '{"version":1}', '{"version":1,"salt":"x","iterations":0}']) {
      globalThis.localStorage = memoryStorage()
      localStorage.setItem(KEY, bad)
      expect(loadKeyParams()).toBeNull()
    }
  })
})

// MIGRATION-ONLY (deleted in S3): the OLD password-based derivation, kept so S3 can open what it
// sealed. The live derivation is storeKeyFromSeedMaterial in derivation.ts — no password, no salt,
// and its own golden vectors.
describe('the retired derivation', () => {
  it('is deterministic for the same password and the same record', async () => {
    // The property every later stage rests on: unlock twice, decrypt the same stores.
    const p = params()
    const a = await deriveStoreKey('correct horse battery staple', p)
    const b = await deriveStoreKey('correct horse battery staple', p)
    expect([...a]).toEqual([...b])
  })

  it('produces 32 bytes', async () => {
    expect((await deriveStoreKey('pw', params())).length).toBe(32)
  })

  it('gives a different key for a different salt', async () => {
    // The property the old design rested on — and the one that sank it. Same password, different
    // salt, unrelated key: which is precisely why re-minting that salt on restore stranded every
    // store sealed under the previous one.
    const a = await deriveStoreKey('same password', params({ salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }))
    const b = await deriveStoreKey('same password', params({ salt: 'BBBBBBBBBBBBBBBBBBBBBB==' }))
    expect([...a]).not.toEqual([...b])
  })

  it('gives a different key for a different password', async () => {
    const p = params()
    const a = await deriveStoreKey('password one', p)
    const b = await deriveStoreKey('password two', p)
    expect([...a]).not.toEqual([...b])
  })

  it('gives a different key when only the work factor differs', async () => {
    // Why iterations belongs IN the record: change it without recording it and every stored value
    // becomes unreadable.
    const a = await deriveStoreKey('pw', params({ iterations: 100 }))
    const b = await deriveStoreKey('pw', params({ iterations: 200 }))
    expect([...a]).not.toEqual([...b])
  })

  it('derives at the 600 000 iterations old records carry', async () => {
    // The one test that pays the real cost, so the figure those records were written at is exercised
    // rather than only asserted as a constant. S3 pays it once per migrating device.
    const key = await deriveStoreKey('pw', params({ iterations: 600_000 }))
    expect(key.length).toBe(32)
  })
})
