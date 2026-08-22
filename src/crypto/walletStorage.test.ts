//   Storage-layer tests for the wallet record: the derivation marker, and what happens to a record
//   this build cannot safely open.
//
//   These cover the two ways a correct derivation can still end up opening the wrong wallet — a
//   marker that never reached disk alongside its ciphertext, and an unreadable record being
//   mistaken for "no wallet here".

import { beforeEach, describe, expect, it } from 'vitest'
import {
  decryptMnemonic,
  encryptMnemonic,
  hasStoredWallet,
  loadStoredWallet,
  markScheme,
  saveStoredWallet,
} from './walletCrypto'
import { resolveScheme } from './derivation'

// localStorage does not exist under Vitest's node environment. Same tiny in-memory Storage the
// messaging store specs use — keeps the dependency footprint at zero and lets us assert what was
// actually WRITTEN, which is the whole point here.
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

const KEY = 'caravel.wallet.v1'
const PASSWORD = 'correct horse battery staple'
const CIPHERSEED =
  'leopard shove teach odor aim ginger atom occur siren avoid hungry hidden cannon mistake electric material lawsuit manage gym slight where list soon hover'
const BIP39 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
})

describe('derivation marker', () => {
  it('is written as part of the same record as the ciphertext', async () => {
    // Not "written afterwards, and we remembered to". encryptMnemonic returns one object, so a
    // record cannot exist on disk with the ciphertext but without the marker describing it.
    const stored = await encryptMnemonic(CIPHERSEED, PASSWORD, 'cipherseed')
    expect(stored.scheme).toBe('cipherseed')
    saveStoredWallet(stored)

    const onDisk = JSON.parse(localStorage.getItem(KEY)!)
    expect(onDisk.scheme).toBe('cipherseed')
    expect(onDisk.ciphertext).toBe(stored.ciphertext)
  }, 30_000)

  it('records bip39 when a legacy phrase is restored', async () => {
    const stored = await encryptMnemonic(BIP39, PASSWORD, 'bip39')
    expect(stored.scheme).toBe('bip39')
    expect(await decryptMnemonic(stored, PASSWORD)).toBe(BIP39)
  }, 30_000)

  it('survives a save/load round-trip and resolves without consulting the phrase', async () => {
    saveStoredWallet(await encryptMnemonic(CIPHERSEED, PASSWORD, 'cipherseed'))
    const reloaded = loadStoredWallet()!
    expect(resolveScheme(reloaded, CIPHERSEED)).toEqual({
      scheme: 'cipherseed',
      markerWasMissing: false,
    })
  }, 30_000)
})

describe('legacy records with no marker', () => {
  // Simulates a wallet written before the field existed: exactly what every current user has.
  async function legacyRecord(phrase: string) {
    const { scheme: _dropped, ...withoutMarker } = await encryptMnemonic(phrase, PASSWORD, 'bip39')
    return withoutMarker
  }

  it('opens as BIP-39, unchanged, and asks to be marked', async () => {
    const stored = await legacyRecord(BIP39) as Awaited<ReturnType<typeof encryptMnemonic>>
    expect(stored.scheme).toBeUndefined()
    expect(resolveScheme(stored, BIP39)).toEqual({ scheme: 'bip39', markerWasMissing: true })
  }, 30_000)

  it('markScheme labels the record without touching the ciphertext', async () => {
    const stored = await legacyRecord(BIP39) as Awaited<ReturnType<typeof encryptMnemonic>>
    const marked = markScheme(stored, 'bip39')
    expect(marked.scheme).toBe('bip39')
    // Everything else byte-identical — re-labelling must never be able to disturb a working wallet.
    expect({ ...marked, scheme: undefined }).toEqual({ ...stored, scheme: undefined })
    expect(await decryptMnemonic(marked, PASSWORD)).toBe(BIP39)
  }, 30_000)
})

describe('loadStoredWallet', () => {
  it('returns null when there is genuinely no wallet', () => {
    expect(hasStoredWallet()).toBe(false)
    expect(loadStoredWallet()).toBeNull()
  })

  it('throws on an envelope version this build does not know', () => {
    // Returning null here would look like "no wallet", send the user to the create screen, and let
    // a new wallet overwrite the record they could not open. Loud beats silent.
    localStorage.setItem(KEY, JSON.stringify({ version: 2, kdf: 'pbkdf2', iterations: 1, salt: '', iv: '', ciphertext: '' }))
    expect(() => loadStoredWallet()).toThrow(/newer version of Caravel/)
  })

  it('throws on a corrupt record rather than reporting no wallet', () => {
    localStorage.setItem(KEY, '{ not json')
    expect(() => loadStoredWallet()).toThrow(/unreadable/)
  })

  it('still opens a well-formed version 1 record', async () => {
    saveStoredWallet(await encryptMnemonic(CIPHERSEED, PASSWORD, 'cipherseed'))
    expect(loadStoredWallet()?.version).toBe(1)
  }, 30_000)
})
