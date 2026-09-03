// The AT-REST ENVELOPE for Caravel's local stores — seal a JSON string, open it again.
//
// Stage 2 of the encryption-at-rest work. Stage 1 (sessionKey.ts) made a store key exist for the
// unlocked session; this is the thing that uses it. journalStore is the only consumer today; the
// remaining stores adopt it in later stages, which is why this module knows nothing about journals.
//
// ── SYNCHRONOUS, AND THAT IS THE WHOLE REASON IT IS NOT crypto.subtle ────────
//
// The stores this protects are read from places that cannot await: journalSnapshot() behind
// useSyncExternalStore, whose getSnapshot contract is synchronous, and messageStore's
// addReceivedMessage() from inside a React state updater, which must stay pure and sync. WebCrypto
// is async-only, so an envelope built on it would force every one of those call sites to change.
// @noble/ciphers is synchronous, already a pinned direct dependency (2.3.0), and its chacha module
// is ALREADY IN THE BUNDLE — nostr-tools pulls it for NIP-17/NIP-44 — so this costs approximately
// nothing to ship.
//
// ── XCHACHA20-POLY1305, WHERE THE REST OF THE APP USES AES-256-GCM ───────────
//
// A DELIBERATE INCONSISTENCY, recorded here so it is not read as an oversight. walletCrypto (the
// mnemonic) and mediaCrypto (image attachments) both use AES-256-GCM, and matching them would have
// been the tidier choice.
//
// The reason not to: GCM's 96-bit nonce makes random-nonce safety an argument about how many times
// a key is used, and this envelope is generic. It is fine for the journal — a handful of writes per
// session — but a later stage puts messageStore behind it, and that writes on every message
// arrival. XChaCha's 192-bit nonce removes the question by construction, once, for every store that
// adopts this, instead of requiring the counting argument to be re-made per store.
//
// Nonce reuse under a fixed key is catastrophic for both constructions; the difference is only
// whether avoiding it needs thought. Here it does not.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { b64Decode, b64Encode } from './base64'

/** XChaCha20-Poly1305 nonce width. 192 bits — see the header for why this size was chosen. */
const NONCE_BYTES = 24

/**
 * The sealed record, as it sits in localStorage.
 *
 * Short field names on purpose: this is rewritten on every save of the whole store, and base64
 * already inflates the payload by a third.
 */
export interface SealedRecord {
  v: 2
  n: string    // base64 nonce
  ct: string   // base64 ciphertext, with the Poly1305 tag appended
}

/**
 * What a stored value turned out to be.
 *
 * THE THIRD STATE IS THE IMPORTANT ONE, and it exists to close a silent data-loss path rather than
 * to be thorough. Without it, "could not read" and "nothing there" collapse into one answer, and a
 * store whose key is present but WRONG — a re-minted salt — reads as empty, appends one row to that
 * emptiness, encrypts it perfectly well with the wrong key, and overwrites the entire history it
 * could not read. Separating `unreadable` from `empty` is what lets a caller refuse to write over
 * bytes it did not understand. See journalStore's save().
 */
export type OpenResult =
  | { status: 'ok'; json: string }
  | { status: 'empty' }
  | { status: 'unreadable' }

/**
 * Is this parsed value one of our envelopes?
 *
 * THE DISCRIMINATOR THE MIGRATION RESTS ON. A stored value that does not have this shape is v1
 * plaintext — the format every store used before this module existed — and absence of the version
 * field positively identifies it, the same way a missing `scheme` positively identifies a
 * pre-CipherSeed wallet in walletCrypto.
 *
 * THIS REQUIRES THAT NO STORE'S PLAINTEXT SHAPE HAS A TOP-LEVEL `v`. True across all of them today:
 * the journal is an array, the epoch is keyed startedAt/degradedAt/covers, every messaging store is
 * a hex-keyed map, and StoredWallet uses `version` rather than `v`. A future store that breaks this
 * would be read as a corrupt envelope rather than as its own contents, so keep it true.
 */
function isSealed(parsed: unknown): parsed is SealedRecord {
  if (typeof parsed !== 'object' || parsed === null) return false
  const r = parsed as Partial<SealedRecord>
  return r.v === 2 && typeof r.n === 'string' && typeof r.ct === 'string'
}

/**
 * Encrypt a JSON string into the value to store. Fresh random nonce every call.
 *
 * Takes and returns STRINGS rather than objects, so each store keeps control of its own
 * serialisation — the journal's bigint-to-decimal-string mapping stays in the journal, where its
 * tests already pin it.
 */
export function seal(key: Uint8Array, plaintextJson: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(plaintextJson))
  const record: SealedRecord = { v: 2, n: b64Encode(nonce), ct: b64Encode(ct) }
  return JSON.stringify(record)
}

/**
 * Read a stored value, whichever format it is in.
 *
 * NEVER THROWS. Every failure — absent, malformed, wrong key, missing key — comes back as a status,
 * because the callers are store load paths whose existing contract is to degrade to empty rather
 * than to propagate.
 *
 * LEGACY PASSTHROUGH DOES NOT CONSULT THE KEY, and that is not a gap: there is nothing to decrypt,
 * and this function cannot protect bytes that are already plaintext on disk. It is also what makes
 * lazy migration work — an existing journal reads on a device that has only just derived its first
 * store key, and re-emits sealed on the next write.
 */
export function open(key: Uint8Array | null, stored: string | null): OpenResult {
  if (stored === null || stored === '') return { status: 'empty' }

  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return { status: 'unreadable' }
  }

  // v1 — plaintext, exactly as every store wrote it before this module existed.
  if (!isSealed(parsed)) return { status: 'ok', json: stored }

  // v2 — sealed. A missing key is `unreadable`, never an empty read: see OpenResult.
  if (key === null) return { status: 'unreadable' }

  try {
    const plain = xchacha20poly1305(key, b64Decode(parsed.n)).decrypt(b64Decode(parsed.ct))
    return { status: 'ok', json: new TextDecoder().decode(plain) }
  } catch {
    // A wrong key fails here, as a Poly1305 tag mismatch, rather than yielding garbage. That
    // authentication is what makes `unreadable` trustworthy enough to gate a write on.
    return { status: 'unreadable' }
  }
}
