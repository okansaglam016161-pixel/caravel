// The one-time conversion from the retired store-key scheme to the seed-derived one.
//
// WHAT THESE HAVE TO PROVE is narrower than it looks. The migration never parses a store's contents
// — it decrypts and re-encrypts opaque JSON — so losslessness is exactly the claim that what comes
// out of the new key is byte-identical to what went in under the old one. That is asserted for all
// ten records, and then four of them are run through their REAL public loaders as well, to prove the
// key shapes and the wiring line up with the stores rather than only with each other.
//
// The rest is the awkward cases: a half-finished pass, a record already converted, a record sealed
// under a salt that is long gone, and a device with nothing to convert at all.

import { beforeEach, describe, expect, it } from 'vitest'
import { open, seal } from './storeCrypto'
import { setStoreKey, clearStoreKey } from './sessionKey'
import {
  deriveLegacyStoreKey,
  hasLegacyStoreKey,
  legacyRecordKeys,
  loadLegacyKeyParams,
  migrateStoreKey,
  type LegacyKeyParams,
} from './storeKeyMigration'
import { loadMessages } from '../messaging/messageStore'
import { loadContacts } from '../messaging/contactStore'
import { loadNicknames } from '../messaging/nicknameStore'
import { loadGroups } from '../messaging/groupStore'

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

const LEGACY_KEY = 'caravel.storekey.v1'
const PW = 'correct horse battery staple'
const ME = 'a'.repeat(64)
const ADDR = 'otl_testaddress'
const NEW_KEY = new Uint8Array(32).fill(42)

/** Cheap iterations: these specs are about the KEY, not about re-measuring the work factor. */
const PARAMS: LegacyKeyParams = { version: 1, kdf: 'pbkdf2', iterations: 100, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }

/** Realistic-ish content per record, so "identical" means something more than an empty object. */
function contentFor(storageKey: string): unknown {
  if (storageKey.includes('.messages.')) {
    return [{ id: 'evt1', senderPubkeyHex: ME, recipientPubkeyHex: 'b'.repeat(64), plaintext: 'hello', timestamp: 1_000, direction: 'received' }]
  }
  if (storageKey.includes('.contacts.')) return { ['b'.repeat(64)]: { state: 'accepted', updatedAt: 5 } }
  if (storageKey.includes('.nicknames.')) return { ['b'.repeat(64)]: 'Alice' }
  if (storageKey.includes('.groups.')) return [{ id: 'g1', name: 'Crew', members: [ME], createdAt: 1, state: 'active' }]
  if (storageKey.includes('.journal.')) return [{ id: 'j1', outcome: 'committed' }]
  if (storageKey.includes('.txhistory.')) return [{ id: 't1', kind: 'sent' }]
  return { some: 'value', forKey: storageKey }
}

async function seedLegacyDevice(keys = legacyRecordKeys(ME, ADDR)) {
  localStorage.setItem(LEGACY_KEY, JSON.stringify(PARAMS))
  const oldKey = await deriveLegacyStoreKey(PW, PARAMS)
  for (const k of keys) localStorage.setItem(k, seal(oldKey, JSON.stringify(contentFor(k))))
  return oldKey
}

const migrate = () => migrateStoreKey({ password: PW, newKey: NEW_KEY, pubkeyHex: ME, walletAddress: ADDR })

/** What the new key can read back out of a record, as parsed JSON. */
function readUnderNewKey(storageKey: string): unknown {
  const opened = open(NEW_KEY, localStorage.getItem(storageKey))
  if (opened.status !== 'ok') throw new Error(`${storageKey} did not open: ${opened.status}`)
  return JSON.parse(opened.json)
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  clearStoreKey()
})

describe('the retired record', () => {
  it('reports nothing to do on a device that never had one', () => {
    expect(loadLegacyKeyParams()).toBeNull()
    expect(hasLegacyStoreKey()).toBe(false)
  })

  it('reads back a record written by an older build', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(PARAMS))
    expect(hasLegacyStoreKey()).toBe(true)
    expect(loadLegacyKeyParams()).toEqual(PARAMS)
  })

  it('treats a corrupt or unusable record as nothing to do, rather than throwing', () => {
    for (const bad of ['not json at all', '{"version":99}', '{"version":1}', '{"version":1,"salt":"x","iterations":0}']) {
      globalThis.localStorage = memoryStorage()
      localStorage.setItem(LEGACY_KEY, bad)
      expect(loadLegacyKeyParams()).toBeNull()
      expect(hasLegacyStoreKey()).toBe(false)
    }
  })
})

describe('the retired derivation', () => {
  it('is deterministic for the same password and record', async () => {
    const a = await deriveLegacyStoreKey(PW, PARAMS)
    const b = await deriveLegacyStoreKey(PW, PARAMS)
    expect([...a]).toEqual([...b])
    expect(a.length).toBe(32)
  })

  it('gives a different key for a different password, and for a different salt', async () => {
    const base = await deriveLegacyStoreKey(PW, PARAMS)
    expect([...await deriveLegacyStoreKey('other', PARAMS)]).not.toEqual([...base])
    expect([...await deriveLegacyStoreKey(PW, { ...PARAMS, salt: 'BBBBBBBBBBBBBBBBBBBBBB==' })]).not.toEqual([...base])
  })

  it('reads iterations from the record, so an older work factor still opens its own data', async () => {
    const a = await deriveLegacyStoreKey(PW, { ...PARAMS, iterations: 100 })
    const b = await deriveLegacyStoreKey(PW, { ...PARAMS, iterations: 200 })
    expect([...a]).not.toEqual([...b])
  })
})

describe('a fully-old device', () => {
  it('converts all ten records LOSSLESSLY and clears the retired record', async () => {
    const keys = legacyRecordKeys(ME, ADDR)
    const before = Object.fromEntries(keys.map(k => [k, contentFor(k)]))
    await seedLegacyDevice(keys)

    const report = await migrate()

    expect(report.migrated).toBe(10)
    expect(report.stranded).toBe(0)
    expect(report.failed).toBe(0)
    expect(report.cleared).toBe(true)
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()

    // THE LOSSLESSNESS PROOF: what the new key reads back is what the old key was holding.
    for (const k of keys) expect(readUnderNewKey(k)).toEqual(before[k])
  })

  it("comes back through the stores' own public loaders", async () => {
    await seedLegacyDevice()
    await migrate()
    setStoreKey(NEW_KEY)   // what the app holds after unlock

    expect(loadMessages(ME)).toHaveLength(1)
    expect(loadMessages(ME)[0].plaintext).toBe('hello')
    expect(loadContacts(ME)['b'.repeat(64)].state).toBe('accepted')
    expect(loadNicknames(ME)['b'.repeat(64)]).toBe('Alice')
    expect(loadGroups(ME)).toHaveLength(1)
  })

  it('leaves every record sealed — never plaintext, not even in passing', async () => {
    await seedLegacyDevice()
    await migrate()
    for (const k of legacyRecordKeys(ME, ADDR)) {
      expect(JSON.parse(localStorage.getItem(k)!).v).toBe(2)
      expect(localStorage.getItem(k)).not.toContain('Alice')
    }
  })
})

describe('re-running it', () => {
  it('finishes a pass that was interrupted halfway, without re-sealing what it already did', async () => {
    const keys = legacyRecordKeys(ME, ADDR)
    await seedLegacyDevice(keys)

    // A crash mid-pass: the first four converted, the retired record still present.
    const oldKey = await deriveLegacyStoreKey(PW, PARAMS)
    for (const k of keys.slice(0, 4)) {
      const opened = open(oldKey, localStorage.getItem(k))
      localStorage.setItem(k, seal(NEW_KEY, opened.status === 'ok' ? opened.json : '{}'))
    }
    const untouched = Object.fromEntries(keys.slice(0, 4).map(k => [k, localStorage.getItem(k)!]))

    const report = await migrate()

    expect(report.alreadyReadable).toBe(4)   // skipped, not re-sealed
    expect(report.migrated).toBe(6)
    expect(report.cleared).toBe(true)
    // A re-seal would mint a fresh nonce and change the bytes. These are identical, so nothing ran.
    for (const [k, bytes] of Object.entries(untouched)) expect(localStorage.getItem(k)).toBe(bytes)
    for (const k of keys) expect(readUnderNewKey(k)).toEqual(contentFor(k))
  })

  it('is a clean no-op once the retired record is gone', async () => {
    await seedLegacyDevice()
    await migrate()
    const after = Object.fromEntries(legacyRecordKeys(ME, ADDR).map(k => [k, localStorage.getItem(k)!]))

    const second = await migrate()

    expect(second).toEqual({ migrated: 0, alreadyReadable: 0, stranded: 0, absent: 0, failed: 0, cleared: false })
    for (const [k, bytes] of Object.entries(after)) expect(localStorage.getItem(k)).toBe(bytes)
  })

  it('does nothing at all on a device that never had the retired record', async () => {
    localStorage.setItem(`caravel.messages.v1.${ME}`, seal(NEW_KEY, '[]'))
    const before = localStorage.getItem(`caravel.messages.v1.${ME}`)
    expect(await migrate()).toEqual({ migrated: 0, alreadyReadable: 0, stranded: 0, absent: 0, failed: 0, cleared: false })
    expect(localStorage.getItem(`caravel.messages.v1.${ME}`)).toBe(before)
  })
})

describe('records it cannot open', () => {
  it('leaves a stranded record byte-for-byte alone, and still finishes', async () => {
    const keys = legacyRecordKeys(ME, ADDR)
    await seedLegacyDevice(keys)
    // Sealed under a third key whose salt was overwritten long ago — the original failure.
    const stranded = seal(new Uint8Array(32).fill(7), '{"lost":true}')
    localStorage.setItem(keys[0], stranded)

    const report = await migrate()

    expect(report.stranded).toBe(1)
    expect(report.migrated).toBe(9)
    expect(localStorage.getItem(keys[0])).toBe(stranded)   // untouched, not tidied away
    // Stranding does NOT hold the migration open: its salt is already gone, so keeping the retired
    // record would buy nothing.
    expect(report.cleared).toBe(true)
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('KEEPS the retired record when NOTHING converted — the wrong-password signature', async () => {
    // Converting nothing while records sit unopenable is indistinguishable from a bad password, so
    // the migration refuses to close itself out. unlock proves the password first, so this should be
    // unreachable there; it is the guard for every caller that does not.
    const keys = legacyRecordKeys(ME, ADDR)
    localStorage.setItem(LEGACY_KEY, JSON.stringify(PARAMS))
    const sealedElsewhere = seal(new Uint8Array(32).fill(7), '{"lost":true}')
    for (const k of keys) localStorage.setItem(k, sealedElsewhere)

    const report = await migrateStoreKey({ password: 'the WRONG password', newKey: NEW_KEY, pubkeyHex: ME, walletAddress: ADDR })

    expect(report.migrated).toBe(0)
    expect(report.stranded).toBe(10)
    expect(report.cleared).toBe(false)
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull()
    for (const k of keys) expect(localStorage.getItem(k)).toBe(sealedElsewhere)
  })

  it('passes a never-sealed plaintext record through untouched, for its store to seal on read', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(PARAMS))
    const plaintext = JSON.stringify({ ['b'.repeat(64)]: 'Alice' })
    localStorage.setItem(`caravel.nicknames.v1.${ME}`, plaintext)

    const report = await migrate()

    expect(report.alreadyReadable).toBe(1)
    expect(localStorage.getItem(`caravel.nicknames.v1.${ME}`)).toBe(plaintext)
    // storeIo's migrate-on-read seals it under the live key the first time the store is loaded.
    setStoreKey(NEW_KEY)
    expect(loadNicknames(ME)['b'.repeat(64)]).toBe('Alice')
    expect(JSON.parse(localStorage.getItem(`caravel.nicknames.v1.${ME}`)!).v).toBe(2)
  })

  it('counts an absent record rather than inventing one', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(PARAMS))
    const report = await migrate()
    expect(report.absent).toBe(10)
    expect(report.migrated).toBe(0)
    expect(report.cleared).toBe(true)   // nothing stranded, so nothing to explain
  })
})

describe('what it does not touch', () => {
  it("converts only this wallet, leaving another identity's records alone", async () => {
    await seedLegacyDevice()
    const other = `caravel.messages.v1.${'c'.repeat(64)}`
    const otherBytes = seal(new Uint8Array(32).fill(9), '["theirs"]')
    localStorage.setItem(other, otherBytes)

    await migrate()

    expect(localStorage.getItem(other)).toBe(otherBytes)
  })

  it('leaves the plaintext stores and the wallet record alone', async () => {
    await seedLegacyDevice()
    const untouched: Record<string, string> = {
      'caravel.wallet.v1': '{"version":1}',
      [`caravel.tombstones.v1.${ME}`]: '{"evt1":1}',
      [`caravel.seendefs.v1.${ME}`]: '{"d1":1}',
      [`caravel.deletedgroups.v1.${ME}`]: '{"g9":1}',
      [`caravel.account.v1.${ADDR}`]: 'component_address',
      [`caravel.journal.epoch.v1.${ADDR}`]: '{"startedAt":1}',
    }
    for (const [k, v] of Object.entries(untouched)) localStorage.setItem(k, v)

    await migrate()

    for (const [k, v] of Object.entries(untouched)) expect(localStorage.getItem(k)).toBe(v)
  })
})
