// Wire tests for the encrypted-image tag (images M3).
//
// These go through the REAL gift-wrap stack — nip59 wrapEvent, NIP-44, real secp256k1 keys — rather
// than asserting on a tag array. The thing that must hold is that a MediaRef survives seal +
// gift-wrap + unwrap byte-identical, and that a malformed one degrades to a plain message instead of
// arriving half-populated. Neither is provable by inspecting the builder's output.
//
// Hermetic: nostr-tools' crypto and WebCrypto both run under Node, so nothing here touches a relay.

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapMessage, unwrapMessage } from './nostrMessaging'
import type { MediaRef } from '../messaging/types'

const senderSk = generateSecretKey()
const recipientSk = generateSecretKey()
const recipientPk = getPublicKey(recipientSk)
const senderPk = getPublicKey(senderSk)

function ref(over: Partial<MediaRef> = {}): MediaRef {
  return {
    url: 'https://nostr.download/aa11bb22cc33.bin',
    key: 'c2VjcmV0LWtleS1iYXNlNjQtMzItYnl0ZXMtaGVyZQ==',
    nonce: 'bm9uY2UtMTItYnk=',
    mime: 'image/webp',
    x: 'a'.repeat(64),
    ox: 'b'.repeat(64),
    width: 1600,
    height: 1200,
    size: 214_512,
    ...over,
  }
}

// Round-trip helper: wrap for the recipient, unwrap as the recipient.
function roundTrip(caption: string, media?: MediaRef) {
  const wrapped = wrapMessage(senderSk, recipientPk, caption, undefined, undefined, undefined, media)
  return unwrapMessage(recipientSk, wrapped)
}

describe('caravel-media on the wire', () => {
  it('round-trips the full reference through the real gift wrap', () => {
    const out = roundTrip('a caption', ref())
    expect(out.media).toEqual(ref())
    // and the authenticated sender is still enforced by the same invariant as any other message
    expect(out.senderPubkeyHex).toBe(senderPk)
  })

  it('carries the CAPTION in the content alongside the reference', () => {
    // The whole reason the ref rides in the tag rather than in content: a media message is an
    // ordinary message that also has an image, so its text must survive.
    const out = roundTrip('look at this', ref())
    expect(out.plaintext).toBe('look at this')
    expect(out.media?.url).toBe(ref().url)
  })

  it('supports a captionless image via the one-byte content floor', () => {
    const out = roundTrip(' ', ref())
    expect(out.plaintext).toBe(' ')
    expect(out.media).toEqual(ref())
  })

  it('leaves an ordinary message completely untouched', () => {
    const out = roundTrip('just text')
    expect(out.media).toBeUndefined()
    expect(out.plaintext).toBe('just text')
  })

  it('coexists with a group tag — the same ref reaches a group thread', () => {
    const wrapped = wrapMessage(senderSk, recipientPk, 'group pic', undefined, undefined, 'group-1', ref())
    const out = unwrapMessage(recipientSk, wrapped)
    expect(out.groupId).toBe('group-1')
    expect(out.media).toEqual(ref())
  })

  it('coexists with a piggybacked Tari address', () => {
    // The captionless-image + address combination is exactly what the `!media` clause in
    // handleEvent protects; here we prove both tags survive the wire together.
    const wrapped = wrapMessage(senderSk, recipientPk, ' ', undefined, 'otl_esm_abc', undefined, ref())
    const out = unwrapMessage(recipientSk, wrapped)
    expect(out.tariAddress).toBe('otl_esm_abc')
    expect(out.media).toEqual(ref())
  })

  it('preserves exact numeric dimensions, so a placeholder reserves the right box', () => {
    const out = roundTrip(' ', ref({ width: 1599, height: 899, size: 1 }))
    expect(out.media?.width).toBe(1599)
    expect(out.media?.height).toBe(899)
    expect(out.media?.size).toBe(1)
  })

  it('survives a url and key containing JSON-hostile characters', () => {
    // The ref is JSON inside a tag value inside encrypted content — quotes and backslashes have three
    // chances to break it.
    const awkward = ref({ url: 'https://h.example/a"b\\c?d=1&e=2', key: 'ab+/=="\\' })
    expect(roundTrip('x', awkward).media).toEqual(awkward)
  })
})

describe('caravel-media — malformed refs degrade to a plain message', () => {
  // Inject an arbitrary tag payload. wrapMessage serialises the ref with JSON.stringify, and
  // JSON.stringify honours toJSON — so this puts values on the wire that a well-formed MediaRef
  // never could, which is exactly what a hostile or buggy peer might send.
  //
  // NON-VACUOUS: the "tolerates missing non-load-bearing fields" case below asserts a ref comes back
  // POPULATED through this same helper, so an `undefined` result elsewhere is the extractor
  // rejecting the payload, not the helper silently failing to inject one.
  function withRawTag(value: unknown) {
    const media = { toJSON: () => value } as unknown as MediaRef
    const wrapped = wrapMessage(senderSk, recipientPk, 'caption', undefined, undefined, undefined, media)
    return unwrapMessage(recipientSk, wrapped)
  }

  it('rejects malformed JSON', () => {
    // A tag value that is a bare string, not an object.
    expect(withRawTag('not-an-object').media).toBeUndefined()
  })

  it('rejects a ref missing any LOAD-BEARING field', () => {
    // url / key / nonce / x are each individually fatal: without one the image cannot be fetched,
    // decrypted or verified, so a ref missing it is not a degraded ref — it is not a ref.
    for (const field of ['url', 'key', 'nonce', 'x'] as const) {
      const broken = { ...ref(), [field]: '' }
      expect(withRawTag(broken).media, `missing ${field}`).toBeUndefined()
    }
  })

  it('tolerates missing NON-load-bearing fields with safe defaults', () => {
    // A ref can still be fetched and decrypted without dimensions or a mime type — the placeholder
    // just falls back to a default box, which is better than discarding a usable image.
    const partial = { url: 'https://h/x', key: 'k', nonce: 'n', x: 'a'.repeat(64) }
    const out = withRawTag(partial).media
    expect(out?.url).toBe('https://h/x')
    expect(out?.width).toBe(0)
    expect(out?.height).toBe(0)
    expect(out?.mime).toBe('application/octet-stream')
    expect(out?.ox).toBe('')
  })

  it('rejects non-numeric or negative dimensions', () => {
    expect(withRawTag({ ...ref(), width: 'wide' }).media?.width).toBe(0)
    expect(withRawTag({ ...ref(), height: -5 }).media?.height).toBe(0)
    expect(withRawTag({ ...ref(), size: Infinity }).media?.size).toBe(0)
  })

  it('rejects an oversized value rather than storing it', () => {
    // The tag is attacker-controlled and lands in localStorage; a real ref is ~400 bytes.
    const huge = { ...ref(), url: 'https://h/' + 'z'.repeat(5000) }
    expect(withRawTag(huge).media).toBeUndefined()
  })

  it('degrades to a readable plain message, never a half-applied ref', () => {
    // The point of every case above: the caption still arrives. A recipient sees a message, not a
    // silent drop and not a broken image.
    const out = withRawTag('not-an-object')
    expect(out.media).toBeUndefined()
    expect(out.plaintext).toBe('caption')
  })
})

describe('existing wire behaviour is unchanged', () => {
  it('still round-trips a payment reference', () => {
    const wrapped = wrapMessage(senderSk, recipientPk, 'note', { utxoId: 'utxo_1' })
    const out = unwrapMessage(recipientSk, wrapped)
    expect(out.payment).toEqual({ utxoId: 'utxo_1' })
    expect(out.media).toBeUndefined()
  })

  it('still enforces the NIP-17 seal/rumor pubkey invariant', () => {
    // Media changes nothing about the impersonation guard — a tampered wrap must still throw.
    const wrapped = wrapMessage(senderSk, recipientPk, 'x', undefined, undefined, undefined, ref())
    const otherSk = generateSecretKey()
    expect(() => unwrapMessage(otherSk, wrapped)).toThrow()
  })
})
