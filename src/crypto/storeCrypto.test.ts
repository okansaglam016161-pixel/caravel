// The at-rest envelope (stage 2).
//
// Hermetic: @noble/ciphers is a synchronous pure-JS implementation, so the real XChaCha20-Poly1305
// runs here with no shim and no async.

import { describe, expect, it } from 'vitest'
import { open, seal } from './storeCrypto'

const KEY = new Uint8Array(32).fill(42)
const OTHER_KEY = new Uint8Array(32).fill(7)

describe('seal / open round-trip', () => {
  it('returns exactly the JSON it was given', () => {
    const json = JSON.stringify([{ note: 'lunch', amount: '1500000' }])
    const opened = open(KEY, seal(KEY, json))
    expect(opened).toEqual({ status: 'ok', json })
  })

  it('carries an empty payload, and multi-byte text, unharmed', () => {
    for (const json of ['[]', '{}', '""', JSON.stringify({ note: 'cafe ☕ 日本語 end' })]) {
      expect(open(KEY, seal(KEY, json))).toEqual({ status: 'ok', json })
    }
  })

  it('hides the plaintext', () => {
    const sealed = seal(KEY, JSON.stringify({ note: 'lunch with mira', to: 'otl_esm_1recipient' }))
    expect(sealed).not.toContain('lunch with mira')
    expect(sealed).not.toContain('otl_esm_1recipient')
  })

  it('emits a v2 envelope with a nonce and a ciphertext', () => {
    const record = JSON.parse(seal(KEY, '[]'))
    expect(record.v).toBe(2)
    expect(typeof record.n).toBe('string')
    expect(typeof record.ct).toBe('string')
  })

  it('uses a FRESH NONCE every time - the same input never seals to the same bytes', () => {
    // The property that makes random nonces safe here. XChaCha's 192-bit nonce is why this needs no
    // counting argument as later stages put hotter stores behind the same key.
    const a = seal(KEY, '[]')
    const b = seal(KEY, '[]')
    expect(a).not.toBe(b)
    expect(JSON.parse(a).n).not.toBe(JSON.parse(b).n)
    // ...and both still open to the same thing.
    expect(open(KEY, a)).toEqual(open(KEY, b))
  })
})

describe('the v1 / v2 discriminator - what makes migration lossless', () => {
  it('passes a legacy plaintext ARRAY straight through', () => {
    // The journal's legacy shape.
    const legacy = JSON.stringify([{ id: 'a', note: 'older payment' }])
    expect(open(KEY, legacy)).toEqual({ status: 'ok', json: legacy })
  })

  it('passes a legacy plaintext OBJECT straight through', () => {
    // The shape every messaging store uses, for the stages after this one.
    const legacy = JSON.stringify({ abc123: { state: 'accepted', updatedAt: 5 } })
    expect(open(KEY, legacy)).toEqual({ status: 'ok', json: legacy })
  })

  it('reads legacy plaintext with NO KEY - there is nothing to decrypt', () => {
    // This is what lets a device migrate at all, and it is honest: the function cannot protect
    // bytes that are already in the clear on disk.
    const legacy = JSON.stringify([1, 2, 3])
    expect(open(null, legacy)).toEqual({ status: 'ok', json: legacy })
  })

  it('does not mistake a plaintext object for an envelope just because it is an object', () => {
    const notAnEnvelope = JSON.stringify({ v: 2 })                       // missing n/ct
    expect(open(KEY, notAnEnvelope)).toEqual({ status: 'ok', json: notAnEnvelope })
    const wrongVersion = JSON.stringify({ v: 1, n: 'x', ct: 'y' })
    expect(open(KEY, wrongVersion)).toEqual({ status: 'ok', json: wrongVersion })
  })
})

describe('the three states', () => {
  it('empty - nothing stored', () => {
    expect(open(KEY, null)).toEqual({ status: 'empty' })
    expect(open(KEY, '')).toEqual({ status: 'empty' })
  })

  it('unreadable - a WRONG KEY, via the Poly1305 tag', () => {
    // Authenticated, so this is a clean failure rather than garbage plaintext. That is what makes
    // `unreadable` trustworthy enough for journalStore to gate a write on.
    expect(open(OTHER_KEY, seal(KEY, '[]'))).toEqual({ status: 'unreadable' })
  })

  it('unreadable - a sealed record with NO key', () => {
    expect(open(null, seal(KEY, '[]'))).toEqual({ status: 'unreadable' })
  })

  it('unreadable - malformed JSON', () => {
    expect(open(KEY, '{not json')).toEqual({ status: 'unreadable' })
  })

  it('unreadable - an envelope whose ciphertext has been tampered with', () => {
    const record = JSON.parse(seal(KEY, JSON.stringify([{ amount: '1' }])))
    record.ct = 'AAAA' + record.ct.slice(4)
    expect(open(KEY, JSON.stringify(record))).toEqual({ status: 'unreadable' })
  })

  it('unreadable - an envelope whose nonce has been swapped', () => {
    const a = JSON.parse(seal(KEY, '[1]'))
    const b = JSON.parse(seal(KEY, '[2]'))
    expect(open(KEY, JSON.stringify({ ...a, n: b.n }))).toEqual({ status: 'unreadable' })
  })

  it('NEVER THROWS, whatever it is handed', () => {
    // Callers are store load paths whose contract is to degrade to empty, not to propagate.
    for (const input of [null, '', '{not json', '[', 'null', 'true', '42', JSON.stringify({ v: 2, n: '!!', ct: '!!' })]) {
      expect(() => open(KEY, input)).not.toThrow()
      expect(() => open(null, input)).not.toThrow()
    }
  })
})
