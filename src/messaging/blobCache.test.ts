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

const ME = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

// Distinguishable bytes, so a cross-identity leak shows up as wrong CONTENT and not just a hit.
function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer
}
function readBytes(buffer: ArrayBuffer): number[] {
  return [...new Uint8Array(buffer)]
}

beforeEach(() => {
  // A brand-new factory per test = a brand-new empty database, with no teardown to forget.
  globalThis.indexedDB = new IDBFactory()
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
    // A put whose transaction aborts must resolve false, not reject. Structured-clone failure is the
    // reachable version of this in a browser; quota abort takes the same path (tx.onabort).
    // @ts-expect-error — a function is not structured-cloneable.
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
