// contactStore at rest (stage 4) — who you talk to.
//
// First spec file for this store — it had none before encryption reached it. These cover the stage 4
// surface: the envelope, migrate-on-read, and the never-clobber guard. The guards themselves are
// pinned once in storeIo.test.ts; these check that THIS store is wired to them correctly.

import { beforeEach, describe, expect, it } from 'vitest'
import { loadContacts, removeContact, setContactState } from './contactStore'
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

const SKEY = 'caravel.contacts.v1.' + ME


describe('encryption at rest', () => {
  it('writes ciphertext — the peer key is the social graph', () => {
    setContactState(ME, {}, PEER, 'accepted')
    expect(localStorage.getItem(SKEY)!).not.toContain(PEER)
    expect(sealedOnDisk()).toBe(true)
  })

  it('round-trips a record', () => {
    setContactState(ME, {}, PEER, 'pending')
    expect(loadContacts(ME)[PEER].state).toBe('pending')
    expect(loadContacts(ME)[PEER].updatedAt).toEqual(expect.any(Number))
  })

  it('removal seals too', () => {
    const map = setContactState(ME, {}, PEER, 'accepted')
    removeContact(ME, map, PEER)
    expect(sealedOnDisk()).toBe(true)
    expect(loadContacts(ME)).toEqual({})
  })
})

describe('migration', () => {
  it('reads a plaintext store and seals it on the first load', () => {
    localStorage.setItem(SKEY, JSON.stringify({ [PEER]: { state: 'accepted', updatedAt: 5 } }))
    expect(loadContacts(ME)[PEER]).toEqual({ state: 'accepted', updatedAt: 5 })
    expect(sealedOnDisk()).toBe(true)
  })

  it('does not rewrite an already-sealed store', () => {
    setContactState(ME, {}, PEER, 'accepted')
    const after = localStorage.getItem(SKEY)!
    loadContacts(ME); loadContacts(ME)
    expect(localStorage.getItem(SKEY)).toBe(after)
  })
})

describe('never clobber', () => {
  it('will not overwrite a store it could not read', () => {
    setContactState(ME, {}, PEER, 'accepted')
    const original = localStorage.getItem(SKEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    setContactState(ME, {}, 'c'.repeat(64), 'pending')
    expect(localStorage.getItem(SKEY)).toBe(original)
    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadContacts(ME)[PEER].state).toBe('accepted')
  })

  it('will not write with no store key', () => {
    clearStoreKey()
    setContactState(ME, {}, PEER, 'accepted')
    expect(localStorage.getItem(SKEY)).toBeNull()
  })
})


// ── The no-downgrade invariant ──────────────────────────────────────────────
//
// 'pending' may never overwrite 'accepted'. Sound because declining is REMOVAL of the record (see
// the store's header), so accepted → pending is a transition no caller has ever needed. It exists
// because an unopenable message store made every sender in a relay replay look brand-new, and the
// inbound handler answered that by writing 'pending' over accepted contacts — every session.
describe('pending never overwrites accepted', () => {
  it('refuses the downgrade, and writes nothing at all', () => {
    const accepted = setContactState(ME, {}, PEER, 'accepted')
    const onDisk = localStorage.getItem(SKEY)!

    const next = setContactState(ME, accepted, PEER, 'pending')

    expect(next).toBe(accepted)                          // same reference — React skips the re-render
    expect(localStorage.getItem(SKEY)).toBe(onDisk)      // and the record is byte-for-byte untouched
    expect(loadContacts(ME)[PEER].state).toBe('accepted')
  })

  it('still records pending for a peer with no record — the real request case', () => {
    expect(setContactState(ME, {}, PEER, 'pending')[PEER].state).toBe('pending')
    expect(loadContacts(ME)[PEER].state).toBe('pending')
  })

  it('still allows the accept it is named for: pending → accepted', () => {
    const pending = setContactState(ME, {}, PEER, 'pending')
    setContactState(ME, pending, PEER, 'accepted')
    expect(loadContacts(ME)[PEER].state).toBe('accepted')
  })

  it('does not block a FRESH request after a decline — decline is removal, not a downgrade', () => {
    const accepted = setContactState(ME, {}, PEER, 'accepted')
    const gone = removeContact(ME, accepted, PEER)
    expect(setContactState(ME, gone, PEER, 'pending')[PEER].state).toBe('pending')
    expect(loadContacts(ME)[PEER].state).toBe('pending')
  })
})
