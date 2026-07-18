import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { Network } from '@tari-project/ootle'

// ── Storage schema ───────────────────────────────────────────────────────────

export interface StoredWallet {
  version: 1
  kdf: 'pbkdf2'
  iterations: number
  salt: string        // base64
  iv: string          // base64
  ciphertext: string  // base64 — AES-GCM encrypted space-joined mnemonic
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
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptMnemonic(mnemonic: string, password: string): Promise<StoredWallet> {
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
  }
}

// Throws DOMException on wrong password (AES-GCM authentication fails → OperationError)
export async function decryptMnemonic(stored: StoredWallet, password: string): Promise<string> {
  const salt = b64Decode(stored.salt)
  const iv = b64Decode(stored.iv)
  const ciphertext = b64Decode(stored.ciphertext)
  const key = await deriveKey(password, salt, stored.iterations)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
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

// ── Mnemonic → Tari SecretKeyWallet ─────────────────────────────────────────
// BIP-39 seed (64 bytes via PBKDF2-HMAC-SHA512) → first 32 bytes = owner key,
// next 32 bytes = view-only key. Both halves are domain-separated by BIP-39's
// own derivation and by their position in the seed, making the derivation
// deterministic and resistant to key reuse between the two roles.

// Ristretto255 scalar field order (little-endian). A secret key must be in [0, L).
// Raw BIP-39 seed bytes fail ~9% of the time; proper hash-to-scalar (RFC 8032 §5.2.5)
// always yields a valid canonical scalar.
const RISTRETTO_L =
  7237005577332262213973186563042994240857116359379907606001950938285454250989n

function reduceModL(bytes: Uint8Array): Uint8Array {
  // Interpret bytes as a little-endian unsigned integer, reduce mod L.
  let n = 0n
  for (let i = 0; i < bytes.length; i++) n += BigInt(bytes[i]) << (8n * BigInt(i))
  const s = n % RISTRETTO_L
  const out = new Uint8Array(32)
  let tmp = s
  for (let i = 0; i < 32; i++) { out[i] = Number(tmp & 0xffn); tmp >>= 8n }
  return out
}

// Derive a pair of valid Ristretto scalars from a BIP-39 seed via domain-separated
// SHA-512 → mod-L reduction. This is deterministic: same mnemonic → same scalars
// → same otl_esm_ address. Domain bytes 0x01/0x02 ensure owner ≠ view.
async function seedToOotleKeys(seed: Uint8Array): Promise<{ ownerSecretKey: Uint8Array; viewOnlySecret: Uint8Array }> {
  const ownerInput = new Uint8Array(seed.length + 1)
  ownerInput.set(seed)
  ownerInput[seed.length] = 0x01

  const viewInput = new Uint8Array(seed.length + 1)
  viewInput.set(seed)
  viewInput[seed.length] = 0x02

  const [ownerHash, viewHash] = await Promise.all([
    crypto.subtle.digest('SHA-512', ownerInput),
    crypto.subtle.digest('SHA-512', viewInput),
  ])

  return {
    ownerSecretKey: reduceModL(new Uint8Array(ownerHash)),
    viewOnlySecret: reduceModL(new Uint8Array(viewHash)),
  }
}

export async function walletFromMnemonic(mnemonic: string): Promise<SecretKeyWallet> {
  const seed = await mnemonicToSeed(mnemonic.trim().toLowerCase())
  const { ownerSecretKey, viewOnlySecret } = await seedToOotleKeys(seed)
  return SecretKeyWallet.fromSecretKey(ownerSecretKey, Network.Esmeralda, viewOnlySecret)
}

// ── localStorage helpers ─────────────────────────────────────────────────────

export function hasStoredWallet(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null
}

export function loadStoredWallet(): StoredWallet | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredWallet
  } catch {
    return null
  }
}

export function saveStoredWallet(stored: StoredWallet): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
}
