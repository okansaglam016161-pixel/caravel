// The standalone chat identity: NIP-06 from a 12-word phrase, nsec import, what an import field
// accepts and refuses, and the storage key's independence from the Nostr key.

import { describe, expect, it } from 'vitest'
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import {
  classifyBackup, createChatPhrase, identityFromPhrase, identityFromSecretHex, newChatStoreKey, normalisePhrase,
} from './chatIdentity'

// NIP-06's own published vector — so a Caravel chat identity is reproducible by any compliant client.
const NIP06_PHRASE = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
const NIP06_SECRET = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a'
const NIP06_NPUB = 'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu'

// A checksum-valid 24-word phrase (BIP-39's all-zero vector) — the shape of a wallet recovery phrase.
const TWENTY_FOUR = `${'abandon '.repeat(23)}art`

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

describe('the 12-word phrase is plain NIP-06 — FROZEN', () => {
  it('derives the published NIP-06 vector', async () => {
    const id = await identityFromPhrase(NIP06_PHRASE)
    expect(id.privateKeyHex).toBe(NIP06_SECRET)
    expect(id.npub).toBe(NIP06_NPUB)
  })

  it('ignores case and stray whitespace', async () => {
    const id = await identityFromPhrase(`  ${NIP06_PHRASE.toUpperCase().replace(/ /g, '   ')}\n`)
    expect(id.npub).toBe(NIP06_NPUB)
  })

  it('creates 12 checksum-valid words, different every time', () => {
    const a = createChatPhrase(), b = createChatPhrase()
    expect(a.split(' ')).toHaveLength(12)
    expect(validateMnemonic(a, wordlist)).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('classifyBackup — exactly a 12-word phrase or an nsec', () => {
  it('accepts a valid 12-word phrase, normalised', () => {
    expect(classifyBackup(`  ${NIP06_PHRASE.toUpperCase()} `)).toEqual({ kind: 'phrase', phrase: NIP06_PHRASE })
  })

  it('refuses a 12-word phrase whose checksum fails', () => {
    const words = NIP06_PHRASE.split(' ')
    words[11] = words[11] === 'bean' ? 'beach' : 'bean'
    expect(classifyBackup(words.join(' '))).toEqual({ kind: 'invalid', reason: 'bad-phrase' })
  })

  it('names a 24-word phrase as a WALLET phrase, not a chat backup', () => {
    expect(classifyBackup(TWENTY_FOUR)).toEqual({ kind: 'wallet-phrase' })
  })

  it('accepts an nsec, and it restores the same identity as the phrase', async () => {
    const fromPhrase = await identityFromPhrase(NIP06_PHRASE)
    const input = classifyBackup(fromPhrase.nsec)
    expect(input).toEqual({ kind: 'nsec', secretHex: NIP06_SECRET })
    expect(identityFromSecretHex(NIP06_SECRET)).toEqual(fromPhrase)
  })

  it('refuses a damaged nsec, an npub, raw hex, other word counts, and nothing', async () => {
    const { nsec, npub } = await identityFromPhrase(NIP06_PHRASE)
    expect(classifyBackup(nsec.slice(0, -1) + (nsec.endsWith('q') ? 'p' : 'q'))).toEqual({ kind: 'invalid', reason: 'bad-nsec' })
    expect(classifyBackup(npub)).toEqual({ kind: 'invalid', reason: 'unrecognised' })
    expect(classifyBackup(NIP06_SECRET)).toEqual({ kind: 'invalid', reason: 'unrecognised' })
    expect(classifyBackup('leader monkey parrot')).toEqual({ kind: 'invalid', reason: 'unrecognised' })
    expect(classifyBackup('   ')).toEqual({ kind: 'empty' })
  })

  it('normalisePhrase is lowercase, single-spaced and trimmed', () => {
    expect(normalisePhrase('  Leader\tMONKEY\n parrot ')).toBe('leader monkey parrot')
  })
})

describe('the chat storage key', () => {
  // `nsec` is meant to leave — exporting it to another Nostr client is ordinary — so it must not also
  // hand over every message on disk. The key is random; nothing derives it from the Nostr key.
  it('is 32 random bytes, different every time, and not the Nostr key', async () => {
    const a = newChatStoreKey(), b = newChatStoreKey()
    expect(a).toHaveLength(32)
    expect(hex(a)).not.toBe(hex(b))
    const id = await identityFromPhrase(NIP06_PHRASE)
    expect(hex(a)).not.toBe(id.privateKeyHex)
    expect(hex(a)).not.toBe(id.publicKeyHex)
  })
})
