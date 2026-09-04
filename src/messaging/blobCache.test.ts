// Unit tests for the IndexedDB blob cache (image attachments M1).
//
// The interesting risk in this module is the IndexedDB interaction itself — index range purges,
// quota/abort handling, one shared open across concurrent callers — not the key string. So the specs
// run against `fake-indexeddb`, a real in-memory IDB implementation, rather than asserting on pure
// helpers and calling it covered. The pure key logic is tested separately because it is the thing
// that keeps two identities from reading each other's blobs.
//
// Node has no IndexedDB (vitest runs environment: 'node'), so the factory is installed onto
// globalThis before the module under test resolves it — blobCache reads globalThis.indexedDB lazily
// inside openDb(), which is what makes that swap possible per test.

import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  blobCacheKey,
  deleteAllForIdentity,
  deleteBlobs,
  getBlob,
  hasBlob,
  putBlob,
  __resetBlobCacheForTests,
} from './blobCache'
import { clearStoreKey, setStoreKey } from '../crypto/sessionKey'

const ME = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

// Distinguishable bytes, so a cross-identity leak shows up as wrong CONTENT and not just a hit.
function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer
}
function readBytes(buffer: ArrayBuffer): number[] {
  return [...new Uint8Array(buffer)]
}

const STORE_KEY = new Uint8Array(32).fill(42)

beforeEach(() => {
  // A brand-new factory per test = a brand-new empty database, with no teardown to forget.
  globalThis.indexedDB = new IDBFactory()
  // A store key per test, for the same reason (stage 5): every read and write now needs one, and an
  // unlocked session is the ordinary case these specs describe. The locked case is its own block.
  // Copied rather than shared — clearStoreKey zeroes the buffer it is handed.
  setStoreKey(Uint8Array.from(STORE_KEY))
  __resetBlobCacheForTests()
})

describe('blobCacheKey', () => {
  it('namespaces the blob key under the identity', () => {
    expect(blobCacheKey(ME, 'hash1')).toBe(`${ME}:hash1`)
  })

  it('gives two identities different keys for the SAME blob', () => {
    // The whole point: the same image cached by two wallets on one device must not collide, and
    // neither key is reachable without knowing that identity's pubkey.
    expect(blobCacheKey(ME, 'hash1')).not.toBe(blobCacheKey(OTHER, 'hash1'))
  })

  it('is stable — the same inputs always address the same record', () => {
    expect(blobCacheKey(ME, 'hash1')).toBe(blobCacheKey(ME, 'hash1'))
  })
})

describe('put / get round-trip', () => {
  it('stores and returns the bytes and mime unchanged', async () => {
    expect(await putBlob(ME, 'hash1', bytes(1, 2, 3, 4), 'image/jpeg')).toBe(true)

    const hit = await getBlob(ME, 'hash1')
    expect(hit).not.toBeNull()
    expect(readBytes(hit!.bytes)).toEqual([1, 2, 3, 4])
    expect(hit!.mime).toBe('image/jpeg')
  })

  it('returns null for a blob that was never cached', async () => {
    expect(await getBlob(ME, 'never-stored')).toBeNull()
  })

  it('overwrites on the same key rather than duplicating', async () => {
    await putBlob(ME, 'hash1', bytes(1, 1, 1), 'image/png')
    await putBlob(ME, 'hash1', bytes(9, 9, 9), 'image/webp')

    const hit = await getBlob(ME, 'hash1')
    expect(readBytes(hit!.bytes)).toEqual([9, 9, 9])
    expect(hit!.mime).toBe('image/webp')
  })

  it('refuses a blank identity or blank key without touching the store', async () => {
    expect(await putBlob('', 'hash1', bytes(1), 'image/png')).toBe(false)
    expect(await putBlob(ME, '', bytes(1), 'image/png')).toBe(false)
    expect(await getBlob('', 'hash1')).toBeNull()
    expect(await getBlob(ME, '')).toBeNull()
    expect(await hasBlob('', 'hash1')).toBe(false)
  })

  it('handles a zero-byte blob as a real entry, not a miss', async () => {
    expect(await putBlob(ME, 'empty', bytes(), 'image/png')).toBe(true)
    const hit = await getBlob(ME, 'empty')
    expect(hit).not.toBeNull()
    expect(hit!.bytes.byteLength).toBe(0)
  })
})

describe('per-identity isolation', () => {
  it('never lets one identity read another\'s blob under the same blob key', async () => {
    await putBlob(ME, 'shared-hash', bytes(1, 1, 1), 'image/png')
    await putBlob(OTHER, 'shared-hash', bytes(2, 2, 2), 'image/png')

    expect(readBytes((await getBlob(ME, 'shared-hash'))!.bytes)).toEqual([1, 1, 1])
    expect(readBytes((await getBlob(OTHER, 'shared-hash'))!.bytes)).toEqual([2, 2, 2])
  })

  it('reports a miss for an identity that has not cached it, even when another has', async () => {
    await putBlob(ME, 'hash1', bytes(1), 'image/png')
    expect(await getBlob(OTHER, 'hash1')).toBeNull()
    expect(await hasBlob(OTHER, 'hash1')).toBe(false)
  })
})

describe('hasBlob', () => {
  it('answers without materialising the bytes', async () => {
    await putBlob(ME, 'hash1', bytes(1, 2, 3), 'image/png')
    expect(await hasBlob(ME, 'hash1')).toBe(true)
    expect(await hasBlob(ME, 'hash2')).toBe(false)
  })
})

describe('deleteBlobs — the conversation/group purge path', () => {
  it('deletes exactly the listed keys and leaves the rest', async () => {
    await putBlob(ME, 'keep', bytes(1), 'image/png')
    await putBlob(ME, 'drop1', bytes(2), 'image/png')
    await putBlob(ME, 'drop2', bytes(3), 'image/png')

    await deleteBlobs(ME, ['drop1', 'drop2'])

    expect(await hasBlob(ME, 'drop1')).toBe(false)
    expect(await hasBlob(ME, 'drop2')).toBe(false)
    expect(await hasBlob(ME, 'keep')).toBe(true)
  })

  it('ignores absent keys, so it is idempotent and safe to re-run', async () => {
    await putBlob(ME, 'hash1', bytes(1), 'image/png')
    await deleteBlobs(ME, ['hash1', 'never-existed'])
    await deleteBlobs(ME, ['hash1'])            // second pass over an already-purged conversation
    expect(await hasBlob(ME, 'hash1')).toBe(false)
  })

  it('does not touch another identity\'s copy of the same blob key', async () => {
    await putBlob(ME, 'shared-hash', bytes(1), 'image/png')
    await putBlob(OTHER, 'shared-hash', bytes(2), 'image/png')

    await deleteBlobs(ME, ['shared-hash'])

    expect(await hasBlob(ME, 'shared-hash')).toBe(false)
    expect(await hasBlob(OTHER, 'shared-hash')).toBe(true)
  })

  it('is a no-op for an empty list or a blank identity', async () => {
    await putBlob(ME, 'hash1', bytes(1), 'image/png')
    await deleteBlobs(ME, [])
    await deleteBlobs('', ['hash1'])
    expect(await hasBlob(ME, 'hash1')).toBe(true)
  })
})

describe('deleteAllForIdentity', () => {
  it('drops every blob for that identity and none of another\'s', async () => {
    await putBlob(ME, 'h1', bytes(1), 'image/png')
    await putBlob(ME, 'h2', bytes(2), 'image/png')
    await putBlob(ME, 'h3', bytes(3), 'image/png')
    await putBlob(OTHER, 'h1', bytes(9), 'image/png')

    await deleteAllForIdentity(ME)

    expect(await hasBlob(ME, 'h1')).toBe(false)
    expect(await hasBlob(ME, 'h2')).toBe(false)
    expect(await hasBlob(ME, 'h3')).toBe(false)
    expect(await hasBlob(OTHER, 'h1')).toBe(true)
  })

  it('is a no-op for an identity with nothing cached', async () => {
    await putBlob(ME, 'h1', bytes(1), 'image/png')
    await deleteAllForIdentity(OTHER)
    expect(await hasBlob(ME, 'h1')).toBe(true)
  })
})

describe('failure degrades to re-fetch — never throws, never loses a message', () => {
  it('no-ops every operation when IndexedDB is absent entirely', async () => {
    // Safari private browsing / storage disabled / the Node default. The app must behave exactly as
    // if the cache were permanently empty.
    // @ts-expect-error — deliberately removing the API the module probes for.
    globalThis.indexedDB = undefined
    __resetBlobCacheForTests()

    expect(await putBlob(ME, 'hash1', bytes(1), 'image/png')).toBe(false)
    expect(await getBlob(ME, 'hash1')).toBeNull()
    expect(await hasBlob(ME, 'hash1')).toBe(false)
    // The void-returning purges must resolve rather than reject — the delete paths fire them and
    // move on, so a rejection here would surface as an unhandled promise rejection.
    await expect(deleteBlobs(ME, ['hash1'])).resolves.toBeUndefined()
    await expect(deleteAllForIdentity(ME)).resolves.toBeUndefined()
  })

  it('no-ops when opening the database throws', async () => {
    // @ts-expect-error — a factory whose open() throws, as a locked-down browser can.
    globalThis.indexedDB = { open() { throw new Error('SecurityError') } }
    __resetBlobCacheForTests()

    expect(await putBlob(ME, 'hash1', bytes(1), 'image/png')).toBe(false)
    expect(await getBlob(ME, 'hash1')).toBeNull()
    await expect(deleteBlobs(ME, ['hash1'])).resolves.toBeUndefined()
  })

  it('no-ops when the open request errors, and RETRIES on a later call', async () => {
    // A failed open must not be cached forever — unlike a successful handle, which is kept.
    const failing = {
      open() {
        const request: Record<string, unknown> = { onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null }
        queueMicrotask(() => (request.onerror as (() => void) | null)?.())
        return request
      },
    }
    // @ts-expect-error — minimal stand-in for IDBFactory.
    globalThis.indexedDB = failing
    __resetBlobCacheForTests()
    expect(await putBlob(ME, 'hash1', bytes(1), 'image/png')).toBe(false)

    // Storage comes back (e.g. the blocking tab closed). WITHOUT resetting the singleton by hand,
    // the next call must reopen rather than keep returning the cached failure.
    globalThis.indexedDB = new IDBFactory()
    expect(await putBlob(ME, 'hash1', bytes(1, 2), 'image/png')).toBe(true)
    expect(readBytes((await getBlob(ME, 'hash1'))!.bytes)).toEqual([1, 2])
  })

  it('reports false rather than throwing when a value cannot be stored', async () => {
    // A put that cannot complete must resolve false, not reject. Since stage 5 this bogus value is
    // rejected EARLIER than it used to be — crypto.subtle.encrypt refuses a non-BufferSource before
    // any transaction opens, where it previously reached IndexedDB and failed the structured clone.
    // The outcome the callers depend on is the same, and the quota path still lands on tx.onabort.
    // @ts-expect-error — a function is neither a BufferSource nor structured-cloneable.
    const unclonable: ArrayBuffer = { bytes: () => {} }
    await expect(putBlob(ME, 'bad', unclonable, 'image/png')).resolves.toBe(false)
    // and the store is still usable afterwards
    expect(await putBlob(ME, 'good', bytes(7), 'image/png')).toBe(true)
  })
})

describe('concurrent access shares one open', () => {
  it('serves simultaneous reads and writes without a duplicate-open failure', async () => {
    // StrictMode double-invocation, or several image cards mounting at once. Each of these calls
    // openDb() before any has resolved, so they must all await the same promise.
    const writes = await Promise.all([
      putBlob(ME, 'h1', bytes(1), 'image/png'),
      putBlob(ME, 'h2', bytes(2), 'image/png'),
      putBlob(ME, 'h3', bytes(3), 'image/png'),
    ])
    expect(writes).toEqual([true, true, true])

    const reads = await Promise.all([getBlob(ME, 'h1'), getBlob(ME, 'h2'), getBlob(ME, 'h3')])
    expect(reads.map(r => readBytes(r!.bytes))).toEqual([[1], [2], [3]])
  })

  it('survives a read racing the delete of the same key', async () => {
    await putBlob(ME, 'h1', bytes(1), 'image/png')
    // Whichever order these land in, neither may throw — a read that loses the race is a miss, which
    // is the same outcome as any other miss.
    const [, hit] = await Promise.all([deleteBlobs(ME, ['h1']), getBlob(ME, 'h1')])
    expect(hit === null || readBytes(hit.bytes)).toBeTruthy()
    expect(await hasBlob(ME, 'h1')).toBe(false)
  })
})

// ── Stage 5: encryption at rest ───────────────────────────────────────────────
//
// These reach PAST the public API and read the raw IndexedDB records, which the specs above
// deliberately never do. That is the point: every assertion here is about what a person with the
// disk sees, and asking getBlob would only tell us the module can read its own output.

const DB = 'caravel.blobs.v1'
const OBJ = 'blobs'

interface RawRecord {
  id: string
  pubkey: string
  v?: number
  nonce?: ArrayBuffer
  bytes: ArrayBuffer
  mime: string
  size: number
  storedAt: number
}

// Open a SECOND connection at the current version, alongside the module's own handle.
//
// Creates the object store if it is not there, because a probe can legitimately run against a
// database the module never opened — putBlob bails on the key check BEFORE openDb, so "locked, and
// nothing was written" is exactly the case where no store exists yet. Without this the probe throws
// where it should report emptiness.
function rawOpen(): Promise<IDBDatabase> {
  return new Promise(resolve => {
    const request = globalThis.indexedDB.open(DB, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(OBJ)) {
        db.createObjectStore(OBJ, { keyPath: 'id' }).createIndex('pubkey', 'pubkey', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function rawGet(id: string): Promise<RawRecord | undefined> {
  return rawOpen().then(db => new Promise<RawRecord | undefined>(resolve => {
    const get = db.transaction(OBJ, 'readonly').objectStore(OBJ).get(id)
    get.onsuccess = () => { db.close(); resolve(get.result as RawRecord | undefined) }
  }))
}

function rawPut(record: RawRecord): Promise<void> {
  return rawOpen().then(db => new Promise<void>(resolve => {
    const tx = db.transaction(OBJ, 'readwrite')
    tx.objectStore(OBJ).put(record)
    tx.oncomplete = () => { db.close(); resolve() }
  }))
}

function rawCount(): Promise<number> {
  return rawOpen().then(db => new Promise<number>(resolve => {
    const count = db.transaction(OBJ, 'readonly').objectStore(OBJ).count()
    count.onsuccess = () => { db.close(); resolve(count.result) }
  }))
}

// A pre-stage-5 database: schema version 1, the old record shape, bytes in the clear.
function seedLegacyV1(records: { id: string; pubkey: string; bytes: ArrayBuffer; mime: string }[]): Promise<void> {
  return new Promise(resolve => {
    const request = globalThis.indexedDB.open(DB, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(OBJ, { keyPath: 'id' })
      store.createIndex('pubkey', 'pubkey', { unique: false })
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(OBJ, 'readwrite')
      for (const r of records) {
        tx.objectStore(OBJ).put({ ...r, size: r.bytes.byteLength, storedAt: Date.now() })
      }
      tx.oncomplete = () => { db.close(); resolve() }
    }
  })
}

// Long and distinctive, so "the ciphertext does not contain the plaintext" is a real assertion
// rather than a coincidence about four bytes.
const SECRET = new Uint8Array(64).map((_, i) => (i * 7 + 13) & 0xff)
const secretBytes = () => SECRET.slice().buffer
function contains(haystack: ArrayBuffer, needle: Uint8Array): boolean {
  const hay = new Uint8Array(haystack)
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

describe('encryption at rest', () => {
  it('writes ciphertext — the image bytes are not on disk', async () => {
    expect(await putBlob(ME, 'hash1', secretBytes(), 'image/png')).toBe(true)

    const raw = (await rawGet(`${ME}:hash1`))!
    expect(raw.v).toBe(2)
    expect(raw.nonce!.byteLength).toBe(12)
    expect(contains(raw.bytes, SECRET)).toBe(false)
    // GCM appends a 128-bit tag, so the stored value is longer than what went in.
    expect(raw.bytes.byteLength).toBe(SECRET.length + 16)
  })

  it('round-trips through decrypt-on-read', async () => {
    await putBlob(ME, 'hash1', secretBytes(), 'image/webp')
    const hit = (await getBlob(ME, 'hash1'))!
    expect(new Uint8Array(hit.bytes)).toEqual(SECRET)
    expect(hit.mime).toBe('image/webp')
  })

  it('mints a fresh nonce per put, so the same image twice is not the same ciphertext', async () => {
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    const first = (await rawGet(`${ME}:hash1`))!
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    const second = (await rawGet(`${ME}:hash1`))!

    expect(new Uint8Array(second.nonce!)).not.toEqual(new Uint8Array(first.nonce!))
    expect(new Uint8Array(second.bytes)).not.toEqual(new Uint8Array(first.bytes))
  })

  it('keeps mime readable and size meaning the PLAINTEXT length', async () => {
    // Both stay in the clear on purpose — mime rebuilds the Blob, and size feeds the sweep the
    // header anticipates. Neither reveals more than the ciphertext length already does.
    await putBlob(ME, 'hash1', secretBytes(), 'image/jpeg')
    const raw = (await rawGet(`${ME}:hash1`))!
    expect(raw.mime).toBe('image/jpeg')
    expect(raw.size).toBe(SECRET.length)
  })

  it('stores nothing readable for an empty image either', async () => {
    expect(await putBlob(ME, 'empty', bytes(), 'image/png')).toBe(true)
    const raw = (await rawGet(`${ME}:empty`))!
    expect(raw.bytes.byteLength).toBe(16)   // the bare GCM tag
    expect((await getBlob(ME, 'empty'))!.bytes.byteLength).toBe(0)
  })
})

describe('AAD binds the record to its id and mime', () => {
  it('refuses a record moved to another identity', async () => {
    await putBlob(ME, 'shared-hash', secretBytes(), 'image/png')
    const stolen = (await rawGet(`${ME}:shared-hash`))!

    // Byte-for-byte the same ciphertext, re-filed under the other identity — the move an attacker
    // with disk access can make trivially, and the one blobCacheKey alone only prevents by
    // convention.
    await rawPut({ ...stolen, id: `${OTHER}:shared-hash`, pubkey: OTHER })
    expect(await getBlob(OTHER, 'shared-hash')).toBeNull()
    // and the original still opens
    expect(new Uint8Array((await getBlob(ME, 'shared-hash'))!.bytes)).toEqual(SECRET)
  })

  it('refuses a record whose mime was swapped underneath it', async () => {
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    const record = (await rawGet(`${ME}:hash1`))!
    await rawPut({ ...record, mime: 'text/html' })
    expect(await getBlob(ME, 'hash1')).toBeNull()
  })
})

describe('no store key means a miss, never plaintext', () => {
  it('refuses to write while locked, and writes nothing at all', async () => {
    clearStoreKey()
    expect(await putBlob(ME, 'hash1', secretBytes(), 'image/png')).toBe(false)
    expect(await rawGet(`${ME}:hash1`)).toBeUndefined()
    expect(await rawCount()).toBe(0)
  })

  it('reads as a miss while locked, and has/get agree', async () => {
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    clearStoreKey()
    expect(await getBlob(ME, 'hash1')).toBeNull()
    expect(await hasBlob(ME, 'hash1')).toBe(false)
    // The record is untouched — locking is not a purge.
    expect(await rawCount()).toBe(1)
  })

  it('still purges while locked — destroying what we cannot read IS the operation', async () => {
    await putBlob(ME, 'keep', secretBytes(), 'image/png')
    await putBlob(ME, 'drop', secretBytes(), 'image/png')
    clearStoreKey()
    await deleteBlobs(ME, ['drop'])
    expect(await rawGet(`${ME}:drop`)).toBeUndefined()
    await deleteAllForIdentity(ME)
    expect(await rawCount()).toBe(0)
  })

  it('does not keep decrypting through a cached key import after a lock', async () => {
    // The CryptoKey holds its own copy of the material, so clearStoreKey's fill(0) cannot reach it.
    // Without the null check on every operation this read would still succeed.
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    expect(await getBlob(ME, 'hash1')).not.toBeNull()   // warms the import
    clearStoreKey()
    expect(await getBlob(ME, 'hash1')).toBeNull()
  })

  it('resumes on the next unlock', async () => {
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    clearStoreKey()
    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(new Uint8Array((await getBlob(ME, 'hash1'))!.bytes)).toEqual(SECRET)
  })
})

describe('a wrong key is a miss, not garbage', () => {
  it('fails the tag check rather than returning wrong bytes', async () => {
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    setStoreKey(new Uint8Array(32).fill(7))   // a re-minted salt derives a different key
    expect(await getBlob(ME, 'hash1')).toBeNull()
  })

  it('LEAVES the undecryptable record on disk — a read path must not be destructive', async () => {
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    setStoreKey(new Uint8Array(32).fill(7))
    await getBlob(ME, 'hash1')
    expect(await rawCount()).toBe(1)
    // and the right key still opens it, which is why deleting would have been wrong
    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(new Uint8Array((await getBlob(ME, 'hash1'))!.bytes)).toEqual(SECRET)
  })
})

describe('migration: the v1 plaintext cache is wiped in place', () => {
  it('clears every legacy record on the first open, rather than migrating it', async () => {
    await seedLegacyV1([
      { id: `${ME}:old1`, pubkey: ME, bytes: secretBytes(), mime: 'image/png' },
      { id: `${ME}:old2`, pubkey: ME, bytes: secretBytes(), mime: 'image/jpeg' },
      { id: `${OTHER}:old3`, pubkey: OTHER, bytes: secretBytes(), mime: 'image/png' },
    ])
    __resetBlobCacheForTests()

    // Any operation opens the database, which runs the upgrade.
    expect(await hasBlob(ME, 'old1')).toBe(false)

    // THE POINT: the plaintext is GONE from disk, not merely unreadable and not orphaned in a
    // renamed database. A rename would have left these three records sitting there forever.
    expect(await rawCount()).toBe(0)
    expect(await rawGet(`${ME}:old1`)).toBeUndefined()
    expect(await rawGet(`${OTHER}:old3`)).toBeUndefined()
  })

  it('leaves a working sealed cache behind, repopulating on the next put', async () => {
    await seedLegacyV1([{ id: `${ME}:old1`, pubkey: ME, bytes: secretBytes(), mime: 'image/png' }])
    __resetBlobCacheForTests()

    // What the app does after the wipe: the image is re-fetched from the blob host and re-cached,
    // sealed this time. Nothing was lost that a download does not replace.
    expect(await putBlob(ME, 'old1', secretBytes(), 'image/png')).toBe(true)
    expect(new Uint8Array((await getBlob(ME, 'old1'))!.bytes)).toEqual(SECRET)
    expect((await rawGet(`${ME}:old1`))!.v).toBe(2)
  })

  it('reads a stray unversioned record as a miss rather than as plaintext', async () => {
    // Unreachable in practice — the upgrade ran before any read could see one — but the check is
    // what stops a v1 record being handed back as though it had been opened.
    await putBlob(ME, 'hash1', secretBytes(), 'image/png')
    const sealed = (await rawGet(`${ME}:hash1`))!
    await rawPut({ id: sealed.id, pubkey: ME, bytes: secretBytes(), mime: 'image/png', size: 64, storedAt: Date.now() })
    expect(await getBlob(ME, 'hash1')).toBeNull()
  })
})
