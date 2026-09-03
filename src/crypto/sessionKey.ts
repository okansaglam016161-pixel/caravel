// The STORE KEY — a session-lived symmetric key for encrypting Caravel's local stores at rest.
//
// ⚠️ STAGE 1 OF THE ENCRYPTION-AT-REST WORK: NOTHING CONSUMES THIS YET.
//
// No store is encrypted. journalStore, messageStore, utxoLedger, txHistory and every other store
// read and write exactly the plaintext they always have. This module only makes the key EXIST, be
// derived at the right moment, and be cleared at the right moment — so that the stages which
// actually encrypt something inherit a key lifecycle that is already correct and already tested,
// rather than inventing one while also changing how data is stored.
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
// ── WHY A SALT OF ITS OWN ────────────────────────────────────────────────────
//
// The store key and the seed key are INDEPENDENT derivations from the same password. Reusing
// StoredWallet.salt would make each a deterministic function of the other — recovering one would
// hand over the other for free — and would couple the two lifecycles: re-encrypting the mnemonic,
// or raising its iteration count, would silently invalidate every encrypted store. Separate salts
// also let the store key change KDF later without touching wallet-critical code. It is the same
// separation StoredWallet already draws between `version` (the envelope) and `scheme` (the
// derivation), applied one level out.
//
// COST: one extra PBKDF2 at 600 000 iterations per unlock, so unlock does roughly twice the key
// derivation work it used to. Accepted deliberately. If it is ever felt, the cheap win is that this
// derivation is independent of deriveIdentity and the two could run under one Promise.all — not
// done here, because the ORDERING below matters more than the milliseconds.

import { b64Decode, b64Encode } from './base64'

// ── The parameters record ────────────────────────────────────────────────────

/**
 * PARAMETERS ONLY. NEVER KEY MATERIAL.
 *
 * Worth stating plainly, because a record called `storekey` sitting in localStorage invites exactly
 * the wrong assumption: this holds a salt and a work factor, both of which are public inputs to the
 * KDF. The key itself is derived from the user's password and lives only in memory, only while
 * unlocked. Nothing here is a secret, and losing it costs no confidentiality.
 *
 * Same field set and the same discipline as StoredWallet, deliberately, so the two read as
 * siblings: `iterations` is stored per record and read back from it on every derivation, which is
 * what lets the work factor rise for new wallets without orphaning existing ones.
 */
export interface StoreKeyParams {
  version: 1
  kdf: 'pbkdf2'
  iterations: number
  salt: string        // base64, 16 random bytes
}

const STORAGE_KEY = 'caravel.storekey.v1'

/** OWASP 2023 minimum for PBKDF2-SHA-256 — the same figure walletCrypto uses for the mnemonic. */
const KDF_ITERATIONS = 600_000

const SALT_BYTES = 16
/** 256-bit key, sized for the AES-256 / XChaCha20 class of cipher a later stage will use. */
const KEY_BYTES = 32

/** The record versions this build knows how to read. */
const SUPPORTED_VERSIONS = [1]

/**
 * The stored parameters, or `null` when there are none this build can use — absent, unparseable, or
 * written by a newer Caravel.
 *
 * RETURNS NULL RATHER THAN THROWING, which is the OPPOSITE of loadStoredWallet and is a considered
 * difference. That function throws because an unreadable wallet record must not be mistaken for
 * "no wallet" and send the user to a create screen that would overwrite irreplaceable ciphertext.
 * This record holds regenerable parameters and guards nothing: at this stage the worst case of
 * re-minting is that a salt changes while no store depends on it, which costs exactly nothing.
 *
 * REVISIT AT THE STAGE THAT FIRST ENCRYPTS A STORE. From that point a lost or re-minted salt means
 * stores that can no longer be decrypted, and this quiet remint becomes a data-loss path that needs
 * a real answer. It is deliberately NOT pre-solved here.
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

export function saveKeyParams(params: StoreKeyParams): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params))
  } catch { /* quota / private mode — the next unlock re-mints */ }
}

/** A fresh record: new random salt, current work factor. Never reuses an existing salt. */
export function newKeyParams(): StoreKeyParams {
  return {
    version: 1,
    kdf: 'pbkdf2',
    iterations: KDF_ITERATIONS,
    salt: b64Encode(crypto.getRandomValues(new Uint8Array(SALT_BYTES))),
  }
}

/**
 * The device's parameters, minting and persisting them if there are none.
 *
 * THE SELF-HEAL PATH, for the unlock of a wallet that predates this record — which is every wallet
 * on a real device today. Same shape as resolveScheme's `markerWasMissing` repair: read what we
 * wrote, and write what we should have written if it is not there.
 *
 * create and restore deliberately do NOT call this — they mint fresh. See the note in
 * WalletContext: a restored wallet inheriting the replaced wallet's salt would derive the identical
 * store key whenever the password was reused, coupling two unrelated wallet records through a
 * shared parameter.
 */
export function ensureKeyParams(): StoreKeyParams {
  const existing = loadKeyParams()
  if (existing) return existing
  const fresh = newKeyParams()
  saveKeyParams(fresh)
  return fresh
}

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * password + params → 32 raw key bytes.
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
