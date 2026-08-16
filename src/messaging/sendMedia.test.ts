// Tests for the pure part of the media send path (images M3).
//
// The orchestration itself (processImage → encryptMedia → uploadEncryptedBlob → provider.send) is
// covered by the live round-trip, since two of its three stages need a browser canvas and a real
// host. What IS unit-testable, and worth testing on its own, is the delete-path harvest: it decides
// which cached blobs get purged, and getting it wrong either strands megabytes forever or deletes
// an image that is still on screen.

import { describe, expect, it } from 'vitest'
import { mediaBlobKeys } from './sendMedia'
import type { CaravelMessage, MediaRef } from './types'

function ref(over: Partial<MediaRef> = {}): MediaRef {
  return {
    url: 'https://h/blob', key: 'k', nonce: 'n', mime: 'image/webp',
    x: 'a'.repeat(64), ox: 'b'.repeat(64), width: 100, height: 100, size: 10,
    ...over,
  }
}

function msg(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: 'evt1',
    senderPubkeyHex: 'a'.repeat(64),
    recipientPubkeyHex: 'b'.repeat(64),
    plaintext: 'hi',
    timestamp: 1_000_000,
    direction: 'sent',
    ...over,
  }
}

describe('mediaBlobKeys', () => {
  it('collects the ciphertext hash from every media message', () => {
    const rows = [
      msg({ id: '1', media: ref({ x: 'x1' }) }),
      msg({ id: '2', media: ref({ x: 'x2' }) }),
    ]
    expect(mediaBlobKeys(rows)).toEqual(['x1', 'x2'])
  })

  it('ignores messages with no media, so a mixed conversation harvests cleanly', () => {
    const rows = [
      msg({ id: '1' }),                                      // plain text
      msg({ id: '2', media: ref({ x: 'x2' }) }),
      msg({ id: '3', payment: { utxoId: 'utxo_1' } }),       // payment card
      msg({ id: '4', system: 'group-leave', plaintext: '' }),
    ]
    expect(mediaBlobKeys(rows)).toEqual(['x2'])
  })

  it('harvests x, NEVER ox — the cache is keyed on the hash we actually verify', () => {
    // ox is sender-declared and never checked, so keying a cache on it would be poisonable. x is
    // verified before decrypt, so it always names bytes we validated.
    const rows = [msg({ media: ref({ x: 'ciphertext-hash', ox: 'plaintext-hash' }) })]
    expect(mediaBlobKeys(rows)).toEqual(['ciphertext-hash'])
    expect(mediaBlobKeys(rows)).not.toContain('plaintext-hash')
  })

  it('returns an empty list for no messages and for no media', () => {
    expect(mediaBlobKeys([])).toEqual([])
    expect(mediaBlobKeys([msg(), msg({ id: '2' })])).toEqual([])
  })

  it('skips a media row whose hash is blank rather than emitting an empty key', () => {
    // deleteBlobs would ignore it anyway, but an empty key in the list is a latent footgun.
    const rows = [msg({ id: '1', media: ref({ x: '' }) }), msg({ id: '2', media: ref({ x: 'x2' }) })]
    expect(mediaBlobKeys(rows)).toEqual(['x2'])
  })

  it('keeps duplicates — the same image sent twice is one cache entry, deleted once', () => {
    // Both rows name the same blob. deleteBlobs is idempotent, so the repeat is harmless; asserting
    // it documents that dedupe is deliberately NOT this function's job.
    const rows = [msg({ id: '1', media: ref({ x: 'same' }) }), msg({ id: '2', media: ref({ x: 'same' }) })]
    expect(mediaBlobKeys(rows)).toEqual(['same', 'same'])
  })
})
