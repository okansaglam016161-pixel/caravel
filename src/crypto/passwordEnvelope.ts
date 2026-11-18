// A string, encrypted under a password: PBKDF2-SHA-256 (600 000 iterations) → AES-256-GCM.
//
// The chat identity record's envelope (crypto/chatIdentityStore).
//
// A wrong password is not distinguishable from a damaged ciphertext: AES-GCM authentication fails
// either way, and openWithPassword throws. Callers say "wrong password" because that is by far the
// likelier cause, and because neither case leaks anything.

import { b64Decode, b64Encode } from './base64'

export const ENVELOPE_ITERATIONS = 600_000   // OWASP 2023 minimum for PBKDF2-SHA-256

export interface PasswordEnvelope {
  kdf: 'pbkdf2'
  iterations: number
  salt: string        // base64, 16 bytes
  iv: string          // base64, 12 bytes
  ciphertext: string  // base64, AES-GCM (tag appended)
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    // `as BufferSource`: a plain ArrayBuffer-backed Uint8Array IS one at runtime; lib-typing only.
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function sealWithPassword(plaintext: string, password: string, iterations = ENVELOPE_ITERATIONS): Promise<PasswordEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, iterations)
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return { kdf: 'pbkdf2', iterations, salt: b64Encode(salt), iv: b64Encode(iv), ciphertext: b64Encode(new Uint8Array(cipher)) }
}

/** Throws on a wrong password (or a damaged envelope) — AES-GCM authentication fails. */
export async function openWithPassword(env: PasswordEnvelope, password: string): Promise<string> {
  const key = await deriveKey(password, b64Decode(env.salt), env.iterations)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64Decode(env.iv) as BufferSource },
    key,
    b64Decode(env.ciphertext) as BufferSource,
  )
  return new TextDecoder().decode(plain)
}
