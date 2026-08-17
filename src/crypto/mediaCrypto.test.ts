// Unit tests for the image-attachment crypto (M2). Hermetic and offline — Node exposes WebCrypto on
// globalThis.crypto, so the REAL AES-GCM and SHA-256 run here, not a shim. The network round-trip
// against live Blossom hosts is a separate script, deliberately outside `npm test`.

import { describe, expect, it } from 'vitest'
import { b64Decode, b64Encode, b64urlEncodeString } from './base64'
import { decryptMedia, encryptMedia, sha256Hex, verifyCiphertextHash } from './mediaCrypto'

const bytes = (...values: number[]) => new Uint8Array(values).buffer
const read = (buf: ArrayBuffer) => [...new Uint8Array(buf)]

// A stand-in for image bytes: incompressible, and big enough to span several AES blocks.
function payload(size = 4096): ArrayBuffer {
  return crypto.getRandomValues(new Uint8Array(size)).buffer
}

describe('base64', () => {
  it('round-trips arbitrary binary including the byte extremes', () => {
    const original = new Uint8Array([0, 1, 127, 128, 254, 255])
    expect([...b64Decode(b64Encode(original))]).toEqual([...original])
  })

  it('round-trips an empty buffer', () => {
    expect([...b64Decode(b64Encode(new Uint8Array()))]).toEqual([])
  })

  it('emits base64url with no padding and no + or / for the auth token', () => {
    // The token rides in an Authorization header, where + and / are hostile. Exercised over many
    // inputs because whether a given string produces those characters depends on its length.
    for (let i = 1; i < 60; i++) {
      const token = b64urlEncodeString('a'.repeat(i) + '~?ÿ}{><')
      expect(token).not.toMatch(/[+/=]/)
    }
  })

  it('base64url decodes back to the original string', () => {
    const text = JSON.stringify({ kind: 24242, tags: [['t', 'upload']], sig: 'ff00' })
    const token = b64urlEncodeString(text)
    const standard = token.replace(/-/g, '+').replace(/_/g, '/')
    expect(new TextDecoder().decode(b64Decode(standard))).toBe(text)
  })
})

describe('sha256Hex', () => {
  it('matches the known digest of the empty input', () => {
    return expect(sha256Hex(new ArrayBuffer(0)))
      .resolves.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('matches the known digest of "abc"', () => {
    return expect(sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer))
      .resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('is 64 lowercase hex chars, zero-padded', () => {
    return expect(sha256Hex(bytes(0, 0, 0))).resolves.toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('encryptMedia / decryptMedia', () => {
  it('round-trips the exact plaintext', async () => {
    const plaintext = payload()
    const enc = await encryptMedia(plaintext)
    const out = await decryptMedia(enc.ciphertext, enc.keyB64, enc.nonceB64)
    expect(read(out)).toEqual(read(plaintext))
  })

  it('produces ciphertext that is not the plaintext, plus the 16-byte GCM tag', async () => {
    const plaintext = payload(1024)
    const enc = await encryptMedia(plaintext)
    expect(enc.ciphertext.byteLength).toBe(1024 + 16)   // tag is appended, not a separate field
    expect(read(enc.ciphertext).slice(0, 1024)).not.toEqual(read(plaintext))
  })

  it('emits a 256-bit key and a 96-bit nonce', async () => {
    const enc = await encryptMedia(payload(64))
    expect(b64Decode(enc.keyB64).length).toBe(32)
    expect(b64Decode(enc.nonceB64).length).toBe(12)
  })

  it('NEVER reuses a key or a nonce across calls', async () => {
    // The invariant that actually matters for GCM. A refactor that hoisted either out of the
    // function would be caught here.
    const runs = await Promise.all(Array.from({ length: 12 }, () => encryptMedia(payload(64))))
    expect(new Set(runs.map(r => r.keyB64)).size).toBe(12)
    expect(new Set(runs.map(r => r.nonceB64)).size).toBe(12)
  })

  it('encrypts identical plaintext to different ciphertext each time', async () => {
    const plaintext = payload(256)
    const a = await encryptMedia(plaintext)
    const b = await encryptMedia(plaintext)
    expect(a.x).not.toBe(b.x)     // so identical images do not become a linkable fingerprint
    expect(a.ox).toBe(b.ox)       // but the PLAINTEXT hash is stable, as kind 15 intends
  })

  it('reports x over the CIPHERTEXT and ox over the PLAINTEXT', async () => {
    const plaintext = payload(512)
    const enc = await encryptMedia(plaintext)
    expect(enc.x).toBe(await sha256Hex(enc.ciphertext))
    expect(enc.ox).toBe(await sha256Hex(plaintext))
  })

  it('fails to decrypt with the wrong key', async () => {
    const enc = await encryptMedia(payload())
    const other = await encryptMedia(payload())
    await expect(decryptMedia(enc.ciphertext, other.keyB64, enc.nonceB64)).rejects.toThrow()
  })

  it('fails to decrypt with the wrong nonce', async () => {
    const enc = await encryptMedia(payload())
    const other = await encryptMedia(payload())
    await expect(decryptMedia(enc.ciphertext, enc.keyB64, other.nonceB64)).rejects.toThrow()
  })

  it('fails on a SINGLE flipped ciphertext byte — the real integrity boundary', async () => {
    const enc = await encryptMedia(payload())
    const tampered = new Uint8Array(enc.ciphertext)
    tampered[100] ^= 0x01
    await expect(decryptMedia(tampered.buffer, enc.keyB64, enc.nonceB64)).rejects.toThrow()
  })

  it('fails on a truncated ciphertext', async () => {
    const enc = await encryptMedia(payload())
    const truncated = new Uint8Array(enc.ciphertext).slice(0, -8).buffer
    await expect(decryptMedia(truncated, enc.keyB64, enc.nonceB64)).rejects.toThrow()
  })

  it('handles an empty plaintext without special-casing', async () => {
    const enc = await encryptMedia(new ArrayBuffer(0))
    expect(read(await decryptMedia(enc.ciphertext, enc.keyB64, enc.nonceB64))).toEqual([])
  })
})

describe('verifyCiphertextHash', () => {
  it('accepts the matching hash and rejects a mismatched one', async () => {
    const enc = await encryptMedia(payload(256))
    expect(await verifyCiphertextHash(enc.ciphertext, enc.x)).toBe(true)
    expect(await verifyCiphertextHash(enc.ciphertext, 'f'.repeat(64))).toBe(false)
  })

  it('is case-insensitive about the expected hex', async () => {
    const enc = await encryptMedia(payload(64))
    expect(await verifyCiphertextHash(enc.ciphertext, enc.x.toUpperCase())).toBe(true)
  })

  it('rejects an empty expected hash rather than vacuously passing', async () => {
    const enc = await encryptMedia(payload(64))
    expect(await verifyCiphertextHash(enc.ciphertext, '')).toBe(false)
  })

  it('detects a single altered byte', async () => {
    const enc = await encryptMedia(payload(256))
    const altered = new Uint8Array(enc.ciphertext)
    altered[5] ^= 0xff
    expect(await verifyCiphertextHash(altered.buffer, enc.x)).toBe(false)
  })
})
