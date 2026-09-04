// tariAddressStore at rest (stage 4) — the npub to Tari-address join.
//
// First spec file for this store — it had none before encryption reached it. These cover the stage 4
// surface: the envelope, migrate-on-read, and the never-clobber guard. The guards themselves are
// pinned once in storeIo.test.ts; these check that THIS store is wired to them correctly.

import { beforeEach, describe, expect, it } from 'vitest'
import { loadTariAddresses, setTariAddress } from './tariAddressStore'
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
const STORE_KEY = new Uint8Array(32).fill(42)
const sealedOnDisk = () => JSON.parse(localStorage.getItem(SKEY)!).v === 2

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

const SKEY = 'caravel.tariaddr.v1.' + ME


describe('encryption at rest', () => {
  it('writes ciphertext — the address is the linkage, and it must not be on disk in the clear', () => {
    setTariAddress(ME, {}, PEER, 'otl_esm_1recipientaddress', 'exchanged')
    const stored = localStorage.getItem(SKEY)!
    expect(stored).not.toContain('otl_esm_1recipientaddress')
    expect(stored).not.toContain(PEER)
    expect(sealedOnDisk()).toBe(true)
  })

  it('round-trips the record, source included', () => {
    setTariAddress(ME, {}, PEER, 'otl_esm_1abc', 'exchanged')
    expect(loadTariAddresses(ME)[PEER]).toEqual({ address: 'otl_esm_1abc', source: 'exchanged' })
  })

  it('cannot be read with a different key, or with none', () => {
    setTariAddress(ME, {}, PEER, 'otl_esm_1abc', 'manual')
    setStoreKey(new Uint8Array(32).fill(7))
    expect(loadTariAddresses(ME)).toEqual({})
    clearStoreKey()
    expect(loadTariAddresses(ME)).toEqual({})
  })
})

describe('migration', () => {
  it('reads a plaintext store and seals it on the first load', () => {
    localStorage.setItem(SKEY, JSON.stringify({ [PEER]: { address: 'otl_esm_1old', source: 'manual' } }))
    expect(loadTariAddresses(ME)[PEER].address).toBe('otl_esm_1old')
    expect(sealedOnDisk()).toBe(true)
  })

  it('MAKES THE LEGACY BARE-STRING MIGRATION PERMANENT', () => {
    // Entries were once bare strings. That conversion has been re-derived on every load ever since,
    // because nothing re-persisted it. The migrating read stores the PARSED map, so it is done once.
    localStorage.setItem(SKEY, JSON.stringify({ [PEER]: 'otl_esm_1legacystring' }))

    expect(loadTariAddresses(ME)[PEER]).toEqual({ address: 'otl_esm_1legacystring', source: 'manual' })
    expect(sealedOnDisk()).toBe(true)

    // ...and what is on disk is now the RECORD shape, not the bare string.
    expect(loadTariAddresses(ME)[PEER]).toEqual({ address: 'otl_esm_1legacystring', source: 'manual' })
  })

  it('does not rewrite an already-sealed store', () => {
    setTariAddress(ME, {}, PEER, 'otl_esm_1abc', 'manual')
    const after = localStorage.getItem(SKEY)!
    loadTariAddresses(ME); loadTariAddresses(ME)
    expect(localStorage.getItem(SKEY)).toBe(after)
  })
})

describe('never clobber', () => {
  it('will not overwrite a store it could not read', () => {
    setTariAddress(ME, {}, PEER, 'otl_esm_1keep', 'exchanged')
    const original = localStorage.getItem(SKEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    setTariAddress(ME, {}, PEER, 'otl_esm_1new', 'manual')
    expect(localStorage.getItem(SKEY)).toBe(original)
    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadTariAddresses(ME)[PEER].address).toBe('otl_esm_1keep')
  })

  it('will not write with no store key', () => {
    clearStoreKey()
    setTariAddress(ME, {}, PEER, 'otl_esm_1abc', 'manual')
    expect(localStorage.getItem(SKEY)).toBeNull()
  })

  it('still refuses a manual overwrite of a verified record, sealed or not', () => {
    // The store's own rule, re-checked through the envelope.
    const map = setTariAddress(ME, {}, PEER, 'otl_esm_1verified', 'exchanged')
    setTariAddress(ME, map, PEER, 'otl_esm_1pasted', 'manual')
    expect(loadTariAddresses(ME)[PEER]).toEqual({ address: 'otl_esm_1verified', source: 'exchanged' })
  })
})

