// Lifecycle tests for the store key (encryption-at-rest, stage 1).
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
  clearStoreKey, deriveStoreKey, ensureKeyParams, getStoreKey, hasStoreKey,
  loadKeyParams, newKeyParams, saveKeyParams, setStoreKey, type StoreKeyParams,
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

describe('the parameters record', () => {
  it('reads back nothing when none has been written', () => {
    expect(loadKeyParams()).toBeNull()
  })

  it('mints AND PERSISTS on first use', () => {
    // The create/restore-then-unlock story: the record has to survive the call, not merely be
    // returned by it. Asserted against storage directly.
    const minted = ensureKeyParams()
    expect(localStorage.getItem(KEY)).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(minted)
  })

  it('reuses the same salt on every later call', () => {
    // "Created on first create/restore, reused on subsequent unlocks." If this ever regressed, every
    // unlock would derive a different key from the same password — which is the whole failure mode
    // stage 3 depends on this not having.
    const first = ensureKeyParams()
    const second = ensureKeyParams()
    expect(second.salt).toBe(first.salt)
    expect(second).toEqual(first)
  })

  it('mints a DIFFERENT salt each time one is explicitly requested', () => {
    // What create and restore call. Two wallets on one device must not share a parameter.
    expect(newKeyParams().salt).not.toBe(newKeyParams().salt)
  })

  it('round-trips its iterations, so an older work factor survives', () => {
    saveKeyParams(params({ iterations: 12_345 }))
    expect(loadKeyParams()!.iterations).toBe(12_345)
  })

  it('carries the current work factor on a fresh record', () => {
    expect(newKeyParams().iterations).toBe(600_000)
  })

  it('re-mints rather than throwing on a corrupt or unusable record', () => {
    // The OPPOSITE of loadStoredWallet, deliberately: these are regenerable parameters guarding
    // nothing yet, so an unreadable one costs a remint and no data. REVISIT at the stage that first
    // encrypts a store, where a re-minted salt means stores that no longer open.
    for (const bad of ['not json at all', '{"version":99}', '{"version":1}', '{"version":1,"salt":"x","iterations":0}']) {
      globalThis.localStorage = memoryStorage()
      localStorage.setItem(KEY, bad)
      expect(loadKeyParams()).toBeNull()
      expect(() => ensureKeyParams()).not.toThrow()
    }
  })
})

describe('derivation', () => {
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

  it('GIVES A DIFFERENT KEY FOR A DIFFERENT SALT — the independent-salt property', async () => {
    // This is the reason the store key does not reuse StoredWallet.salt. Same password, different
    // salt, unrelated key: the seed key and the store key cannot be derived from one another.
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

  it('derives at the shipped 600 000 iterations', async () => {
    // The one test that pays the real cost, so the figure the app actually uses is exercised rather
    // than only asserted as a constant.
    const key = await deriveStoreKey('pw', newKeyParams())
    expect(key.length).toBe(32)
  })
})
