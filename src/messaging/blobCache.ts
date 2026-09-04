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
//   - no store key (locked, or a re-minted salt)              → reads miss and writes are refused;
//     never a plaintext fallback. See ENCRYPTED AT REST below.
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
// ── ENCRYPTED AT REST (stage 5) ──────────────────────────────────────────────────
//
// THE LAST STORE, and the one whose own reasoning had gone stale. This module used to argue that
// caching DECRYPTED bytes bought nothing, because the AES key for every image travels in the message
// and messages sat in localStorage in the clear — so an attacker with disk access held the key
// beside the ciphertext either way. THAT PREMISE DIED IN STAGE 3: messageStore is sealed now, and
// MediaRef.key with it, which left these cached images the weakest thing on disk. The dead argument
// is kept at putBlob rather than deleted — it was correct when written, and a later commit
// falsified it.
//
// AES-256-GCM VIA crypto.subtle, NOT the XChaCha envelope in storeCrypto — the one store that does
// not use it. storeCrypto is synchronous and string-shaped, both right for the stores it protects
// and wrong for this one: base64 would inflate every image by a third and copy megabytes through a
// JS string, and the synchronous-ness that forced @noble buys nothing here, because every caller of
// this module already awaits. WebCrypto takes ArrayBuffers directly and is hardware-accelerated.
//
// THE NONCE COUNTING ARGUMENT, which storeCrypto deliberately chose a cipher to AVOID having to make
// per store: random 96-bit GCM nonces are safe to order 2^32 invocations under one key. A put here
// happens once per distinct image sent or viewed, under a key that lives one unlocked session.
// Thousands against billions — not a close call, but made explicitly rather than assumed.
//
// mime STAYS IN THE CLEAR: it is needed to rebuild the Blob, and the ciphertext length already
// reveals more than "this is a jpeg". It is bound into the record as GCM additional authenticated
// data together with the composite id, so a record moved to another identity or given a different
// mime fails to decrypt rather than opening. The identity separation blobCacheKey establishes by
// convention is therefore enforced by the cipher as well.
//
// NO STORE KEY MEANS A MISS, NEVER PLAINTEXT. Writes are refused and reads report nothing cached,
// which is exactly the degradation this module already promises for every other failure. THE TWO
// PURGES DELIBERATELY DO NOT REQUIRE A KEY — the inverse of the never-clobber rule the localStorage
// stores follow. There, a write could destroy a record we could not read; here, destroying it IS
// the operation.

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

import { getStoreKey } from '../crypto/sessionKey'

// A schema change here is a CACHE RESET, not a migration — every entry is re-fetchable, so there is
// never an upgrade path to carry. But the reset has to DESTROY the old records, which is why the
// name is frozen and the SCHEMA VERSION carries the change instead. Renaming would be the easier
// way to an empty database — a new name is empty by definition — and it would ORPHAN the old one:
// v1 holds the plaintext images this stage exists to remove, left on disk with nothing that would
// ever delete them. A version bump reaches the same emptiness by CLEARING IN PLACE, inside the
// upgrade transaction. `.v1.` still matches the versioning in every localStorage key
// (caravel.<name>.v1.<pubkeyHex>).
const DB_NAME = 'caravel.blobs.v1'
// 1 → 2 (stage 5): the same object store and the same index, but every value is now sealed. v1
// records are plaintext and are dropped rather than migrated — see onupgradeneeded.
const DB_VERSION = 2
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
  v: 2                  // envelope version. v1 records had no such field and held plaintext bytes
  nonce: ArrayBuffer    // 12-byte GCM nonce, fresh per put
  bytes: ArrayBuffer    // CIPHERTEXT, with the 128-bit GCM tag appended
  mime: string          // in the clear, and bound into the ciphertext as AAD
  size: number          // PLAINTEXT length — unchanged meaning, for the sweep the header anticipates
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
    try { request = factory.open(DB_NAME, DB_VERSION) } catch { resolve(null); return }

    request.onupgradeneeded = event => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex(PUBKEY_INDEX, 'pubkey', { unique: false })
        return
      }
      // v1 → v2 (stage 5). THE STORE EXISTS AND EVERY RECORD IN IT IS A PLAINTEXT IMAGE. They are
      // re-fetchable by construction — the message row holds MediaRef.url/key/nonce/x, and that row
      // is itself sealed — so the migration is to DELETE them, here, inside the version-change
      // transaction that runs before any read can see them.
      //
      // LAZY PER-RECORD MIGRATION WAS THE ALTERNATIVE AND IS STRICTLY WORSE HERE. A blob is only
      // read when its image is viewed, so every thread the user never reopens would keep its
      // plaintext indefinitely — paymentResolutionStore's gap in stage 4, but in megabytes. The
      // eager sweep that would close it reads, re-encrypts and rewrites every cached image on an
      // unlock, spending real work to avoid one HTTP GET.
      //
      // THE COST, STATED: images the user reopens are downloaded once more, so the blob host briefly
      // sees requests for pictures it had already served. One time, and only for images actually
      // viewed again.
      if (event.oldVersion < 2) {
        // `request.transaction` is the version-change transaction — the only one allowed to touch
        // the store here. A throw leaves it to abort, which fails the open, which is the module's
        // existing "cache is off" degradation rather than a crash.
        try { request.transaction?.objectStore(STORE).clear() } catch { /* upgrade aborts; open fails */ }
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

// ── Sealing ───────────────────────────────────────────────────────────────────

/** GCM's standard nonce width, and what mediaCrypto and walletCrypto use for the same primitive. */
const NONCE_BYTES = 12

// The imported form of the session store key. getStoreKey() hands out RAW BYTES — sessionKey derives
// via deriveBits precisely so the localStorage stores can feed a synchronous cipher — and
// crypto.subtle needs a CryptoKey, so there is one import per key. Cached here rather than paid on
// every image.
//
// KEYED ON REFERENCE IDENTITY of the raw array, not on its contents: sessionKey holds one Uint8Array
// for the life of a session, so `===` is exact and free. A re-derived but byte-identical key simply
// costs one more import — correct but slower, never wrong.
let importedKey: { raw: Uint8Array; key: CryptoKey } | null = null

/**
 * The live sealing key, or null while the wallet is locked.
 *
 * EVERY OPERATION THAT TOUCHES BYTES GOES THROUGH HERE FIRST, and the null case drops the cached
 * import. That matters: a CryptoKey holds its own copy of the material, so clearStoreKey's fill(0)
 * cannot reach it, and without this the cache would happily keep decrypting after a lock. Honest
 * scope — that is the same defence in depth as the memset itself, not erasure, since nothing
 * guarantees the engine kept only one copy.
 */
async function sealingKey(): Promise<CryptoKey | null> {
  const raw = getStoreKey()
  if (raw === null) { importedKey = null; return null }
  if (importedKey !== null && importedKey.raw === raw) return importedKey.key
  try {
    // `raw as BufferSource`: the same lib-typing reconciliation walletCrypto and mediaCrypto both
    // document — a Uint8Array IS a BufferSource at runtime. No runtime effect.
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
    importedKey = { raw, key }
    return key
  } catch {
    return null   // no crypto.subtle (an insecure origin) — the cache is simply off
  }
}

/**
 * What the ciphertext is bound to: the composite primary key, and the mime type.
 *
 * Both travel in the clear on the record, and AAD is what stops them being edited underneath it.
 * Moving a record to another identity's id, or swapping its mime, makes the tag check fail — so the
 * identity separation blobCacheKey establishes by convention is enforced by the cipher too.
 */
function aad(id: string, mime: string): BufferSource {
  // Returned as BufferSource rather than Uint8Array: the same lib-typing reconciliation the raw key
  // needs above — TS's generic Uint8Array<ArrayBufferLike> does not structurally match. No runtime
  // effect.
  return new TextEncoder().encode(`${id}\n${mime}`) as BufferSource
}

// ── Public API ────────────────────────────────────────────────────────────────

// Cache one blob, sealed. Returns whether it was actually stored — false means quota, unavailable
// storage, an eviction race, or a locked wallet, ALL of which are fine: the caller already holds
// these bytes in memory, and a later view re-fetches. Overwriting an existing key is a no-op refresh.
//
// ⚠️ THE ARGUMENT THIS FUNCTION USED TO MAKE, KEPT BECAUSE IT WAS TRUE WHEN WRITTEN AND IS NOT ANY
// MORE: "Bytes are stored DECRYPTED, deliberately. Caching ciphertext would look safer but buys
// almost nothing: the decryption key travels in the message, and messages are already at rest
// unencrypted in localStorage (CaravelMessage.plaintext), so an attacker with disk access holds the
// key beside the ciphertext either way."
//
// STAGE 3 SEALED messageStore, and MediaRef.key with it. The key no longer sits beside the
// ciphertext, so the second half of that sentence is false and the conclusion falls with it — these
// cached images became the only plaintext left. The trade the old note also claimed, avoiding a
// decrypt, was overstated: the decrypt is per cache READ, not per render (useMediaResolution
// resolves once and holds the bytes; the object URL is what re-renders), and it is WebCrypto AES on
// an ArrayBuffer against the alternative of a network round trip.
export async function putBlob(
  pubkeyHex: string,
  blobKey: string,
  bytes: ArrayBuffer,
  mime: string
): Promise<boolean> {
  if (!pubkeyHex || !blobKey) return false
  const key = await sealingKey()
  if (key === null) return false   // locked — one cache miss later, never plaintext on disk

  const id = blobCacheKey(pubkeyHex, blobKey)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  let sealed: ArrayBuffer
  try {
    // OUTSIDE THE TRANSACTION, AND IT HAS TO BE: an IndexedDB transaction closes as soon as the
    // microtask queue drains with no request pending, so an await inside `run` below would lose it.
    // Encrypt first, store second. getBlob is the mirror image — it decrypts after the commit.
    sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(id, mime) }, key, bytes)
  } catch {
    return false   // not a BufferSource, or WebCrypto refused — same degradation as a failed write
  }

  const record: BlobRecord = {
    id,
    pubkey: pubkeyHex,
    v: 2,
    nonce: nonce.buffer,
    bytes: sealed,
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

// Read one blob back, decrypting it. `null` means "not cached", and DELIBERATELY does not
// distinguish a genuine miss from a read failure, a locked wallet or an undecryptable record: the
// caller's response is identical in every case — fetch it.
//
// The decrypt happens AFTER the transaction commits, for the reason putBlob encrypts before its own
// opens: nothing may await inside an IndexedDB transaction. So withStore hands back the sealed
// record and the crypto runs out here.
export async function getBlob(pubkeyHex: string, blobKey: string): Promise<CachedBlob | null> {
  if (!pubkeyHex || !blobKey) return null
  const key = await sealingKey()
  if (key === null) return null

  const record = await withStore<BlobRecord | null>('readonly', null, (store, done) => {
    const request = store.get(blobCacheKey(pubkeyHex, blobKey))
    request.onsuccess = () => {
      const result = request.result as BlobRecord | undefined
      if (result) done(result)
    }
  })
  // A v1 record should be unreachable — the upgrade cleared them before any read could see one —
  // but a record without the envelope holds PLAINTEXT, and handing that back as though it had been
  // opened would quietly undo the stage. Belt and braces, and it costs one comparison.
  if (record === null || record.v !== 2) return null

  try {
    return {
      bytes: await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.nonce, additionalData: aad(record.id, record.mime) },
        key,
        record.bytes,
      ),
      mime: record.mime,
    }
  } catch {
    // A wrong key (a re-minted salt, another identity), an edited mime or id, or corrupt bytes — all
    // land here as a tag mismatch rather than as garbage output, which is what makes the miss safe.
    //
    // THE RECORD IS LEFT ON DISK, deliberately. Deleting would make a read path destructive over
    // what may be a transient key state, and keeping it costs one stale entry the browser evicts
    // under pressure anyway. A miss simply re-downloads; deleteAllForIdentity exists for the rest.
    return null
  }
}

// Is this blob cached? Uses a key-only count so the bytes are never deserialised — the point of
// asking is usually to decide whether a fetch is needed, and materialising megabytes to answer a
// yes/no would defeat it.
export async function hasBlob(pubkeyHex: string, blobKey: string): Promise<boolean> {
  if (!pubkeyHex || !blobKey) return false
  // A key-only count could answer truthfully with no store key — the record either exists or it does
  // not. But answering `true` where getBlob would return null promises a read this module cannot
  // honour, so the two agree instead.
  if (await sealingKey() === null) return false
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
// NEEDS NO STORE KEY, unlike every read and write above — the inverse of the never-clobber rule the
// localStorage stores follow. There, writing over a record we could not read destroys it; here that
// destruction IS the operation, and refusing to purge while locked would only strand bytes.
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
// leaving a few stranded JSON strings. Takes no store key, for the same reason deleteBlobs does not.
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

// TEST SEAM ONLY. Drops the cached handle AND the imported key so a spec can swap the IndexedDB
// factory or the store key between cases; production code has no reason to call it (the handle is
// reset automatically on versionchange, abnormal close and any failed open, and the key import is
// re-checked against getStoreKey() on every operation).
export function __resetBlobCacheForTests(): void {
  dbPromise = null
  importedKey = null
}
