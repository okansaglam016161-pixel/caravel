// paymentResolutionStore at rest (stage 4) — resolved confidential receive amounts.
//
// First spec file for this store — it had none before encryption reached it. These cover the stage 4
// surface: the envelope, migrate-on-read, and the never-clobber guard. The guards themselves are
// pinned once in storeIo.test.ts; these check that THIS store is wired to them correctly.

import { beforeEach, describe, expect, it } from 'vitest'
import { cacheResolvedAmount, loadResolvedAmounts, migrateResolvedAmounts, removeResolvedAmounts } from './paymentResolutionStore'
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
const STORE_KEY = new Uint8Array(32).fill(42)
const sealedOnDisk = () => JSON.parse(localStorage.getItem(SKEY)!).v === 2

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

const SKEY = 'caravel.payresolved.v1.' + ME


const UTXO = 'utxo_0101_abcdef'

describe('encryption at rest', () => {
  it('writes ciphertext — the amount is what the chain hides', () => {
    cacheResolvedAmount(ME, UTXO, '1500000')
    const stored = localStorage.getItem(SKEY)!
    expect(stored).not.toContain('1500000')
    expect(stored).not.toContain(UTXO)
    expect(sealedOnDisk()).toBe(true)
  })

  it('round-trips an amount', () => {
    cacheResolvedAmount(ME, UTXO, '1500000')
    expect(loadResolvedAmounts(ME)[UTXO]).toBe('1500000')
  })

  it('routes BOTH mutations through the sealed save', () => {
    // They used to call localStorage.setItem directly, which gave the guard two places to be
    // forgotten. Removal must seal too, not drop back to plaintext.
    cacheResolvedAmount(ME, UTXO, '1500000')
    cacheResolvedAmount(ME, 'utxo_0101_other', '99')
    removeResolvedAmounts(ME, [UTXO])
    expect(sealedOnDisk()).toBe(true)
    expect(loadResolvedAmounts(ME)).toEqual({ 'utxo_0101_other': '99' })
  })
})

describe('migration', () => {
  it('reads a plaintext cache and seals it on the first load', () => {
    localStorage.setItem(SKEY, JSON.stringify({ [UTXO]: '250000' }))
    expect(loadResolvedAmounts(ME)[UTXO]).toBe('250000')
    expect(sealedOnDisk()).toBe(true)
  })

  it('seals a plaintext cache on the startup read, with no card rendered', () => {
    // This store's only other reader is the received-payment card, so unlike the four stores loaded
    // beside it, nothing here opens the record on a wallet that renders no such card — which is why
    // WalletContext calls this at unlock. Without that call the amounts below stay in the clear.
    localStorage.setItem(SKEY, JSON.stringify({ [UTXO]: '250000' }))
    migrateResolvedAmounts(ME)
    expect(sealedOnDisk()).toBe(true)
    expect(loadResolvedAmounts(ME)[UTXO]).toBe('250000')
  })

  it('does not rewrite an already-sealed cache', () => {
    cacheResolvedAmount(ME, UTXO, '1')
    const after = localStorage.getItem(SKEY)!
    loadResolvedAmounts(ME); loadResolvedAmounts(ME)
    expect(localStorage.getItem(SKEY)).toBe(after)
  })
})

describe('never clobber', () => {
  it('will not replace a whole cache it could not read with one entry', () => {
    // The shape that makes this store's clobber path direct: neither mutation takes a `current`, so
    // under a wrong key the read returns {} and the write would have been the entire new cache.
    cacheResolvedAmount(ME, UTXO, '1500000')
    const original = localStorage.getItem(SKEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    cacheResolvedAmount(ME, 'utxo_0101_new', '5')
    expect(localStorage.getItem(SKEY)).toBe(original)
    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadResolvedAmounts(ME)[UTXO]).toBe('1500000')
  })

  it('will not write with no store key', () => {
    clearStoreKey()
    cacheResolvedAmount(ME, UTXO, '1')
    expect(localStorage.getItem(SKEY)).toBeNull()
  })
})

