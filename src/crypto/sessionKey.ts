// The STORE KEY — a session-lived symmetric key for encrypting Caravel's local stores at rest.
//
// ── WHAT THIS MODULE IS NOW: THE KEY'S LIFETIME, NOT ITS DERIVATION ──────────
//
// The key is DERIVED IN derivation.ts, from the wallet's own seed — see storeKeyFromSeedMaterial
// there. What is left here is the part that was always right: holding one key for the length of an
// unlocked session, handing it to the stores that ask, and dropping it on lock.
//
// Everything below the lifecycle is MIGRATION-ONLY and goes in S3. It exists to read the old
// `caravel.storekey.v1` record and re-derive the key the stores were sealed with BEFORE the change,
// so the transition loses nothing. Nothing writes that record any more.
//
// ── WHY MODULE STATE AND NOT REACT STATE ─────────────────────────────────────
//
// The eventual consumers are all called from OUTSIDE React: journalStore's write path (invoked by
// send/move/faucet call sites that never go through a setter), journalSnapshot() behind
// useSyncExternalStore, and addReceivedMessage() from inside a React state updater. A context value
// would be unreachable from precisely the places that need it. Module scope is what those stores
// already use for the same reason — see journalStore's `listeners`/`cachedEntries`, and
// WalletContext's own nostrSecretKeyRef.
//
// ── WHY THERE IS NO LONGER A SALT OF ITS OWN ─────────────────────────────────
//
// There used to be: one random salt in localStorage, and a store key of PBKDF2(password, salt). The
// argument for it was real — the store key and the seed key had to be independent derivations, so
// that recovering one did not hand over the other. What that argument missed is what happens to the
// salt.
//
// ONE SALT, SHARED BY EVERY WALLET ON THE DEVICE, RE-MINTED ON EVERY RESTORE. So restoring a second
// wallet silently stranded the first one's messages, contacts, nicknames, groups, journal and
// transaction history: sealed under a key whose only input had just been overwritten. No detection,
// no signal, no way back. Restoring the SAME wallet did it too, because restore always mints a new
// password and a new salt.
//
// The key now comes from the wallet's OWN SEED, so every wallet has its own, nothing is shared, and
// a phrase always re-derives the key its data was sealed with. Independence is kept — a hash under
// Caravel's store domain is not the seed key and cannot be walked back to it — without a stored
// input that can be lost.
//
// IT ALSO COSTS NOTHING. The old design paid a second 600 000-iteration PBKDF2 on every unlock; the
// new one is a Blake2b over material deriveIdentity already holds, so unlock does one key derivation
// where it used to do two.

import { b64Decode } from './base64'

// ── The parameters record ────────────────────────────────────────────────────

/**
 * MIGRATION-ONLY — DELETED IN S3, ALONG WITH THE RECORD IT DESCRIBES.
 *
 * The shape of the retired `caravel.storekey.v1` record. Nothing writes it any more; it is read so
 * that S3 can derive the key a device's stores were sealed with before the change and re-seal them
 * under the seed-derived one.
 *
 * PARAMETERS ONLY, NEVER KEY MATERIAL — a salt and a work factor, both public inputs to the KDF.
 * `iterations` is read from the RECORD rather than a constant, which is what lets an old record
 * still derive the key it was written with.
 */
export interface StoreKeyParams {
  version: 1
  kdf: 'pbkdf2'
  iterations: number
  salt: string        // base64, 16 random bytes
}

const STORAGE_KEY = 'caravel.storekey.v1'

/** 256-bit key — the width storeCrypto's XChaCha20-Poly1305 takes. */
const KEY_BYTES = 32

/** The record versions this build knows how to read. */
const SUPPORTED_VERSIONS = [1]

/**
 * MIGRATION-ONLY — DELETED IN S3.
 *
 * The retired parameters record, or `null` when there is none this build can use. Present only so
 * the S3 migration can re-derive the OLD key and re-seal what it opens.
 *
 * THE NOTE THAT USED TO SIT HERE has been answered rather than deleted, because it was right. It
 * said: revisit this at the stage that first encrypts a store, because from that point a lost or
 * re-minted salt means stores that can no longer be decrypted, and the quiet remint becomes a
 * data-loss path. Six stages encrypted ten stores past it, the data-loss path duly arrived, and the
 * answer turned out not to be a better-guarded salt but no salt at all — see the header.
 *
 * It still returns null rather than throwing, which no longer needs a justification: after S3 there
 * is nothing here to guard.
 */
export function loadKeyParams(): StoreKeyParams | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null   // private mode / storage disabled
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const params = parsed as StoreKeyParams
  if (!SUPPORTED_VERSIONS.includes(params?.version)) return null
  if (typeof params.salt !== 'string' || !params.salt) return null
  if (typeof params.iterations !== 'number' || !Number.isFinite(params.iterations) || params.iterations < 1) return null
  return params
}

// RETIRED WITH THE SALT: saveKeyParams, newKeyParams and ensureKeyParams. Nothing mints or writes
// `caravel.storekey.v1` any more — a wallet's key comes from its own seed, so there is no device-wide
// parameter to create, persist, or accidentally replace. The reader above stays until S3 has finished
// converting the records that were sealed while they existed.

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * MIGRATION-ONLY — DELETED IN S3.
 *
 * password + params → 32 raw key bytes: the OLD derivation, kept so S3 can open what it sealed. The
 * live derivation is storeKeyFromSeedMaterial in derivation.ts and takes no password at all.
 *
 * RAW BYTES, VIA deriveBits — and that is the one real difference from walletCrypto's deriveKey,
 * which produces a non-extractable CryptoKey. That form is right for a key that only ever feeds
 * crypto.subtle. This key must eventually feed a SYNCHRONOUS cipher, because the stores it will
 * protect are read inside useSyncExternalStore snapshots and React state updaters, neither of which
 * can await. Same KDF, same parameters, different output form — the same "same conventions,
 * different key model" relationship mediaCrypto has with walletCrypto.
 *
 * `iterations` comes from the RECORD, never from the constant, so a record written at an older work
 * factor still derives the key it was written with.
 */
export async function deriveStoreKey(password: string, params: StoreKeyParams): Promise<Uint8Array> {
  const salt = b64Decode(params.salt)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  // `salt as BufferSource`: the same TS lib-typing reconciliation walletCrypto documents — a
  // Uint8Array IS a BufferSource at runtime, but TS's generic Uint8Array<ArrayBufferLike> default
  // does not structurally match it. No runtime effect.
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: params.iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

// ── Session state ────────────────────────────────────────────────────────────

let storeKey: Uint8Array | null = null

/** The live store key, or `null` while locked. */
export function getStoreKey(): Uint8Array | null {
  return storeKey
}

export function hasStoreKey(): boolean {
  return storeKey !== null
}

/**
 * Adopt a derived key for this session. Called by create, unlock and restore — always BEFORE
 * adoptIdentity, so that no store read can ever observe an unlocked wallet with no key.
 */
export function setStoreKey(key: Uint8Array): void {
  storeKey = key
}

/**
 * Drop the key. Called from lock(), beside the other identity clears.
 *
 * The buffer is zeroed first. HONESTLY, THAT IS DEFENCE IN DEPTH AND NOT ERASURE: JavaScript offers
 * no guarantee that this is the only copy — a garbage collector may have moved the array, and the
 * password it came from was a JS string that cannot be wiped at all. It costs one memset and closes
 * the most obvious case (a heap snapshot taken after lock), which is worth having as long as nobody
 * reads it as a stronger promise than it is.
 */
export function clearStoreKey(): void {
  storeKey?.fill(0)
  storeKey = null
}
