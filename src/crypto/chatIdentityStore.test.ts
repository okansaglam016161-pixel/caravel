// The chat identity record: password-encrypted round trip, nothing in plaintext, refusal of a record
// this build cannot open, and removing one identity's chat history without touching anything else.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  chatHistoryKeys, hasChatHistory, hasChatIdentity, loadChatRecord, openChatIdentity, removeChatHistory, saveChatIdentity,
  type ChatSecrets,
} from './chatIdentityStore'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

const SECRET = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a'
const PHRASE = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
const secrets = (): ChatSecrets => ({ nostrSecretHex: SECRET, phrase: PHRASE, storeKey: new Uint8Array(32).fill(9) })

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
})

describe('the chat identity record', () => {
  it('is absent until saved, then opens with the password to exactly what was saved', async () => {
    expect(hasChatIdentity()).toBe(false)
    expect(loadChatRecord()).toBeNull()
    await saveChatIdentity(secrets(), 'correct horse')
    expect(hasChatIdentity()).toBe(true)
    const opened = await openChatIdentity(loadChatRecord()!, 'correct horse')
    expect(opened.nostrSecretHex).toBe(SECRET)
    expect(opened.phrase).toBe(PHRASE)
    expect([...opened.storeKey]).toEqual(new Array(32).fill(9))
  }, 30_000)

  it('keeps an nsec-only identity\'s missing phrase as null', async () => {
    await saveChatIdentity({ ...secrets(), phrase: null }, 'correct horse')
    expect((await openChatIdentity(loadChatRecord()!, 'correct horse')).phrase).toBeNull()
  }, 30_000)

  it('refuses a wrong password', async () => {
    await saveChatIdentity(secrets(), 'correct horse')
    await expect(openChatIdentity(loadChatRecord()!, 'battery staple')).rejects.toThrow('Wrong password.')
  }, 30_000)

  it('stores nothing in plaintext — not the secret, the phrase, or the storage key', async () => {
    await saveChatIdentity(secrets(), 'correct horse')
    const raw = localStorage.getItem('caravel.chat.v1')!
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain('leader')
    expect(raw).not.toContain('npub')
  }, 30_000)

  it('THROWS on a record it cannot open, rather than reading it as "no identity"', () => {
    localStorage.setItem('caravel.chat.v1', '{not json')
    expect(() => loadChatRecord()).toThrow()
    localStorage.setItem('caravel.chat.v1', JSON.stringify({ version: 2, envelope: {} }))
    expect(() => loadChatRecord()).toThrow(/newer version/)
  })
})

describe('chat history on this device', () => {
  const A = 'a'.repeat(64), B = 'b'.repeat(64)

  it('finds and removes only this identity\'s chat records', async () => {
    localStorage.setItem(`caravel.messages.v1.${A}`, 'x')
    localStorage.setItem(`caravel.contacts.v1.${A}`, 'x')
    localStorage.setItem(`caravel.messages.v1.${B}`, 'x')
    localStorage.setItem('caravel.journal.v1.otl_esm_1wallet', 'x')   // a wallet store
    expect(hasChatHistory(A)).toBe(true)
    expect(chatHistoryKeys(A).sort()).toEqual([`caravel.contacts.v1.${A}`, `caravel.messages.v1.${A}`])

    await removeChatHistory(A)
    expect(hasChatHistory(A)).toBe(false)
    expect(localStorage.getItem(`caravel.messages.v1.${B}`)).toBe('x')
    expect(localStorage.getItem('caravel.journal.v1.otl_esm_1wallet')).toBe('x')
  })
})
