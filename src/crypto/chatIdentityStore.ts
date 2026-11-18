// The chat identity RECORD — one per device, password-encrypted, in localStorage.
//
// Holds the three secrets the chat session needs and nothing else: the Nostr secret key, the 12-word
// phrase it came from (null when the identity was imported from an nsec), and the random storage key
// that seals the chat stores. ALL OF IT IS INSIDE THE ENVELOPE — not even the npub sits in plaintext,
// so the record does not say whose it is to anyone without the password.
//
// Read failures follow one rule: ABSENT returns null,
// but PRESENT-AND-UNREADABLE throws. Reading an unopenable record as "no identity here" would send the
// person to the create screen, where making a new identity overwrites the one they could not open.
//
// Also here: the chat history a device holds for an identity, and removing it. A re-import mints a new
// random storage key, so history sealed under the old one can never be opened again; the import flow
// offers to remove it rather than leave the stores refusing every new write (storeIo's never-clobber
// guard) for good.

import { b64Decode, b64Encode } from './base64'
import { openWithPassword, sealWithPassword, type PasswordEnvelope } from './passwordEnvelope'
import { deleteAllForIdentity } from '../messaging/blobCache'

const STORAGE_KEY = 'caravel.chat.v1'
const SUPPORTED_VERSIONS = [1]

export interface StoredChatIdentity {
  version: 1
  envelope: PasswordEnvelope
}

/** What the envelope holds, decrypted. */
export interface ChatSecrets {
  /** 32-byte secp256k1 secret, hex. */
  nostrSecretHex: string
  /** The 12-word backup phrase, or null for an identity imported from an nsec. */
  phrase: string | null
  /** The chat storage key — 32 random bytes. */
  storeKey: Uint8Array
}

interface SecretsJson { nostrSecretHex: string; phrase: string | null; storeKey: string }

export function hasChatIdentity(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== null } catch { return false }
}

/** Null when there is no record; THROWS when there is one this build cannot open. */
export function loadChatRecord(): StoredChatIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error('Your saved chat identity on this device is unreadable. Import your backup to continue.')
  }
  const rec = parsed as Partial<StoredChatIdentity> | null
  if (!rec || !SUPPORTED_VERSIONS.includes(rec.version as number)) {
    throw new Error(`This chat identity was saved by a newer version of Caravel (format ${String(rec?.version)}). Update Caravel, or import your backup.`)
  }
  if (!rec.envelope || typeof rec.envelope.ciphertext !== 'string') {
    throw new Error('Your saved chat identity on this device is unreadable. Import your backup to continue.')
  }
  return rec as StoredChatIdentity
}

/** Encrypt and store, REPLACING any record already here. */
export async function saveChatIdentity(secrets: ChatSecrets, password: string): Promise<void> {
  const json: SecretsJson = { nostrSecretHex: secrets.nostrSecretHex, phrase: secrets.phrase, storeKey: b64Encode(secrets.storeKey) }
  const record: StoredChatIdentity = { version: 1, envelope: await sealWithPassword(JSON.stringify(json), password) }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
}

/** The chat password rule — the same for create, import and change. */
export const MIN_CHAT_PASSWORD = 8

/** What is wrong with a new password and its confirmation, or null when it is acceptable. */
export function newPasswordProblem(pass: string, confirm: string): string | null {
  if (pass.length < MIN_CHAT_PASSWORD) return `Password must be at least ${MIN_CHAT_PASSWORD} characters.`
  if (pass !== confirm) return "Passwords don't match."
  return null
}

/**
 * Re-seal the stored record under a new password. ONLY the envelope changes: the Nostr key, the
 * phrase and the storage key inside are the same bytes, so every store sealed with that key (all
 * chat history) stays readable.
 *
 * Throws "Wrong password." when `current` does not open the record — and then nothing is written.
 * The write is one localStorage.setItem of the whole record, so there is no half-changed state.
 */
export async function changeChatPassword(current: string, next: string): Promise<void> {
  if (next.length < MIN_CHAT_PASSWORD) throw new Error(`Password must be at least ${MIN_CHAT_PASSWORD} characters.`)
  const record = loadChatRecord()
  if (!record) throw new Error('No chat identity on this device.')
  const secrets = await openChatIdentity(record, current)
  try {
    await saveChatIdentity(secrets, next)
  } finally {
    secrets.storeKey.fill(0)   // this copy only; the live session holds its own
  }
}

/** Decrypt. Throws "Wrong password." when the envelope does not open, and on a malformed payload. */
export async function openChatIdentity(record: StoredChatIdentity, password: string): Promise<ChatSecrets> {
  let plain: string
  try { plain = await openWithPassword(record.envelope, password) } catch { throw new Error('Wrong password.') }
  const json = JSON.parse(plain) as Partial<SecretsJson>
  if (typeof json.nostrSecretHex !== 'string' || !/^[0-9a-f]{64}$/.test(json.nostrSecretHex)) throw new Error('Your saved chat identity is damaged.')
  if (typeof json.storeKey !== 'string') throw new Error('Your saved chat identity is damaged.')
  const storeKey = b64Decode(json.storeKey)
  if (storeKey.length !== 32) throw new Error('Your saved chat identity is damaged.')
  return { nostrSecretHex: json.nostrSecretHex, phrase: typeof json.phrase === 'string' ? json.phrase : null, storeKey }
}

// ── Chat history on this device ──────────────────────────────────────────────

/** Every localStorage record the chat stores keep for `pubkeyHex` (`caravel.<store>.v1.<pubkey>`). */
export function chatHistoryKeys(pubkeyHex: string): string[] {
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('caravel.') && k.endsWith(`.${pubkeyHex}`)) out.push(k)
    }
  } catch { /* storage unavailable — nothing we can see */ }
  return out
}

/** Whether this device holds chat history for `pubkeyHex` that a fresh storage key cannot open. */
export function hasChatHistory(pubkeyHex: string): boolean {
  return chatHistoryKeys(pubkeyHex).length > 0
}

/** Remove this identity's chat history from the device: every store record, and the image cache. */
export async function removeChatHistory(pubkeyHex: string): Promise<void> {
  for (const k of chatHistoryKeys(pubkeyHex)) {
    try { localStorage.removeItem(k) } catch { /* best effort */ }
  }
  await deleteAllForIdentity(pubkeyHex).catch(() => undefined)
}
