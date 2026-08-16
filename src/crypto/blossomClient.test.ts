// Unit tests for the pure parts of the Blossom client and the downscale dimension math (M2).
// Hermetic — nothing here touches the network. The live upload/download round-trip lives in
// scripts/blossom-roundtrip.mjs so a dropped wifi connection can never fail `npm test`.

import { describe, expect, it } from 'vitest'
import { verifyEvent } from 'nostr-tools/pure'
import { buildUploadAuth, candidateUrls, isRetryableStatus } from './blossomClient'
import { targetDimensions, MAX_EDGE_PX } from './imageProcess'
import { b64Decode } from './base64'

const HOSTS = ['https://host-a.example', 'https://host-b.example'] as const
const X = 'a'.repeat(64)

describe('targetDimensions', () => {
  it('scales a landscape image to the max edge, preserving aspect', () => {
    expect(targetDimensions(3200, 2400, 1600)).toEqual({ width: 1600, height: 1200 })
  })

  it('scales a portrait image by its HEIGHT — the long edge, whichever it is', () => {
    expect(targetDimensions(2400, 3200, 1600)).toEqual({ width: 1200, height: 1600 })
  })

  it('scales a square image', () => {
    expect(targetDimensions(2000, 2000, 1600)).toEqual({ width: 1600, height: 1600 })
  })

  it('NEVER upscales — a small image is passed through untouched', () => {
    expect(targetDimensions(900, 600, 1600)).toEqual({ width: 900, height: 600 })
    expect(targetDimensions(1, 1, 1600)).toEqual({ width: 1, height: 1 })
  })

  it('leaves an image exactly at the limit alone', () => {
    expect(targetDimensions(1600, 1200, 1600)).toEqual({ width: 1600, height: 1200 })
  })

  it('never rounds the short side to zero on an extreme aspect ratio', () => {
    // A 4000x3 banner scaled by 0.4 gives 1.2px of height. Rounding that to 0 would make the canvas
    // throw, so the floor is 1.
    const { width, height } = targetDimensions(4000, 3, 1600)
    expect(width).toBe(1600)
    expect(height).toBeGreaterThanOrEqual(1)
  })

  it('returns zeros for degenerate input instead of NaN dimensions', () => {
    expect(targetDimensions(0, 100, 1600)).toEqual({ width: 0, height: 0 })
    expect(targetDimensions(100, -1, 1600)).toEqual({ width: 0, height: 0 })
    expect(targetDimensions(NaN, 100, 1600)).toEqual({ width: 0, height: 0 })
    expect(targetDimensions(Infinity, 100, 1600)).toEqual({ width: 0, height: 0 })
  })

  it('produces whole-pixel dimensions', () => {
    const { width, height } = targetDimensions(3001, 1999, MAX_EDGE_PX)
    expect(Number.isInteger(width)).toBe(true)
    expect(Number.isInteger(height)).toBe(true)
  })
})

describe('candidateUrls', () => {
  it('puts the primary URL first, then every host by content address', () => {
    expect(candidateUrls('https://cdn.example/blob', X, HOSTS)).toEqual([
      'https://cdn.example/blob',
      `https://host-a.example/${X}`,
      `https://host-b.example/${X}`,
    ])
  })

  it('does not repeat the primary when it is already a content address', () => {
    const urls = candidateUrls(`https://host-a.example/${X}`, X, HOSTS)
    expect(urls).toEqual([`https://host-a.example/${X}`, `https://host-b.example/${X}`])
  })

  it('strips a trailing slash so the address never doubles up', () => {
    expect(candidateUrls('', X, ['https://host-a.example/'])).toEqual([`https://host-a.example/${X}`])
  })

  it('still yields fallbacks when the message carries no URL', () => {
    expect(candidateUrls('', X, HOSTS)).toHaveLength(2)
  })

  it('yields nothing when there is neither a URL nor a hash', () => {
    expect(candidateUrls('', '', HOSTS)).toEqual([])
  })
})

describe('isRetryableStatus', () => {
  it('treats 5xx and 429 as worth retrying', () => {
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
  })

  it('treats a missing blob as permanent — the host will not acquire it later', () => {
    expect(isRetryableStatus(404)).toBe(false)
    expect(isRetryableStatus(410)).toBe(false)
  })

  it('treats refusals as permanent for that host', () => {
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(415)).toBe(false)   // the ecosystem's usual ciphertext rejection
    expect(isRetryableStatus(200)).toBe(false)
  })
})

describe('buildUploadAuth (BUD-11)', () => {
  // The token is base64url; decode it back to the event to assert on its contents.
  function decodeToken(token: string): Record<string, unknown> {
    const standard = token.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(new TextDecoder().decode(b64Decode(standard))) as Record<string, unknown>
  }

  it('builds a kind-24242 event with the upload verb, an expiry, and the blob hash', () => {
    const event = decodeToken(buildUploadAuth(X, 1_000_000)) as {
      kind: number; created_at: number; content: string; tags: string[][]
    }
    expect(event.kind).toBe(24242)
    expect(event.created_at).toBe(1_000_000)
    expect(event.tags).toContainEqual(['t', 'upload'])
    expect(event.tags).toContainEqual(['x', X])
    expect(event.content.length).toBeGreaterThan(0)   // BUD-11: human-readable explanation
  })

  it('sets the expiration in the FUTURE relative to created_at', () => {
    const event = decodeToken(buildUploadAuth(X, 1_000_000)) as { tags: string[][] }
    const expiration = event.tags.find(t => t[0] === 'expiration')
    expect(expiration).toBeDefined()
    expect(Number(expiration![1])).toBeGreaterThan(1_000_000)
  })

  it('produces a VALID signature — a host will verify this', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(verifyEvent(decodeToken(buildUploadAuth(X)) as any)).toBe(true)
  })

  it('signs with a FRESH EPHEMERAL KEY every time — the privacy property', () => {
    // If this ever returns a repeated pubkey, uploads become linkable to each other and the
    // ephemeral-key design is silently defeated.
    const pubkeys = Array.from({ length: 10 }, () => (decodeToken(buildUploadAuth(X)) as { pubkey: string }).pubkey)
    expect(new Set(pubkeys).size).toBe(10)
  })

  it('emits a header-safe token (no +, /, or = padding)', () => {
    for (let i = 0; i < 20; i++) {
      expect(buildUploadAuth(X)).not.toMatch(/[+/=]/)
    }
  })

  it('binds the token to THIS blob, so it cannot authorise a different upload', () => {
    const other = 'b'.repeat(64)
    const event = decodeToken(buildUploadAuth(other)) as { tags: string[][] }
    expect(event.tags).toContainEqual(['x', other])
    expect(event.tags).not.toContainEqual(['x', X])
  })
})
