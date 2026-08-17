// Local cache for binary image blobs (image attachments M1) — the app's FIRST non-localStorage
// persistence. Sibling in spirit to paymentResolutionStore.ts: a per-identity, standalone store with
// no React mirror, whose entries are DERIVED data that can always be reconstructed.
//
// WHY NOT localStorage, like every other store here: localStorage is string-only and capped at
// ~5-10MB per origin, which the message history already shares. Images cannot live there. IndexedDB
// is the only browser store that holds binary at a useful size.
//
// ── THE CONTRACT: THIS CACHE IS NON-AUTHORITATIVE ────────────────────────────────
// The blob host is the source of truth. Every entry here is a copy that exists purely to avoid a
// re-fetch, so EVERY operation may fail and every failure degrades to "fetch it again later" —
// never to a crash, and never to a lost message. Concretely:
//
//   - open fails (Safari private browsing, storage disabled)  → every op no-ops; the app behaves
//     exactly as if the cache were permanently empty.
//   - put fails (quota exceeded, eviction race)               → returns false. The image is already
//     on screen from the fetch that produced these bytes; it simply isn't cached.
//   - get fails                                               → indistinguishable from a miss (null).
//   - delete fails                                            → orphaned bytes, unreachable once the
//     message row is gone, and eventually evicted by the browser.
//
// So NO CALLER NEEDS A try/catch AROUND ANYTHING IN THIS MODULE — the same contract the localStorage
// stores already offer with their `catch { /* quota / private mode */ }` convention.
//
// That contract is also why there is no eviction policy of our own. The browser evicts IndexedDB
// under storage pressure; because a lost entry costs exactly one re-fetch, that is survivable by
// construction rather than by handling. `storedAt` and `size` are recorded so an age- or size-based
// sweep can be added later without a schema migration, but building one now would guard against a
// failure we already tolerate. navigator.storage.persist() is deliberately NOT called: it prompts the
// user in some browsers and asks for a durability guarantee this data does not need.
//
// ── ASYNC, UNLIKE EVERY OTHER STORE ──────────────────────────────────────────────
// IndexedDB is asynchronous, so this CANNOT follow the `(pubkeyHex, current, …) => next` shape that
// messageStore/groupStore/contactStore use — those work only because localStorage is synchronous,
// which lets them run inside a React updater (`setMessages(prev => addSentMessage(…))`). Nothing here
// may be called from inside an updater.
//
// That is not a new problem for this codebase: usePaymentResolution is already an async, cache-first
// resolver with loading/resolved/failed states and module-level in-flight dedup. A media hook is the
// same machine with an async cache read in front of it, so the async-ness stays behind a hook and
// never reaches the synchronous stores.

// Bumping either name is a cache reset, not a migration — every entry is re-fetchable, so a schema
// change should just start a fresh database rather than carry an upgrade path. `.v1.` matches the
// versioning in every localStorage key (caravel.<name>.v1.<pubkeyHex>).
const DB_NAME = 'caravel.blobs.v1'
const STORE = 'blobs'
// Index over the owning identity. Only `deleteAllForIdentity` uses it; every other operation
// addresses a record directly by its composite primary key.
const PUBKEY_INDEX = 'pubkey'

// One stored blob. `bytes` is an ArrayBuffer and NOT a Blob on purpose: WebKit has a long history of
// bugs with Blob values stored in IndexedDB (handles going stale or unreadable after the page that
// created them is gone). ArrayBuffer is structured-cloneable everywhere with no such history, and
// rebuilding `new Blob([bytes], { type: mime })` at render time is free.
interface BlobRecord {
  id: string            // `${pubkeyHex}:${blobKey}` — the primary key
  pubkey: string        // indexed, for the identity-wide purge
  bytes: ArrayBuffer
  mime: string
  size: number
  storedAt: number
}

// What a cache hit hands back. Bytes + mime, deliberately NOT a Blob or an object URL:
// URL.createObjectURL leaks for the page's lifetime without a matching revokeObjectURL, and that
// lifecycle belongs to the component rendering the <img>, not to a storage module.
export interface CachedBlob {
  bytes: ArrayBuffer
  mime: string
}

// ── Keying ────────────────────────────────────────────────────────────────────

// The composite primary key. Direct analogue of the localStorage convention (one namespace per
// identity) and of usePaymentResolution's `${pubkey}:${utxoId}` dedup key, for the same reason: two
// identities on one device must never read each other's data, and without the pubkey the lookup key
// is unguessable.
//
// `blobKey` is OPAQUE here and this module asserts nothing about it. The intended value from M2 on is
// the SHA-256 of the CIPHERTEXT (kind 15's `x` tag) rather than the URL — stable when a blob is
// mirrored to a second host, and self-deduping when the same image is sent twice — but keeping it
// opaque means that choice can change without touching this file.
export function blobCacheKey(pubkeyHex: string, blobKey: string): string {
  return `${pubkeyHex}:${blobKey}`
}

// ── Database handle ───────────────────────────────────────────────────────────

// Singleton open, shared by every caller. Without it, StrictMode's double-invocation plus several
// image cards mounting at once would each open the database independently. Same purpose as
// usePaymentResolution's `inflightResolve`, with one difference: a DB handle is a long-lived resource,
// so a SUCCESSFUL open is kept, while a failed one is cleared so a later call can retry.
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    // globalThis lookup rather than a bare `indexedDB`: it is absent in the Node test environment and
    // can be missing or throw on access in a locked-down browser. Absent → the cache is simply off.
    let factory: IDBFactory | undefined
    try { factory = globalThis.indexedDB } catch { factory = undefined }
    if (!factory) { resolve(null); return }

    let request: IDBOpenDBRequest
    try { request = factory.open(DB_NAME, 1) } catch { resolve(null); return }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex(PUBKEY_INDEX, 'pubkey', { unique: false })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab upgrading the schema blocks on our open handle. Close it and drop the singleton
      // so the next call reopens — holding it would wedge the other tab indefinitely.
      db.onversionchange = () => { try { db.close() } catch { /* already closing */ } dbPromise = null }
      // Abnormal close (the browser reclaimed storage, or the DB was deleted underneath us).
      db.onclose = () => { dbPromise = null }
      resolve(db)
    }
    request.onerror = () => { dbPromise = null; resolve(null) }
    // Fired when another tab holds an older-version connection. Nothing to do but give up for now;
    // clearing the singleton lets a later call try again once that tab goes away.
    request.onblocked = () => { dbPromise = null; resolve(null) }
  })
  return dbPromise
}

// Run one transaction and settle when it does. Resolves `fallback` on ANY failure — a rejected
// request, an aborted transaction (this is where QuotaExceededError lands), or a throw while opening
// the transaction. This single helper is what makes every public function below non-throwing.
//
// NOTE the ordering: `oncomplete` is what resolves with the real value, because a request that
// succeeds inside a transaction that later aborts must NOT count as success — a quota abort can fire
// after the individual put request reported success.
async function withStore<T>(
  mode: IDBTransactionMode,
  fallback: T,
  run: (store: IDBObjectStore, done: (value: T) => void) => void
): Promise<T> {
  const db = await openDb()
  if (!db) return fallback
  return new Promise<T>(resolve => {
    let settled = false
    const finish = (value: T) => { if (!settled) { settled = true; resolve(value) } }
    let tx: IDBTransaction
    try { tx = db.transaction(STORE, mode) } catch { finish(fallback); return }

    // Captured by `done` below and only released to the caller once the transaction commits.
    let pending = fallback
    tx.oncomplete = () => finish(pending)
    tx.onabort = () => finish(fallback)     // quota, or any request error left unhandled
    tx.onerror = () => finish(fallback)

    try {
      run(tx.objectStore(STORE), value => { pending = value })
    } catch {
      // A throw inside the callback (e.g. a value that can't be structured-cloned) leaves the
      // transaction to abort on its own; resolve now so the caller is never left hanging.
      try { tx.abort() } catch { /* already aborting */ }
      finish(fallback)
    }
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

// Cache one blob's decrypted bytes. Returns whether it was actually stored — false means quota,
// unavailable storage, or an eviction race, ALL of which are fine: the caller already holds these
// bytes in memory, and a later view re-fetches. Overwriting an existing key is a no-op refresh.
//
// Bytes are stored DECRYPTED, deliberately. Caching ciphertext would look safer but buys almost
// nothing: the decryption key travels in the message, and messages are already at rest unencrypted in
// localStorage (CaravelMessage.plaintext), so an attacker with disk access holds the key beside the
// ciphertext either way. Storing plaintext also avoids a decrypt on every render.
export async function putBlob(
  pubkeyHex: string,
  blobKey: string,
  bytes: ArrayBuffer,
  mime: string
): Promise<boolean> {
  if (!pubkeyHex || !blobKey) return false
  const record: BlobRecord = {
    id: blobCacheKey(pubkeyHex, blobKey),
    pubkey: pubkeyHex,
    bytes,
    mime,
    size: bytes.byteLength,
    storedAt: Date.now(),
  }
  return withStore('readwrite', false, (store, done) => {
    store.put(record)
    // Only reported once the transaction COMMITS (see withStore) — a quota abort can arrive after
    // the put request itself reports success.
    done(true)
  })
}

// Read one blob back. `null` means "not cached", and DELIBERATELY does not distinguish a genuine miss
// from a read failure: the caller's response is identical either way — fetch it.
export async function getBlob(pubkeyHex: string, blobKey: string): Promise<CachedBlob | null> {
  if (!pubkeyHex || !blobKey) return null
  return withStore<CachedBlob | null>('readonly', null, (store, done) => {
    const request = store.get(blobCacheKey(pubkeyHex, blobKey))
    request.onsuccess = () => {
      const record = request.result as BlobRecord | undefined
      if (record) done({ bytes: record.bytes, mime: record.mime })
    }
  })
}

// Is this blob cached? Uses a key-only count so the bytes are never deserialised — the point of
// asking is usually to decide whether a fetch is needed, and materialising megabytes to answer a
// yes/no would defeat it.
export async function hasBlob(pubkeyHex: string, blobKey: string): Promise<boolean> {
  if (!pubkeyHex || !blobKey) return false
  return withStore('readonly', false, (store, done) => {
    const request = store.count(blobCacheKey(pubkeyHex, blobKey))
    request.onsuccess = () => done(request.result > 0)
  })
}

// Purge a specific set of blobs for one identity — the conversation/group delete path.
//
// Called with keys harvested from the doomed messages BEFORE those rows are removed, exactly as
// deleteConversation already harvests `utxoIds` for removeResolvedAmounts. Absent keys are ignored,
// so it is idempotent and safe to call with a list that includes non-image messages' undefined keys
// already filtered out.
//
// NOT wired to leaveGroup/declineGroup, deliberately: those are non-destructive (the messages are
// KEPT, hidden by state, so a re-invite reads as old thread + gap + new). Purging there would leave
// preserved history with permanently broken images. Only the destructive paths purge.
//
// Resolves when the transaction commits, but callers are expected to fire it and move on: the delete
// paths in WalletContext are synchronous and must not wait on a best-effort cleanup of a
// non-authoritative cache.
export async function deleteBlobs(pubkeyHex: string, blobKeys: string[]): Promise<void> {
  if (!pubkeyHex || blobKeys.length === 0) return
  await withStore<void>('readwrite', undefined, (store, done) => {
    for (const blobKey of blobKeys) {
      if (blobKey) store.delete(blobCacheKey(pubkeyHex, blobKey))
    }
    done(undefined)
  })
}

// Drop every blob belonging to one identity. Not called by any current path — it exists for a wallet
// reset / identity teardown, the case the localStorage stores handle by simply orphaning their keys
// (there is no `caravel.*` sweep anywhere in the app). Cheap to provide now because the index is
// already there; leaving megabytes of another identity's images stranded would be worse than
// leaving a few stranded JSON strings.
export async function deleteAllForIdentity(pubkeyHex: string): Promise<void> {
  if (!pubkeyHex) return
  await withStore<void>('readwrite', undefined, (store, done) => {
    // openKeyCursor, not openCursor: we only need each match's PRIMARY key to delete it, and reading
    // the full records would deserialise every blob's bytes just to throw them away.
    //
    // The bare key is passed rather than IDBKeyRange.only(pubkeyHex) — a plain value is defined to
    // mean exactly that, and IDBKeyRange is a SEPARATE global from indexedDB. Depending on it would
    // make this the one function that needs a global the rest of the module doesn't, and (as the spec
    // for this caught) its absence would be swallowed by the catch-all below into a silent no-op.
    const request = store.index(PUBKEY_INDEX).openKeyCursor(pubkeyHex)
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        store.delete(cursor.primaryKey)
        cursor.continue()
      } else {
        done(undefined)
      }
    }
  })
}

// TEST SEAM ONLY. Drops the cached handle so a spec can swap the IndexedDB factory between cases;
// production code has no reason to call it (the handle is reset automatically on versionchange,
// abnormal close, and any failed open).
export function __resetBlobCacheForTests(): void {
  dbPromise = null
}
