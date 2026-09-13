// Lifecycle tests for the store key: holding one key for the length of an unlocked session, and
// dropping it on lock. That is all this module does now.
//
// WHERE THE REST WENT. The derivation moved to derivation.ts, where the key comes from the wallet's
// own seed and has its own frozen vectors. The retired password-and-salt scheme — its record reader,
// its PBKDF2, and their specs — moved to storeKeyMigration.ts, which exists only until every device
// has been converted.

import { beforeEach, describe, expect, it } from 'vitest'
import { clearStoreKey, getStoreKey, hasStoreKey, setStoreKey } from './sessionKey'

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
