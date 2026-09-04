// addressSentStore at rest (stage 6) — the peers I have handed my Tari address to.
//
// First spec file for this store — it had none before encryption reached it. Same surface as the
// stage 4 specs (the envelope, migrate-on-read, the never-clobber guard), because this IS a stage 4
// store; it was filed with the inert id→timestamp maps and only the shape matched. The guards
// themselves are pinned once in storeIo.test.ts; these check that THIS store is wired to them.

import { beforeEach, describe, expect, it } from 'vitest'
import { clearAddressSent, loadAddressSent, markAddressSent } from './addressSentStore'
import { clearStoreKey, setStoreKey } from '../crypto/sessionKey'


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

const ME = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const OTHER_PEER = 'c'.repeat(64)
const STORE_KEY = new Uint8Array(32).fill(42)
const sealedOnDisk = () => JSON.parse(localStorage.getItem(SKEY)!).v === 2

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

const SKEY = 'caravel.addrsent.v1.' + ME


describe('encryption at rest', () => {
  it('writes ciphertext — the peer pubkeys ARE the social graph', () => {
    // The whole reason this store moved out of the metadata tier: the KEYS are the sensitive part
    // here, not the values. A timestamp reveals nothing; a list of counterparties reveals everything
    // contactStore was sealed to protect.
    markAddressSent(ME, {}, PEER)
    const stored = localStorage.getItem(SKEY)!
    expect(stored).not.toContain(PEER)
    expect(sealedOnDisk()).toBe(true)
  })

  it('round-trips a delivery', () => {
    markAddressSent(ME, {}, PEER)
    expect(typeof loadAddressSent(ME)[PEER]).toBe('number')
  })

  it('seals the result of a clear rather than dropping back to plaintext', () => {
    // The decline/delete path. It must not be the one write that leaves the remaining peers bare.
    const map = markAddressSent(ME, markAddressSent(ME, {}, PEER), OTHER_PEER)
    clearAddressSent(ME, map, PEER)
    expect(sealedOnDisk()).toBe(true)
    expect(Object.keys(loadAddressSent(ME))).toEqual([OTHER_PEER])
  })

  it('does not write at all when nothing changed', () => {
    // Both mutations short-circuit — a re-mark of a known peer and a clear of an absent one. Neither
    // should mint a fresh nonce for an identical map.
    const map = markAddressSent(ME, {}, PEER)
    const after = localStorage.getItem(SKEY)!
    expect(markAddressSent(ME, map, PEER)).toBe(map)
    expect(clearAddressSent(ME, map, OTHER_PEER)).toBe(map)
    expect(localStorage.getItem(SKEY)).toBe(after)
  })
})

describe('migration', () => {
  it('reads a plaintext store and seals it on the first load', () => {
    // Reached on the ordinary path: ChatApp loads this on mount, so no forced startup read is
    // needed the way paymentResolutionStore needed one.
    localStorage.setItem(SKEY, JSON.stringify({ [PEER]: 1_700_000_000_000 }))
    expect(loadAddressSent(ME)[PEER]).toBe(1_700_000_000_000)
    expect(sealedOnDisk()).toBe(true)
  })

  it('does not rewrite an already-sealed store', () => {
    markAddressSent(ME, {}, PEER)
    const after = localStorage.getItem(SKEY)!
    loadAddressSent(ME); loadAddressSent(ME)
    expect(localStorage.getItem(SKEY)).toBe(after)
  })
})

describe('never clobber', () => {
  it('will not overwrite a store it could not read', () => {
    markAddressSent(ME, {}, PEER)
    const original = localStorage.getItem(SKEY)!
    // A re-minted salt derives a different key. The React mirror this store is called with was
    // seeded at mount from a load that now returns {}, so the write would have been the whole map.
    setStoreKey(new Uint8Array(32).fill(7))
    markAddressSent(ME, {}, OTHER_PEER)
    expect(localStorage.getItem(SKEY)).toBe(original)
    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadAddressSent(ME)[PEER]).toBeTypeOf('number')
  })

  it('will not let a clear destroy a store it could not read either', () => {
    const map = markAddressSent(ME, {}, PEER)
    const original = localStorage.getItem(SKEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    clearAddressSent(ME, map, PEER)
    expect(localStorage.getItem(SKEY)).toBe(original)
  })

  it('will not write with no store key', () => {
    clearStoreKey()
    markAddressSent(ME, {}, PEER)
    expect(localStorage.getItem(SKEY)).toBeNull()
  })

  it('reads as empty with no store key, rather than as a plaintext fallback', () => {
    markAddressSent(ME, {}, PEER)
    clearStoreKey()
    expect(loadAddressSent(ME)).toEqual({})
  })
})
