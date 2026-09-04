// The tier-2 sealed load/save helper (stage 4).
//
// This is where the guards that every tier-2 store depends on are actually pinned. Centralising
// them was the argument for the helper existing at all, so if these pass, the five stores inherit
// correct never-clobber / never-rewrite-sealed / no-plaintext-fallback behaviour by construction
// rather than by five separate copies happening to be right.

import { beforeEach, describe, expect, it } from 'vitest'
import { asRecord, loadStore, readStore, writeStore, type Parse } from './storeIo'
import { clearStoreKey, setStoreKey } from './sessionKey'
import { seal } from './storeCrypto'

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

const K = 'caravel.test.v1.abc'
const STORE_KEY = new Uint8Array(32).fill(42)
const WRONG_KEY = new Uint8Array(32).fill(7)

type Map1 = Record<string, string>
const parseMap: Parse<Map1> = d => asRecord(d) as Map1 | null
const empty = () => ({} as Map1)

const sealedOnDisk = () => JSON.parse(localStorage.getItem(K)!).v === 2

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

describe('round-trip', () => {
  it('seals on write and reads back the same value', () => {
    expect(writeStore(K, JSON.stringify({ a: '1' }), parseMap)).toBe(true)
    expect(sealedOnDisk()).toBe(true)
    expect(loadStore(K, parseMap, empty)).toEqual({ a: '1' })
  })

  it('writes ciphertext, not readable JSON', () => {
    writeStore(K, JSON.stringify({ peerhex: 'otl_esm_1secret' }), parseMap)
    const stored = localStorage.getItem(K)!
    expect(stored).not.toContain('otl_esm_1secret')
    expect(stored).not.toContain('peerhex')
  })

  it('reads an absent record as the empty value', () => {
    expect(loadStore(K, parseMap, empty)).toEqual({})
    expect(readStore(K, parseMap)).toEqual({ status: 'empty' })
  })

  it('hands every caller its OWN empty value', () => {
    // `empty` is a factory precisely so two callers cannot share one mutable object.
    const a = loadStore(K, parseMap, empty)
    const b = loadStore(K, parseMap, empty)
    expect(a).not.toBe(b)
  })
})

describe('invariant 1 — never clobber a record we could not read', () => {
  it('refuses to write over a WRONG-KEY record, and leaves it byte-identical', () => {
    writeStore(K, JSON.stringify({ keep: 'the history that must survive' }), parseMap)
    const original = localStorage.getItem(K)!

    setStoreKey(WRONG_KEY)
    expect(loadStore(K, parseMap, empty)).toEqual({})            // reads as empty...
    expect(writeStore(K, JSON.stringify({ new: 'x' }), parseMap)).toBe(false)
    expect(localStorage.getItem(K)).toBe(original)               // ...and was not replaced

    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadStore(K, parseMap, empty)).toEqual({ keep: 'the history that must survive' })
  })

  it('refuses over a corrupt record', () => {
    localStorage.setItem(K, '{not json')
    expect(writeStore(K, JSON.stringify({ a: '1' }), parseMap)).toBe(false)
    expect(localStorage.getItem(K)).toBe('{not json')
  })

  it('refuses over a record that decrypts but does not fit the store SHAPE', () => {
    // The reason writeStore takes the same Parse the read uses: "I could not make sense of this" has
    // to mean the same thing on both sides, or a shape mismatch becomes a licence to overwrite.
    localStorage.setItem(K, seal(STORE_KEY, JSON.stringify(['not', 'a', 'map'])))
    expect(readStore(K, parseMap)).toEqual({ status: 'unreadable' })
    expect(writeStore(K, JSON.stringify({ a: '1' }), parseMap)).toBe(false)
  })

  it('still writes over an EMPTY record — absence is not unreadable', () => {
    expect(localStorage.getItem(K)).toBeNull()
    expect(writeStore(K, JSON.stringify({ a: '1' }), parseMap)).toBe(true)
  })
})

describe('invariant 2 — never rewrite a record that is already sealed', () => {
  it('leaves a sealed record byte-identical across repeated loads', () => {
    // Without the legacy check, migrate-on-read would re-encrypt on every load: a fresh nonce and a
    // fresh write per render.
    writeStore(K, JSON.stringify({ a: '1' }), parseMap)
    const afterWrite = localStorage.getItem(K)!
    loadStore(K, parseMap, empty)
    loadStore(K, parseMap, empty)
    loadStore(K, parseMap, empty)
    expect(localStorage.getItem(K)).toBe(afterWrite)
  })
})

describe('invariant 3 — never fall back to plaintext', () => {
  it('refuses to write with no store key', () => {
    clearStoreKey()
    expect(writeStore(K, JSON.stringify({ a: '1' }), parseMap)).toBe(false)
    expect(localStorage.getItem(K)).toBeNull()
  })

  it('reads a sealed record as empty with no key', () => {
    writeStore(K, JSON.stringify({ a: '1' }), parseMap)
    clearStoreKey()
    expect(loadStore(K, parseMap, empty)).toEqual({})
  })
})

describe('migrate on read', () => {
  const legacy = () => localStorage.setItem(K, JSON.stringify({ a: '1', b: '2' }))

  it('re-persists a plaintext record SEALED on the first load', () => {
    legacy()
    expect(sealedOnDisk()).toBe(false)
    loadStore(K, parseMap, empty)
    expect(sealedOnDisk()).toBe(true)
  })

  it('loses nothing doing it', () => {
    legacy()
    loadStore(K, parseMap, empty)
    expect(loadStore(K, parseMap, empty)).toEqual({ a: '1', b: '2' })
  })

  it('persists the PARSED value, so a store-level migration becomes permanent', () => {
    // What makes tariAddressStore's legacy bare strings and groupStore's missing `state` stop being
    // re-derived on every load. The parser here upper-cases; the sealed bytes must carry that.
    const upper: Parse<Map1> = d => {
      const r = asRecord(d)
      if (r === null) return null
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v).toUpperCase()]))
    }
    legacy()
    loadStore(K, upper, empty)
    // Read back with a parser that does NOT transform — the transformation is on disk now.
    expect(loadStore(K, parseMap, empty)).toEqual({ a: '1', b: '2' })

    localStorage.setItem(K, JSON.stringify({ a: 'x' }))
    loadStore(K, upper, empty)
    expect(loadStore(K, parseMap, empty)).toEqual({ a: 'X' })
  })

  it('does not migrate a record it could not open', () => {
    writeStore(K, JSON.stringify({ a: '1' }), parseMap)
    const original = localStorage.getItem(K)!
    setStoreKey(WRONG_KEY)
    loadStore(K, parseMap, empty)
    expect(localStorage.getItem(K)).toBe(original)
  })

  it('leaves a plaintext record alone when there is no key to seal it with', () => {
    // A legacy record still READS without a key — nothing to decrypt — but cannot be sealed, so it
    // waits for an unlocked session rather than being lost or rewritten.
    legacy()
    clearStoreKey()
    expect(loadStore(K, parseMap, empty)).toEqual({ a: '1', b: '2' })
    expect(sealedOnDisk()).toBe(false)
  })
})

describe('asRecord', () => {
  it('accepts a plain object', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
  })

  it('rejects arrays, null and primitives — the shapes a map store must not accept', () => {
    for (const bad of [[], [1, 2], null, 'str', 42, true]) {
      expect(asRecord(bad)).toBeNull()
    }
  })
})
