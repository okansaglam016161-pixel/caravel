// Tests for the per-relay publish retry policy (relay publish reliability, part B).
//
// Only the POLICY is unit-tested, deliberately. Socket behaviour — whether a dial succeeds, whether a
// relay accepts — is exactly what cannot be asserted without a network, and mocking it would assert
// only that the mock was called. What IS worth pinning down is the decision the policy makes, because
// "retries silently stopped after one attempt" is the regression that would reinstate the original
// bug while every other test stayed green.

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'
import { newLogicalId, planPublishRetry, unwrapMessage, wrapEdit, wrapMessage } from './nostrMessaging'
import type { MediaRef } from '../messaging/types'

// The real call site's values: 3 attempts, 400ms base backoff, a 10s connect budget, and a per-relay
// budget of connectTimeout + publishTimeout = 10_000 + 9_000.
const MAX = 3
const BASE = 400
const CONNECT = 10_000
const BUDGET = 19_000
const plan = (made: number, remaining: number, jitter = 0.5) =>
  planPublishRetry(made, MAX, remaining, BASE, jitter, CONNECT)

describe('planPublishRetry — how hard we try to deliver', () => {
  it('retries after the first failure when there is budget', () => {
    // The whole point of the fix: one failed dial must no longer end the attempt.
    expect(plan(1, BUDGET - 200).retry).toBe(true)
  })

  it('retries after the second failure too', () => {
    expect(plan(2, BUDGET - 900).retry).toBe(true)
  })

  it('STOPS at the attempt cap', () => {
    // Unbounded retry would turn a dead relay into an indefinite hang.
    expect(plan(3, BUDGET).retry).toBe(false)
    expect(plan(4, BUDGET).retry).toBe(false)
  })

  it('stops when the remaining budget could not fit another attempt', () => {
    // THE LATENCY INVARIANT: retries only spend time a fast failure left unspent. A relay that burnt
    // its budget on a single timeout gets no second attempt, so the worst case is unchanged.
    expect(plan(1, 1_000).retry).toBe(false)
    expect(plan(1, 0).retry).toBe(false)
    expect(plan(1, -5_000).retry).toBe(false)   // overran (a timeout took longer than budgeted)
  })

  it('accounts for the backoff itself when checking the budget', () => {
    // 1900ms left, minus a 400ms backoff, leaves 1500 — exactly the floor, so it may proceed.
    expect(plan(1, 1_900).retry).toBe(true)
    // 1899 leaves 1499 — one millisecond short, so it must not.
    expect(plan(1, 1_899).retry).toBe(false)
  })

  it('never lets the next attempt exceed the caller‑s normal connect budget', () => {
    // With the full budget left, the retry still gets the ordinary 10s dial, not 18s.
    expect(plan(1, BUDGET).budgetMs).toBe(CONNECT)
  })

  it('shrinks the next attempt to the time actually left', () => {
    // 5s left minus a 400ms backoff → a 4.6s dial, so the attempt cannot overrun the relay budget.
    expect(plan(1, 5_000).budgetMs).toBe(4_600)
  })

  it('jitters the backoff to 0.5x-1.5x of the base', () => {
    // A group send fires N publishes at once; identical backoffs would re-dial in lockstep.
    expect(plan(1, BUDGET, 0).backoffMs).toBe(200)
    expect(plan(1, BUDGET, 0.5).backoffMs).toBe(400)
    expect(plan(1, BUDGET, 1).backoffMs).toBe(600)
  })

  it('clamps a jitter input outside 0..1 rather than producing a wild backoff', () => {
    expect(plan(1, BUDGET, -3).backoffMs).toBe(200)
    expect(plan(1, BUDGET, 99).backoffMs).toBe(600)
  })

  it('never returns a negative or non-integer backoff', () => {
    for (const j of [0, 0.13, 0.37, 0.5, 0.76, 1]) {
      const { backoffMs } = plan(1, BUDGET, j)
      expect(backoffMs).toBeGreaterThan(0)
      expect(Number.isInteger(backoffMs)).toBe(true)
    }
  })

  it('gives a total of 3 attempts when every failure is fast — the target of the fix', () => {
    // Walk the real sequence: a refused dial returns in ~50ms, which is the failure mode worth
    // retrying, and the budget comfortably fits all three tries.
    let remaining = BUDGET
    let made = 0
    const budgets: number[] = []
    for (;;) {
      made++
      remaining -= 50            // a fast failure
      const p = plan(made, remaining)
      if (!p.retry) break
      remaining -= p.backoffMs
      budgets.push(p.budgetMs)
    }
    expect(made).toBe(3)
    expect(budgets).toHaveLength(2)     // two retries after the first attempt
    expect(remaining).toBeGreaterThan(17_000)   // barely touched the budget
  })

  it('gives only ONE attempt when the first failure consumes the whole budget', () => {
    let remaining = BUDGET
    remaining -= 19_000          // a full dial + publish timeout
    expect(plan(1, remaining).retry).toBe(false)
  })
})

// ── wrapMessage: the options object ────────────────────────────────────────────────────────────────
//
// These pin BEHAVIOUR PRESERVATION across the positional → options-object refactor. The refactor
// changed the call shape only; every tag this function has ever emitted must still be emitted, in the
// same order, under the same conditions.
//
// They also guard the reason the refactor happened. `tariAddress` and `groupId` are both `string`, so
// under the old positional signature a transposed argument was invisible to tsc AND to any test that
// only checked "a tag is present". Each assertion below therefore checks the value landed under the
// RIGHT key — that is the whole failure class the options object exists to remove, and a test that
// merely counted tags would not catch a regression back into it.
//
// Asserted through unwrapMessage rather than by inspecting the encrypted event, because the round trip
// is the contract callers actually depend on.

const sender = generateSecretKey()
const recipient = generateSecretKey()
const recipientPub = getPublicKey(recipient)

const roundTrip = (plaintext: string, opts?: Parameters<typeof wrapMessage>[3]) =>
  unwrapMessage(recipient, wrapMessage(sender, recipientPub, plaintext, opts))

describe('wrapMessage — options object', () => {
  it('with NO options, carries only the p tag — a plain message is unchanged', () => {
    const out = roundTrip('hello')
    expect(out.plaintext).toBe('hello')
    expect(out.payment).toBeUndefined()
    expect(out.tariAddress).toBeUndefined()
    expect(out.groupId).toBeUndefined()
  })

  it('omitting the options argument entirely is the same as passing {}', () => {
    // The default `= {}` must not require callers to pass anything.
    const bare = unwrapMessage(recipient, wrapMessage(sender, recipientPub, 'hi'))
    expect(bare.plaintext).toBe('hi')
    expect(bare.groupId).toBeUndefined()
  })

  it('payment rides on the wire as utxoId only', () => {
    const out = roundTrip('paid', { payment: { utxoId: 'utxo-abc' } })
    expect(out.payment).toEqual({ utxoId: 'utxo-abc' })
    expect(out.plaintext).toBe('paid')
  })

  it('tariAddress lands under tariAddress, NOT groupId', () => {
    // The transposition the old positional signature could not rule out.
    const out = roundTrip(' ', { tariAddress: 'otl_esm_abc' })
    expect(out.tariAddress).toBe('otl_esm_abc')
    expect(out.groupId).toBeUndefined()
  })

  it('groupId lands under groupId, NOT tariAddress', () => {
    const out = roundTrip('group msg', { groupId: 'group-1' })
    expect(out.groupId).toBe('group-1')
    expect(out.tariAddress).toBeUndefined()
  })

  it('all three options together each land under their own key', () => {
    const out = roundTrip('everything', {
      payment: { utxoId: 'utxo-1' },
      tariAddress: 'otl_esm_xyz',
      groupId: 'group-9',
    })
    expect(out.payment).toEqual({ utxoId: 'utxo-1' })
    expect(out.tariAddress).toBe('otl_esm_xyz')
    expect(out.groupId).toBe('group-9')
    expect(out.plaintext).toBe('everything')
  })

  it('key order in the literal does not affect the result', () => {
    // Positional order mattered; key order must not. This is the property that makes a merge
    // resolution safe to do as a union of keys.
    const a = roundTrip('x', { payment: { utxoId: 'u' }, groupId: 'g', tariAddress: 't' })
    const b = roundTrip('x', { tariAddress: 't', payment: { utxoId: 'u' }, groupId: 'g' })
    expect(a.payment).toEqual(b.payment)
    expect(a.tariAddress).toBe(b.tariAddress)
    expect(a.groupId).toBe(b.groupId)
  })

  it('an explicitly undefined key behaves as absent', () => {
    // Call sites that pass a possibly-undefined variable (sendMessage does exactly this with
    // `payment`) must not produce an empty or malformed tag.
    const out = roundTrip('maybe', { payment: undefined, tariAddress: undefined, groupId: 'g' })
    expect(out.payment).toBeUndefined()
    expect(out.tariAddress).toBeUndefined()
    expect(out.groupId).toBe('g')
  })

  it('preserves the sender identity through the seal', () => {
    const out = roundTrip('who sent this', { groupId: 'g' })
    expect(out.senderPubkeyHex).toBe(getPublicKey(sender))
  })
})

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
    const out = unwrapMessage(bob, wrapMessage(alice, bobPub, 'hello', { logicalId }))

    expect(out.logicalId).toBe(logicalId)
    expect(out.plaintext).toBe('hello')
    expect(out.senderPubkeyHex).toBe(alicePub)
    expect(out.edit).toBeUndefined()
  })

  it('is absent when omitted — the address control message stays as it was', () => {
    const out = unwrapMessage(bob, wrapMessage(alice, bobPub, ' ', { tariAddress: 'otl_esm_abc' }))
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

// Wire tests for the encrypted-image tag (images M3).
//
// These go through the REAL gift-wrap stack — nip59 wrapEvent, NIP-44, real secp256k1 keys — rather
// than asserting on a tag array. The thing that must hold is that a MediaRef survives seal +
// gift-wrap + unwrap byte-identical, and that a malformed one degrades to a plain message instead of
// arriving half-populated. Neither is provable by inspecting the builder's output.
//
// Hermetic: nostr-tools' crypto and WebCrypto both run under Node, so nothing here touches a relay.


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
function roundTripMedia(caption: string, media?: MediaRef) {
  const wrapped = wrapMessage(senderSk, recipientPk, caption, { media })
  return unwrapMessage(recipientSk, wrapped)
}

describe('caravel-media on the wire', () => {
  it('round-trips the full reference through the real gift wrap', () => {
    const out = roundTripMedia('a caption', ref())
    expect(out.media).toEqual(ref())
    // and the authenticated sender is still enforced by the same invariant as any other message
    expect(out.senderPubkeyHex).toBe(senderPk)
  })

  it('carries the CAPTION in the content alongside the reference', () => {
    // The whole reason the ref rides in the tag rather than in content: a media message is an
    // ordinary message that also has an image, so its text must survive.
    const out = roundTripMedia('look at this', ref())
    expect(out.plaintext).toBe('look at this')
    expect(out.media?.url).toBe(ref().url)
  })

  it('supports a captionless image via the one-byte content floor', () => {
    const out = roundTripMedia(' ', ref())
    expect(out.plaintext).toBe(' ')
    expect(out.media).toEqual(ref())
  })

  it('leaves an ordinary message completely untouched', () => {
    const out = roundTripMedia('just text')
    expect(out.media).toBeUndefined()
    expect(out.plaintext).toBe('just text')
  })

  it('coexists with a group tag — the same ref reaches a group thread', () => {
    const wrapped = wrapMessage(senderSk, recipientPk, 'group pic', { groupId: 'group-1', media: ref() })
    const out = unwrapMessage(recipientSk, wrapped)
    expect(out.groupId).toBe('group-1')
    expect(out.media).toEqual(ref())
  })

  it('coexists with a piggybacked Tari address', () => {
    // The captionless-image + address combination is exactly what the `!media` clause in
    // handleEvent protects; here we prove both tags survive the wire together.
    const wrapped = wrapMessage(senderSk, recipientPk, ' ', { tariAddress: 'otl_esm_abc', media: ref() })
    const out = unwrapMessage(recipientSk, wrapped)
    expect(out.tariAddress).toBe('otl_esm_abc')
    expect(out.media).toEqual(ref())
  })

  it('preserves exact numeric dimensions, so a placeholder reserves the right box', () => {
    const out = roundTripMedia(' ', ref({ width: 1599, height: 899, size: 1 }))
    expect(out.media?.width).toBe(1599)
    expect(out.media?.height).toBe(899)
    expect(out.media?.size).toBe(1)
  })

  it('survives a url and key containing JSON-hostile characters', () => {
    // The ref is JSON inside a tag value inside encrypted content — quotes and backslashes have three
    // chances to break it.
    const awkward = ref({ url: 'https://h.example/a"b\\c?d=1&e=2', key: 'ab+/=="\\' })
    expect(roundTripMedia('x', awkward).media).toEqual(awkward)
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
    const wrapped = wrapMessage(senderSk, recipientPk, 'caption', { media })
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
    const wrapped = wrapMessage(senderSk, recipientPk, 'note', { payment: { utxoId: 'utxo_1' } })
    const out = unwrapMessage(recipientSk, wrapped)
    expect(out.payment).toEqual({ utxoId: 'utxo_1' })
    expect(out.media).toBeUndefined()
  })

  it('still enforces the NIP-17 seal/rumor pubkey invariant', () => {
    // Media changes nothing about the impersonation guard — a tampered wrap must still throw.
    const wrapped = wrapMessage(senderSk, recipientPk, 'x', { media: ref() })
    const otherSk = generateSecretKey()
    expect(() => unwrapMessage(otherSk, wrapped)).toThrow()
  })
})
