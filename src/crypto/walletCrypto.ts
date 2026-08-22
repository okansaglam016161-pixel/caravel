import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import type { DerivationScheme } from './derivation'

// ── Storage schema ───────────────────────────────────────────────────────────

export interface StoredWallet {
  version: 1
  kdf: 'pbkdf2'
  iterations: number
  salt: string        // base64
  iv: string          // base64
  ciphertext: string  // base64 — AES-GCM encrypted space-joined mnemonic
  /**
   * Which derivation the stored phrase belongs to. Deliberately SEPARATE from `version` above:
   * that versions the encryption envelope (PBKDF2 + AES-GCM), this versions how the phrase becomes
   * keys, and the two change independently.
   *
   * OPTIONAL, and its absence carries meaning: every wallet written before the CipherSeed
   * migration predates the field, and nothing but BIP-39 existed then — so "no marker" is not an
   * unknown, it is a positive identification of a legacy wallet. See resolveScheme() in
   * derivation.ts, which is the only thing that should interpret this.
   */
  scheme?: DerivationScheme
}

const STORAGE_KEY = 'caravel.wallet.v1'
const KDF_ITERATIONS = 600_000  // OWASP 2023 minimum for PBKDF2-SHA-256

// ── Base64 helpers ───────────────────────────────────────────────────────────

function b64Encode(buf: Uint8Array): string {
  // btoa with fromCharCode handles binary safely for 8-bit values
  let s = ''
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
  return btoa(s)
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

// ── WebCrypto: PBKDF2 → AES-256-GCM ─────────────────────────────────────────

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    // `salt as BufferSource`: a Uint8Array IS a BufferSource at runtime (and salt is always a plain
    // ArrayBuffer-backed array), but TS 5.7's generic Uint8Array<ArrayBufferLike> default doesn't
    // structurally match BufferSource (which requires ArrayBuffer, not SharedArrayBuffer). Lib-typing
    // only — no runtime effect.
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * `scheme` is REQUIRED, and is returned as part of the same record as the ciphertext it describes —
 * not attached afterwards by the caller. A phrase and the knowledge of how to derive from it are
 * useless apart: a record that reached storage with the ciphertext but without the marker would be
 * read back as a legacy BIP-39 wallet and silently open the wrong one. Building them together makes
 * that state unrepresentable rather than merely unlikely.
 */
export async function encryptMnemonic(
  mnemonic: string,
  password: string,
  scheme: DerivationScheme,
): Promise<StoredWallet> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, KDF_ITERATIONS)
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(mnemonic),
  )
  return {
    version: 1,
    kdf: 'pbkdf2',
    iterations: KDF_ITERATIONS,
    salt: b64Encode(salt),
    iv: b64Encode(iv),
    ciphertext: b64Encode(new Uint8Array(cipherBuf)),
    scheme,
  }
}

// Throws DOMException on wrong password (AES-GCM authentication fails → OperationError)
export async function decryptMnemonic(stored: StoredWallet, password: string): Promise<string> {
  const salt = b64Decode(stored.salt)
  const iv = b64Decode(stored.iv)
  const ciphertext = b64Decode(stored.ciphertext)
  const key = await deriveKey(password, salt, stored.iterations)
  // `iv` and `ciphertext` as BufferSource: same TS 5.7 lib-typing mismatch as in deriveKey — both are
  // plain ArrayBuffer-backed Uint8Arrays (valid BufferSources); the casts reconcile the types only.
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource)
  return new TextDecoder().decode(plain)
}

// ── Mnemonic generation and validation ───────────────────────────────────────

// Returns a random 24-word BIP-39 mnemonic (256 bits of entropy)
export function createMnemonic(): string {
  return generateMnemonic(wordlist, 256)
}

export function isMnemonicValid(phrase: string): boolean {
  return validateMnemonic(phrase.trim().toLowerCase(), wordlist)
}

// Fast membership set for the BIP-39 English wordlist (built once).
const WORDSET = new Set(wordlist)

// Says WHY a phrase is invalid, so restore can distinguish (and name) the failure:
//  - 'wordlist': the first word not in the BIP-39 list (1-indexed position + the word). Drives the
//    design's "Fix word #N" affordance — there IS a specific culprit to jump to.
//  - 'checksum': every word is in the list but the 24-word checksum doesn't verify. No single
//    culprit, so the UI shows a variant message without a word number ("Back", not "Fix").
// The boolean isMnemonicValid above is left untouched; this is additive.
export type MnemonicDetail =
  | { valid: true }
  | { valid: false; kind: 'wordlist'; index: number; word: string }
  | { valid: false; kind: 'checksum' }

export function validateMnemonicDetail(phrase: string): MnemonicDetail {
  const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (!WORDSET.has(words[i])) return { valid: false, kind: 'wordlist', index: i + 1, word: words[i] }
  }
  if (validateMnemonic(words.join(' '), wordlist)) return { valid: true }
  return { valid: false, kind: 'checksum' }
}

// ── Mnemonic → Tari SecretKeyWallet ─────────────────────────────────────────
// LEGACY (BIP-39) ONLY. The derivation itself now lives in legacyBip39.ts, moved there verbatim so
// that pre-migration wallets keep deriving exactly the bytes they always have. Re-exported here so
// existing importers — and the anchor tests that pin this behaviour — keep working untouched.
// DELETE THIS BLOCK, AND legacyBip39.ts, WHEN BIP-39 SUPPORT IS DROPPED FOR MAINNET.
export { seedFromMnemonic, walletFromSeed, walletFromMnemonic } from './legacyBip39'

// ── localStorage helpers ─────────────────────────────────────────────────────

export function hasStoredWallet(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null
}

/** The envelope versions this build knows how to open. */
const SUPPORTED_VERSIONS = [1]

/**
 * Returns null when there is no wallet, and THROWS when there is one this build cannot safely open
 * — a record written by a newer Caravel, or one that has been corrupted.
 *
 * The distinction matters. Returning null for an unreadable-but-present record would look exactly
 * like "no wallet here" and send the user to the create screen, where making a new wallet would
 * overwrite the record they could not open. Failing loudly keeps the bytes on disk and gives them
 * something to act on.
 */
export function loadStoredWallet(): StoredWallet | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Your saved wallet on this device is unreadable. Restore from your recovery phrase.')
  }

  const stored = parsed as StoredWallet
  if (!SUPPORTED_VERSIONS.includes(stored?.version)) {
    throw new Error(
      `This wallet was saved by a newer version of Caravel (format ${String(stored?.version)}). Update Caravel, or restore from your recovery phrase.`,
    )
  }
  return stored
}

/**
 * Adds a resolved derivation marker to a record that predates the field, leaving the ciphertext and
 * every other field exactly as they are. Used only by the self-heal path in resolveScheme(); it
 * re-labels an existing record and never re-encrypts, so it cannot disturb a working wallet.
 */
export function markScheme(stored: StoredWallet, scheme: DerivationScheme): StoredWallet {
  return { ...stored, scheme }
}

export function saveStoredWallet(stored: StoredWallet): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
}
