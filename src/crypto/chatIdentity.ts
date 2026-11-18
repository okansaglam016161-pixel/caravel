// Caravel's CHAT IDENTITY — a standalone Nostr key, with no tie to the wallet.
//
// Pure functions only: making a backup phrase, recognising what a person pasted, turning a phrase or
// an nsec into a Nostr identity, and minting the storage key. Persistence lives in
// chatIdentityStore; the session lives in context/ChatContext.
//
// ── THE PHRASE IS PLAIN NIP-06 ───────────────────────────────────────────────
//
// 12 words (BIP-39, 128-bit, English list) → BIP-39 seed → m/44'/1237'/0'/0/0, through the existing
// deriveNostrKeyFromSeed. Nothing Caravel-specific sits in the path, so the same words restore the
// same identity in any NIP-06 client, and the published NIP-06 vector pins it
// (derivationAnchors.test.ts, and again in chatIdentity.test.ts).
//
// ── 24 WORDS ARE REFUSED, ON PURPOSE ─────────────────────────────────────────
//
// A Caravel WALLET recovery phrase is 24 words. Accepting a 24-word phrase here would let someone
// paste their wallet phrase as a chat backup — making the key to their funds the key to their
// messages, and storing it a second time. So 24 words get their own answer that points at the Wallet
// tab, rather than being treated as merely invalid.
//
// ── THE STORAGE KEY IS RANDOM, NEVER DERIVED ─────────────────────────────────
//
// An nsec is meant to leave — exporting it to another Nostr client is an ordinary thing to do — and
// it must not also unlock every message on disk. So the key that seals the chat stores is 32 random
// bytes kept inside the password-encrypted record, with no relation to the Nostr key or the phrase.

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import * as nip19 from 'nostr-tools/nip19'
import { deriveNostrKeyFromSeed, type NostrIdentity } from './nostrCrypto'

export const CHAT_PHRASE_WORDS = 12

const toHex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16))

/** Lowercase, single-spaced, trimmed — the one form a phrase is checked and stored in. */
export function normalisePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

/** A fresh 12-word backup phrase. */
export function createChatPhrase(): string {
  return generateMnemonic(wordlist, 128)
}

/** What a person pasted into the import field. */
export type BackupInput =
  | { kind: 'empty' }
  | { kind: 'phrase'; phrase: string }
  | { kind: 'nsec'; secretHex: string }
  /** 24 words: a wallet recovery phrase, which is not a chat backup. */
  | { kind: 'wallet-phrase' }
  | { kind: 'invalid'; reason: 'bad-phrase' | 'bad-nsec' | 'unrecognised' }

/**
 * Recognise an import. Accepts exactly two things: a 12-word NIP-06 phrase (checksum-valid) or an
 * `nsec1…`. Raw hex is deliberately not accepted — one unambiguous form per kind of backup.
 */
export function classifyBackup(raw: string): BackupInput {
  const text = raw.trim()
  if (!text) return { kind: 'empty' }

  if (text.toLowerCase().startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(text.toLowerCase())
      if (decoded.type !== 'nsec') return { kind: 'invalid', reason: 'bad-nsec' }
      const secretHex = toHex(decoded.data)
      schnorr.getPublicKey(decoded.data)   // throws on a scalar outside [1, n)
      return { kind: 'nsec', secretHex }
    } catch {
      return { kind: 'invalid', reason: 'bad-nsec' }
    }
  }

  const phrase = normalisePhrase(text)
  const words = phrase.split(' ')
  if (words.length === 24) return { kind: 'wallet-phrase' }
  if (words.length !== CHAT_PHRASE_WORDS) return { kind: 'invalid', reason: 'unrecognised' }
  return validateMnemonic(phrase, wordlist) ? { kind: 'phrase', phrase } : { kind: 'invalid', reason: 'bad-phrase' }
}

/** The Nostr identity a 12-word phrase restores (NIP-06, account 0). */
export async function identityFromPhrase(phrase: string): Promise<NostrIdentity> {
  return deriveNostrKeyFromSeed(await mnemonicToSeed(normalisePhrase(phrase)))
}

/** The Nostr identity of a raw 32-byte secret, given as hex. Throws on an invalid scalar. */
export function identityFromSecretHex(secretHex: string): NostrIdentity {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('Not a 32-byte secret key.')
  const secret = fromHex(secretHex)
  const publicKeyHex = toHex(schnorr.getPublicKey(secret))
  return {
    privateKeyHex: secretHex,
    publicKeyHex,
    npub: nip19.npubEncode(publicKeyHex),
    nsec: nip19.nsecEncode(secret),
  }
}

/** A fresh storage key for the chat stores: 32 random bytes, unrelated to every other key. */
export function newChatStoreKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}
