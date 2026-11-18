// nicknameStore at rest (stage 4) — user-chosen labels, very often real names.
//
// First spec file for this store — it had none before encryption reached it. These cover the stage 4
// surface: the envelope, migrate-on-read, and the never-clobber guard. The guards themselves are
// pinned once in storeIo.test.ts; these check that THIS store is wired to them correctly.

import { beforeEach, describe, expect, it } from 'vitest'
import { loadNicknames, setNickname, MAX_NICKNAME_LEN } from './nicknameStore'
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

const SKEY = 'caravel.nicknames.v1.' + ME


describe('encryption at rest', () => {
  it('writes ciphertext — a nickname is usually a real name', () => {
    setNickname(ME, {}, PEER, 'Mum')
    const stored = localStorage.getItem(SKEY)!
    expect(stored).not.toContain('Mum')
    expect(stored).not.toContain(PEER)
    expect(sealedOnDisk()).toBe(true)
  })

  it('round-trips a name', () => {
    setNickname(ME, {}, PEER, 'Esmeralda')
    expect(loadNicknames(ME)[PEER]).toBe('Esmeralda')
  })

  it('still trims and caps through the envelope', () => {
    setNickname(ME, {}, PEER, '  ' + 'x'.repeat(MAX_NICKNAME_LEN + 20) + '  ')
    expect(loadNicknames(ME)[PEER]).toBe('x'.repeat(MAX_NICKNAME_LEN))
  })

  it('clearing a name seals the result rather than dropping to plaintext', () => {
    const map = setNickname(ME, {}, PEER, 'Mum')
    setNickname(ME, map, PEER, '')
    expect(sealedOnDisk()).toBe(true)
    expect(loadNicknames(ME)).toEqual({})
  })
})

describe('migration', () => {
  it('reads a plaintext store and seals it on the first load', () => {
    // The store that needed migrate-on-read most: it writes ONLY on a rename, so on a wallet where
    // the names were set months ago, lazy-on-write would have meant never.
    localStorage.setItem(SKEY, JSON.stringify({ [PEER]: 'Older Name' }))
    expect(loadNicknames(ME)[PEER]).toBe('Older Name')
    expect(sealedOnDisk()).toBe(true)
  })

  it('does not rewrite an already-sealed store', () => {
    setNickname(ME, {}, PEER, 'Mum')
    const after = localStorage.getItem(SKEY)!
    loadNicknames(ME); loadNicknames(ME)
    expect(localStorage.getItem(SKEY)).toBe(after)
  })
})

describe('never clobber', () => {
  it('will not overwrite a store it could not read', () => {
    setNickname(ME, {}, PEER, 'Mum')
    const original = localStorage.getItem(SKEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    setNickname(ME, {}, 'c'.repeat(64), 'Someone')
    expect(localStorage.getItem(SKEY)).toBe(original)
    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadNicknames(ME)[PEER]).toBe('Mum')
  })

  it('will not write with no store key', () => {
    clearStoreKey()
    setNickname(ME, {}, PEER, 'Mum')
    expect(localStorage.getItem(SKEY)).toBeNull()
  })
})

