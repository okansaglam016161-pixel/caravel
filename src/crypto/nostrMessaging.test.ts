// Wire-level tests for the M2 edit tags (caravel-msgid / caravel-edit).
//
// Two kinds of coverage here:
//   1. UNTRUSTED INPUT — extractMsgId/extractEdit see whatever a peer put in the rumor, and a
//      malformed edit must degrade to "not an edit" (the rumor then shows as a plain message)
//      rather than being half-applied. These go through a real wrap/unwrap so the tag genuinely
//      survives the seal + gift wrap rather than being asserted against a hand-built array.
//   2. AUTHENTICATED SENDER — the whole authorship guard rests on unwrapMessage returning
//      seal.pubkey, so the round trip proves the editor identity the receiver checks is the real
//      signer and not something the payload can claim.

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'
import { newLogicalId, unwrapMessage, wrapEdit, wrapMessage } from './nostrMessaging'

const alice = generateSecretKey()
const bob = generateSecretKey()
const alicePub = getPublicKey(alice)
const bobPub = getPublicKey(bob)

// Build a rumor with arbitrary tags and gift-wrap it to Bob, so malformed input can be fed through
// the real crypto path exactly as a hostile peer would deliver it.
function wrapRawTags(tags: string[][], content = 'payload') {
  return wrapEvent({ kind: 14, created_at: Math.round(Date.now() / 1000), content, tags }, alice, bobPub)
}

describe('newLogicalId', () => {
  it('mints 32 hex chars, distinct per call', () => {
    const a = newLogicalId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(newLogicalId())
  })
})

describe('caravel-msgid on the wire', () => {
  it('round-trips a logical id on an ordinary message', () => {
    const logicalId = newLogicalId()
    const out = unwrapMessage(bob, wrapMessage(alice, bobPub, 'hello', undefined, undefined, undefined, logicalId))

    expect(out.logicalId).toBe(logicalId)
    expect(out.plaintext).toBe('hello')
    expect(out.senderPubkeyHex).toBe(alicePub)
    expect(out.edit).toBeUndefined()
  })

  it('is absent when omitted — the address control message stays as it was', () => {
    const out = unwrapMessage(bob, wrapMessage(alice, bobPub, ' ', undefined, 'otl_esm_abc'))
    expect(out.logicalId).toBeUndefined()
    expect(out.tariAddress).toBe('otl_esm_abc')
  })

  it('rejects an unknown version and an over-long id', () => {
    expect(unwrapMessage(bob, wrapRawTags([['caravel-msgid', 'v2', newLogicalId()]])).logicalId).toBeUndefined()
    expect(unwrapMessage(bob, wrapRawTags([['caravel-msgid', 'v1', 'x'.repeat(65)]])).logicalId).toBeUndefined()
    expect(unwrapMessage(bob, wrapRawTags([['caravel-msgid', 'v1', '']])).logicalId).toBeUndefined()
  })
})

describe('caravel-edit on the wire', () => {
  it('round-trips target, revision and new text — and reports the AUTHENTICATED sender', () => {
    const target = newLogicalId()
    const out = unwrapMessage(bob, wrapEdit(alice, bobPub, target, 'corrected text', 3))

    expect(out.edit).toEqual({ targetLogicalId: target, revision: 3 })
    expect(out.plaintext).toBe('corrected text')      // new text rides in content, not a tag
    // This is the value the receiver checks against the original message's sender. It comes from
    // seal.pubkey, which unwrapMessage verifies equals the rumor pubkey — so it cannot be claimed.
    expect(out.senderPubkeyHex).toBe(alicePub)
  })

  it('degrades to a plain message on an unknown version', () => {
    const out = unwrapMessage(bob, wrapRawTags([['caravel-edit', 'v2', newLogicalId(), '1']], 'text'))
    expect(out.edit).toBeUndefined()
    expect(out.plaintext).toBe('text')                 // falls through to the ordinary path
  })

  it('rejects a malformed target', () => {
    expect(unwrapMessage(bob, wrapRawTags([['caravel-edit', 'v1', '', '1']])).edit).toBeUndefined()
    expect(unwrapMessage(bob, wrapRawTags([['caravel-edit', 'v1', 'x'.repeat(65), '1']])).edit).toBeUndefined()
  })

  it('rejects every non positive-integer revision', () => {
    const t = newLogicalId()
    for (const bad of ['0', '-1', '1.5', '', 'abc', ' 1 ', '1e3', '0x2', '01']) {
      expect(unwrapMessage(bob, wrapRawTags([['caravel-edit', 'v1', t, bad]])).edit,
        `revision ${JSON.stringify(bad)} must be rejected`).toBeUndefined()
    }
    // ...and a missing revision field entirely
    expect(unwrapMessage(bob, wrapRawTags([['caravel-edit', 'v1', t]])).edit).toBeUndefined()
  })

  it('accepts a large but safe revision', () => {
    const t = newLogicalId()
    expect(unwrapMessage(bob, wrapRawTags([['caravel-edit', 'v1', t, '9007199254740991']])).edit)
      .toEqual({ targetLogicalId: t, revision: 9007199254740991 })
  })
})
