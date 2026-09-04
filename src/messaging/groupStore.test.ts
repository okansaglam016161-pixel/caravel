// groupStore at rest (stage 4) — group names and rosters.
//
// First spec file for this store — it had none before encryption reached it. These cover the stage 4
// surface: the envelope, migrate-on-read, and the never-clobber guard. The guards themselves are
// pinned once in storeIo.test.ts; these check that THIS store is wired to them correctly.

import { beforeEach, describe, expect, it } from 'vitest'
import { addOrUpdateGroup, ensureGroup, getGroupState, hasGroup, loadGroups } from './groupStore'
import type { GroupDef } from './types'
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

const SKEY = 'caravel.groups.v1.' + ME


const DEF: GroupDef = { id: 'grp1', name: 'Design crew', members: [PEER, 'c'.repeat(64)] }

describe('encryption at rest', () => {
  it('writes ciphertext — the name and the roster are the membership graph', () => {
    addOrUpdateGroup(ME, [], DEF)
    const stored = localStorage.getItem(SKEY)!
    expect(stored).not.toContain('Design crew')
    expect(stored).not.toContain(PEER)
    expect(sealedOnDisk()).toBe(true)
  })

  it('round-trips a group', () => {
    addOrUpdateGroup(ME, [], DEF)
    const [g] = loadGroups(ME)
    expect(g.name).toBe('Design crew')
    expect(g.members).toEqual(DEF.members)
    expect(g.state).toBe('active')
  })

  it('keeps hasGroup and getGroupState authoritative — they read the sealed store SYNCHRONOUSLY', () => {
    // Their contract is that every mutation has already written by the time they are called. The
    // envelope is synchronous, so that still holds; an async store would break it silently.
    addOrUpdateGroup(ME, [], DEF)
    expect(hasGroup(ME, 'grp1')).toBe(true)
    expect(getGroupState(ME, 'grp1')).toBe('active')
    expect(hasGroup(ME, 'nope')).toBe(false)
  })

  it('a placeholder from ensureGroup is sealed too', () => {
    ensureGroup(ME, [], 'grp2')
    expect(sealedOnDisk()).toBe(true)
    expect(loadGroups(ME)[0].state).toBe('pending')
  })
})

describe('migration', () => {
  it('reads a plaintext store and seals it on the first load', () => {
    localStorage.setItem(SKEY, JSON.stringify([
      { id: 'grp1', name: 'Old group', members: [PEER], createdAt: 5, state: 'active' },
    ]))
    expect(loadGroups(ME)[0].name).toBe('Old group')
    expect(sealedOnDisk()).toBe(true)
  })

  it('MAKES THE MISSING-state MIGRATION PERMANENT', () => {
    // A group persisted before invite-gating has no `state`, and the default has been re-derived on
    // every load ever since. The migrating read stores the PARSED list, so it is applied once.
    localStorage.setItem(SKEY, JSON.stringify([
      { id: 'grp1', name: 'Pre-gating', members: [PEER], createdAt: 5 },   // no `state`
    ]))

    expect(loadGroups(ME)[0].state).toBe('active')
    expect(sealedOnDisk()).toBe(true)
    // ...and the state is now ON DISK rather than re-derived.
    expect(getGroupState(ME, 'grp1')).toBe('active')
  })

  it('does not rewrite an already-sealed store', () => {
    addOrUpdateGroup(ME, [], DEF)
    const after = localStorage.getItem(SKEY)!
    loadGroups(ME); loadGroups(ME)
    expect(localStorage.getItem(SKEY)).toBe(after)
  })
})

describe('never clobber', () => {
  it('will not overwrite a store it could not read', () => {
    addOrUpdateGroup(ME, [], DEF)
    const original = localStorage.getItem(SKEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    ensureGroup(ME, [], 'grp-new')
    expect(localStorage.getItem(SKEY)).toBe(original)
    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadGroups(ME)[0].name).toBe('Design crew')
  })

  it('will not write with no store key', () => {
    clearStoreKey()
    addOrUpdateGroup(ME, [], DEF)
    expect(localStorage.getItem(SKEY)).toBeNull()
  })
})

