// LIVE round-trip against the real Blossom hosts in config/blossom.ts (image attachments M2).
//
//   npm run test:live
//
// NOT part of `npm test` — see vitest.live.config.ts. It exercises the REAL shipped modules
// (encryptMedia → uploadEncryptedBlob → downloadAndDecrypt), so a regression in any of them fails
// here rather than in production. Run it when the client changes or a host is added or removed.
//
// What it deliberately cannot cover:
//   - the browser's CORS preflight, which Node does not enforce → scripts/blossom-probe.html
//   - the canvas downscale, which needs a real browser by nature
//
// It uploads a small blob to a third-party host on every run. That is the point, but it is also why
// this is opt-in rather than automatic.

import { describe, expect, it } from 'vitest'
import { DEFAULT_BLOSSOM_HOSTS } from '../src/config/blossom'
import { decryptMedia, encryptMedia, sha256Hex } from '../src/crypto/mediaCrypto'
import { candidateUrls, downloadAndDecrypt, uploadEncryptedBlob } from '../src/crypto/blossomClient'

const read = (buf: ArrayBuffer) => [...new Uint8Array(buf)]

// getRandomValues refuses more than 65,536 bytes in one call (Web Crypto spec), so fill in chunks.
// Production never hits this — mediaCrypto only ever asks for a 32-byte key and a 12-byte nonce.
function randomBytes(total: number): Uint8Array {
  const out = new Uint8Array(total)
  for (let offset = 0; offset < total; offset += 65_536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65_536, total)))
  }
  return out
}

// ~180KB of incompressible bytes — the size a 1600px re-encode actually lands at, so the timing and
// the host's size handling are representative rather than a toy.
const plaintext = randomBytes(180 * 1024).buffer

describe('Blossom live round-trip', () => {
  // Shared across the specs below: one upload, then everything else reads it back. Uploading per
  // spec would multiply the load we put on someone else's free server for no extra coverage.
  let enc: Awaited<ReturnType<typeof encryptMedia>>
  let uploadedUrl = ''

  it('encrypts with a self-consistent x / ox', async () => {
    enc = await encryptMedia(plaintext)
    expect(enc.ciphertext.byteLength).toBe(plaintext.byteLength + 16)   // GCM tag appended
    expect(enc.x).toBe(await sha256Hex(enc.ciphertext))
    expect(enc.ox).toBe(await sha256Hex(plaintext))
  })

  it('uploads the ciphertext to a real host', async () => {
    const result = await uploadEncryptedBlob(enc.ciphertext, enc.x)
    // A failure here is the milestone's load-bearing assumption breaking: it means no configured
    // host will take an application/octet-stream blob any more.
    expect(result.status, JSON.stringify(result)).toBe('ok')
    if (result.status !== 'ok') return
    uploadedUrl = result.url
    console.log(`    uploaded to ${result.host} → ${result.url}`)
  })

  it('downloads, verifies the hash, and decrypts back to the exact bytes', async () => {
    const result = await downloadAndDecrypt(uploadedUrl, enc.x, enc.keyB64, enc.nonceB64)
    expect(result.status, JSON.stringify(result)).toBe('ok')
    if (result.status !== 'ok') return
    expect(read(result.bytes)).toEqual(read(plaintext))
  })

  it('finds the blob by CONTENT ADDRESS with no URL at all', async () => {
    // The durability hedge: when the host named in a message has purged the blob, the same bytes are
    // still reachable at <otherHost>/<x>. Proving it works against live hosts is the only way to
    // know the fallback is real rather than theoretical.
    const result = await downloadAndDecrypt('', enc.x, enc.keyB64, enc.nonceB64)
    expect(result.status, JSON.stringify(result)).toBe('ok')
    expect(candidateUrls('', enc.x, DEFAULT_BLOSSOM_HOSTS).length).toBe(DEFAULT_BLOSSOM_HOSTS.length)
  })

  it('classifies a wrong key as undecryptable, not as a network problem', async () => {
    const other = await encryptMedia(new ArrayBuffer(8))
    const result = await downloadAndDecrypt(uploadedUrl, enc.x, other.keyB64, enc.nonceB64)
    expect(result.status).toBe('undecryptable')
  })

  it('classifies an unknown blob as gone after exhausting every host', async () => {
    const result = await downloadAndDecrypt('', 'f'.repeat(64), enc.keyB64, enc.nonceB64)
    expect(result.status).toBe('gone')
  })

  it('does not mistake an unresolvable host for a missing blob... or crash', async () => {
    const result = await downloadAndDecrypt('https://does-not-exist.invalid/blob', '', enc.keyB64, enc.nonceB64)
    expect(['network_error', 'gone']).toContain(result.status)
  })

  it('decrypts directly, confirming the blob really was GCM-protected end to end', async () => {
    expect(read(await decryptMedia(enc.ciphertext, enc.keyB64, enc.nonceB64))).toEqual(read(plaintext))
  })
})
