// Tests for the pure part of the media send path (images M3).
//
// The orchestration itself (processImage → encryptMedia → uploadEncryptedBlob → provider.send) is
// covered by the live round-trip, since two of its three stages need a browser canvas and a real
// host. What IS unit-testable, and worth testing on its own, is the delete-path harvest: it decides
// which cached blobs get purged, and getting it wrong either strands megabytes forever or deletes
// an image that is still on screen.

import { describe, expect, it } from 'vitest'
import {
  MediaSendFailure,
  describeMediaFailure,
  describeMediaStage,
  isHeicFile,
  isRetryableMediaFailure,
  mediaBlobKeys,
  type MediaSendError,
  type MediaSendStage,
} from './sendMedia'
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

// ── Failure reporting (images M4 fix) ─────────────────────────────────────────
//
// These exist because the original harness had no working error surface at all: a HEIC photo failed
// to decode, the throw was caught, and the message went to a `sendError` state that had been dead
// since the thread redesign. Nothing appeared on screen. The copy below is what the user now sees,
// so it is worth asserting directly.

describe('isHeicFile', () => {
  it('recognises the MIME types', () => {
    expect(isHeicFile('IMG_0001', 'image/heic')).toBe(true)
    expect(isHeicFile('IMG_0001', 'image/heif')).toBe(true)
    expect(isHeicFile('IMG_0001', 'image/heic-sequence')).toBe(true)
    expect(isHeicFile('IMG_0001', 'IMAGE/HEIC')).toBe(true)
  })

  it('falls back to the EXTENSION when the type is blank', () => {
    // The case that matters: file.type comes back empty on some platforms, and trusting it alone
    // would report an iPhone photo as a generic unreadable file with no useful advice.
    expect(isHeicFile('IMG_0001.HEIC', '')).toBe(true)
    expect(isHeicFile('photo.heif', '')).toBe(true)
  })

  it('does not misfire on ordinary images', () => {
    expect(isHeicFile('photo.jpg', 'image/jpeg')).toBe(false)
    expect(isHeicFile('photo.png', 'image/png')).toBe(false)
    expect(isHeicFile('photo.webp', 'image/webp')).toBe(false)
    // "heic" appearing mid-name must not count — only a real extension does.
    expect(isHeicFile('heic-holiday.jpg', 'image/jpeg')).toBe(false)
  })

  it('survives missing name and type without throwing', () => {
    expect(isHeicFile('', '')).toBe(false)
  })
})

describe('isRetryableMediaFailure', () => {
  it('never offers a retry for a processing failure', () => {
    // A file the browser cannot decode, or one over the cap, fails identically forever.
    expect(isRetryableMediaFailure({ stage: 'process', reason: 'undecodable', detail: 'x' })).toBe(false)
    expect(isRetryableMediaFailure({ stage: 'process', reason: 'too_large', detail: 'x' })).toBe(false)
  })

  it('offers a retry only for a network upload failure', () => {
    expect(isRetryableMediaFailure({ stage: 'upload', reason: 'network_error', detail: 'x' })).toBe(true)
    expect(isRetryableMediaFailure({ stage: 'upload', reason: 'rejected', detail: 'x' })).toBe(false)
    expect(isRetryableMediaFailure({ stage: 'upload', reason: 'too_large', detail: 'x' })).toBe(false)
  })

  it('offers a retry when only the relay publish failed', () => {
    expect(isRetryableMediaFailure({ stage: 'send', detail: 'x' })).toBe(true)
  })
})

describe('describeMediaFailure', () => {
  const fail = (info: MediaSendError) => new MediaSendFailure(info)
  const HEIC = { name: 'IMG_4821.HEIC', type: '' }
  const JPEG = { name: 'photo.jpg', type: 'image/jpeg' }

  it('gives HEIC the actionable message, not a generic one', () => {
    // The single most likely real failure: an iPhone photo on a browser with no HEVC licence.
    const copy = describeMediaFailure(fail({ stage: 'process', reason: 'undecodable', detail: 'decode failed' }), HEIC)
    expect(copy.hint).toBe('This image format isn’t supported by your browser. Try a JPEG or PNG.')
    expect(copy.retryable).toBe(false)
  })

  it('gives a NON-heic undecodable file a generic but honest message', () => {
    const copy = describeMediaFailure(fail({ stage: 'process', reason: 'undecodable', detail: 'decode failed' }), JPEG)
    expect(copy.label).toBe('Couldn’t prepare the image')
    expect(copy.hint).toBe('This file couldn’t be read as an image.')
    expect(copy.retryable).toBe(false)
  })

  it('still degrades gracefully when no file is supplied', () => {
    const copy = describeMediaFailure(fail({ stage: 'process', reason: 'undecodable', detail: 'x' }))
    expect(copy.label).toBe('Couldn’t prepare the image')
    expect(copy.retryable).toBe(false)
  })

  it('passes through the size limit message, which is already human', () => {
    const copy = describeMediaFailure(fail({ stage: 'process', reason: 'too_large', detail: 'Image is 24.3MB — the limit is 20MB' }))
    expect(copy.label).toBe('Image is too large')
    expect(copy.hint).toContain('24.3MB')
  })

  it('distinguishes the three stages, so the user knows what actually broke', () => {
    expect(describeMediaFailure(fail({ stage: 'process', reason: 'undecodable', detail: '' })).label).toBe('Couldn’t prepare the image')
    expect(describeMediaFailure(fail({ stage: 'upload', reason: 'network_error', detail: '' })).label).toBe('Couldn’t upload the image')
    expect(describeMediaFailure(fail({ stage: 'send', detail: '' })).label).toBe('Couldn’t send the image')
  })

  it('separates "no host accepted it" from "the host was unreachable"', () => {
    expect(describeMediaFailure(fail({ stage: 'upload', reason: 'rejected', detail: '' })).hint).toBe('No image host accepted it.')
    expect(describeMediaFailure(fail({ stage: 'upload', reason: 'network_error', detail: '' })).hint).toBe('The image host couldn’t be reached.')
  })

  it('says NOTHING about the orphaned blob on a send failure', () => {
    // The uploaded ciphertext is undecryptable by anyone — the key never left this device — so
    // raising it would alarm the user about something harmless.
    const copy = describeMediaFailure(fail({ stage: 'send', detail: 'no relay accepted' }))
    expect(copy.hint).toBeNull()
    expect(copy.label).not.toMatch(/upload|host|blob/i)
  })

  it('handles a non-MediaSendFailure error without crashing the bubble', () => {
    const copy = describeMediaFailure(new Error('wallet locked'))
    expect(copy.label).toBe('Couldn’t send the image')
    expect(copy.retryable).toBe(true)
  })

  it('never returns an empty label — the bubble must always say something', () => {
    const cases: MediaSendError[] = [
      { stage: 'process', reason: 'undecodable', detail: '' },
      { stage: 'process', reason: 'too_large', detail: '' },
      { stage: 'upload', reason: 'rejected', detail: '' },
      { stage: 'upload', reason: 'network_error', detail: '' },
      { stage: 'upload', reason: 'too_large', detail: '' },
      { stage: 'send', detail: '' },
    ]
    for (const info of cases) {
      expect(describeMediaFailure(fail(info)).label.length).toBeGreaterThan(0)
    }
    expect(describeMediaFailure('not even an error').label.length).toBeGreaterThan(0)
  })
})

describe('describeMediaStage', () => {
  it('names each pipeline stage in words a user can act on', () => {
    expect(describeMediaStage('process')).toBe('Preparing…')
    expect(describeMediaStage('upload')).toBe('Uploading…')
    expect(describeMediaStage('send')).toBe('Sending…')
  })

  it('covers every stage the failure type uses — one vocabulary for both', () => {
    // MediaSendError's stages and MediaSendStage are deliberately the same three names, so progress
    // and failure describe the pipeline identically. A stage without a label would be a gap.
    const stages: MediaSendStage[] = ['process', 'upload', 'send']
    for (const stage of stages) {
      expect(describeMediaStage(stage).length).toBeGreaterThan(0)
    }
  })
})
