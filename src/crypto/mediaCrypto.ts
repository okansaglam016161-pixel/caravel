// AES-256-GCM for image attachments (M2). Same primitive, same conventions as walletCrypto.ts —
// 12-byte nonce from crypto.getRandomValues, base64 for key material, the `as BufferSource` casts
// below — but a different key model: walletCrypto DERIVES its key from a password (PBKDF2), while
// every image gets a fresh RANDOM key that travels to the recipient inside the gift wrap.
//
// The security boundary is the GCM auth tag. It authenticates the ciphertext under the key, so a
// blob host that alters, truncates or substitutes bytes produces a decrypt failure, not corrupt
// output. Everything else here — the `x` hash in particular — is about giving better errors sooner,
// not about integrity; see verifyCiphertextHash.
//
// No new dependency: crypto.subtle is already used for the mnemonic (AES-GCM) and for SHA-512 in
// the wallet key derivation.

import { b64Decode, b64Encode } from './base64'

// 96 bits, the GCM standard nonce size and what walletCrypto uses for the same primitive.
const NONCE_BYTES = 12
// 256-bit content key.
const KEY_BYTES = 32

export interface EncryptedMedia {
  ciphertext: ArrayBuffer   // includes the appended 128-bit GCM tag
  keyB64: string            // base64, → kind 15's `decryption-key`
  nonceB64: string          // base64, → kind 15's `decryption-nonce`
  x: string                 // sha256 hex of the CIPHERTEXT — the Blossom address + kind 15's `x`
  ox: string                // sha256 hex of the PLAINTEXT — kind 15's `ox`
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let hex = ''
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0')
  return hex
}

// Encrypt one image. A FRESH key AND a fresh nonce every call, never reused — with a per-image key
// a repeated nonce would in fact be harmless, but "both fresh, always" is the invariant that cannot
// be quietly broken by a later refactor, which is the failure mode that actually destroys GCM.
//
// Raw random bytes are generated and imported rather than crypto.subtle.generateKey + exportKey:
// we need the bytes on the wire anyway, so generating them directly is one step fewer and removes
// any question of whether the key is extractable.
export async function encryptMedia(plaintext: ArrayBuffer): Promise<EncryptedMedia> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  // `keyBytes as BufferSource`: a Uint8Array IS a BufferSource at runtime, but TS's generic
  // Uint8Array<ArrayBufferLike> default doesn't structurally match BufferSource (which requires
  // ArrayBuffer, not SharedArrayBuffer). Lib-typing only — no runtime effect. Same cast, same
  // reason, as walletCrypto.deriveKey.
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext)

  return {
    ciphertext,
    keyB64: b64Encode(keyBytes),
    nonceB64: b64Encode(nonce),
    x: await sha256Hex(ciphertext),
    ox: await sha256Hex(plaintext),
  }
}

// Decrypt. THROWS on failure — a wrong key, a wrong nonce, or a single altered byte all surface as
// a DOMException 'OperationError', exactly as a wrong wallet password does (see walletCrypto and
// UnlockWallet's handling). Callers classify; blossomClient maps it to `undecryptable`.
export async function decryptMedia(
  ciphertext: ArrayBuffer,
  keyB64: string,
  nonceB64: string
): Promise<ArrayBuffer> {
  const keyBytes = b64Decode(keyB64)
  const nonce = b64Decode(nonceB64)
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['decrypt'])
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ciphertext)
}

// Does this blob hash to what the message said it would?
//
// HONEST SCOPE: this is NOT the integrity boundary — the GCM tag already is, and decryptMedia fails
// on any tampering whether or not this ran. It earns its place for three lesser but real reasons:
//   1. it separates "the host served the wrong bytes" from "the key is wrong", which are different
//      messages to show a user and different things to retry;
//   2. it rejects a corrupt multi-megabyte body before spending CPU decrypting it;
//   3. in Blossom the URL IS the hash, so this checks the host honoured its own contract.
export async function verifyCiphertextHash(ciphertext: ArrayBuffer, expectedX: string): Promise<boolean> {
  if (!expectedX) return false
  return (await sha256Hex(ciphertext)) === expectedX.toLowerCase()
}
