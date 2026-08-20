// Unit tests for the reactions render logic (C). The two view components have no tests — there is
// no component harness in this repo, and vitest.config.ts does not even collect .tsx — so the rules
// that decide what a reader SEES live here, where they can be pinned.

import { describe, expect, it } from 'vitest'
import { aggregateReactions, atReactionLimit, canReactTo, myReactions } from './reactionDisplay'
import type { CaravelMessage, ReactionEntry } from '../../messaging/types'

const ME = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const OTHER = 'c'.repeat(64)

function msg(reactions?: ReactionEntry[], over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: 'e1',
    senderPubkeyHex: PEER,
    recipientPubkeyHex: ME,
    plaintext: 'hi',
    timestamp: 1_000,
    direction: 'received',
    logicalId: 'L1',
    ...(reactions ? { reactions } : {}),
    ...over,
  }
}

describe('canReactTo', () => {
  it('accepts an ordinary text message, mine or theirs', () => {
    expect(canReactTo(msg())).toBe(true)
    expect(canReactTo(msg(undefined, { direction: 'sent', senderPubkeyHex: ME }))).toBe(true)
  })

  it('refuses a row with no logical id — nothing a reaction could name', () => {
    expect(canReactTo(msg(undefined, { logicalId: undefined }))).toBe(false)
  })

  it('refuses system, payment and media rows (text only in v1)', () => {
    expect(canReactTo(msg(undefined, { system: 'group-leave', plaintext: '' }))).toBe(false)
    expect(canReactTo(msg(undefined, { payment: { utxoId: 'u' } }))).toBe(false)
    expect(canReactTo(msg(undefined, {
      media: { url: 'u', key: 'k', nonce: 'n', mime: 'image/webp', x: 'x', ox: 'o', width: 1, height: 1, size: 1 },
    }))).toBe(false)
  })
})

describe('aggregateReactions', () => {
  it('returns nothing for a message with no reactions', () => {
    expect(aggregateReactions(msg(), ME)).toEqual([])
    expect(aggregateReactions(msg([]), ME)).toEqual([])
  })

  it('counts one pill per emoji and lists who used it', () => {
    const out = aggregateReactions(msg([
      { by: PEER, emoji: '👍', seq: 1, at: 10 },
      { by: OTHER, emoji: '👍', seq: 1, at: 20 },
      { by: ME, emoji: '🙏', seq: 1, at: 30 },
    ]), ME)

    expect(out).toEqual([
      { emoji: '👍', count: 2, mine: false, who: [PEER, OTHER] },
      { emoji: '🙏', count: 1, mine: true, who: [ME] },
    ])
  })

  it('flags `mine` when I am one of several on the same emoji', () => {
    const out = aggregateReactions(msg([
      { by: PEER, emoji: '👍', seq: 1, at: 10 },
      { by: ME, emoji: '👍', seq: 1, at: 20 },
    ]), ME)
    expect(out[0]).toMatchObject({ count: 2, mine: true })
  })

  it('DROPS tombstoned rows — they exist only to carry the seq high-water', () => {
    const out = aggregateReactions(msg([
      { by: PEER, emoji: '👍', seq: 2, at: 10, removed: true },
      { by: PEER, emoji: '🙏', seq: 1, at: 20 },
    ]), ME)
    expect(out.map(s => s.emoji)).toEqual(['🙏'])
  })

  it('drops an emoji entirely once its last live reactor removes it', () => {
    const out = aggregateReactions(msg([{ by: PEER, emoji: '👍', seq: 2, at: 10, removed: true }]), ME)
    expect(out).toEqual([])
  })

  it('orders pills by when this device first saw the emoji, not by count', () => {
    // A pill must not jump position because somebody else joined it.
    const out = aggregateReactions(msg([
      { by: PEER, emoji: '🙏', seq: 1, at: 10 },
      { by: PEER, emoji: '👍', seq: 1, at: 20 },
      { by: OTHER, emoji: '👍', seq: 1, at: 30 },
      { by: ME, emoji: '👍', seq: 1, at: 40 },
    ]), ME)
    expect(out.map(s => s.emoji)).toEqual(['🙏', '👍'])
    expect(out[1].count).toBe(3)
  })

  it('breaks an `at` tie on the emoji, so the order never depends on array order', () => {
    const a = aggregateReactions(msg([
      { by: PEER, emoji: '🙏', seq: 1, at: 10 },
      { by: OTHER, emoji: '👍', seq: 1, at: 10 },
    ]), ME).map(s => s.emoji)
    const b = aggregateReactions(msg([
      { by: OTHER, emoji: '👍', seq: 1, at: 10 },
      { by: PEER, emoji: '🙏', seq: 1, at: 10 },
    ]), ME).map(s => s.emoji)
    expect(a).toEqual(b)
  })

  it('caps each person at two live reactions, keeping their earliest', () => {
    // The applier tombstones a third before it is stored, so this is a backstop for a row written
    // by a future or misbehaving version — it must render within the rule, not widen the strip.
    const out = aggregateReactions(msg([
      { by: PEER, emoji: '👍', seq: 1, at: 10 },
      { by: PEER, emoji: '🙏', seq: 1, at: 20 },
      { by: PEER, emoji: '😂', seq: 1, at: 30 },
    ]), ME)
    expect(out.map(s => s.emoji)).toEqual(['👍', '🙏'])
  })

  it('caps per person, not per message', () => {
    const out = aggregateReactions(msg([
      { by: PEER, emoji: '👍', seq: 1, at: 10 },
      { by: PEER, emoji: '🙏', seq: 1, at: 20 },
      { by: OTHER, emoji: '😂', seq: 1, at: 30 },
      { by: ME, emoji: '😮', seq: 1, at: 40 },
    ]), ME)
    expect(out.map(s => s.emoji)).toEqual(['👍', '🙏', '😂', '😮'])
  })

  it('is deterministic regardless of the stored array order', () => {
    const rows: ReactionEntry[] = [
      { by: PEER, emoji: '👍', seq: 1, at: 30 },
      { by: OTHER, emoji: '🙏', seq: 1, at: 10 },
      { by: ME, emoji: '👍', seq: 1, at: 20 },
    ]
    const forward = aggregateReactions(msg(rows), ME)
    const reversed = aggregateReactions(msg([...rows].reverse()), ME)
    expect(forward).toEqual(reversed)
  })
})

describe('myReactions / atReactionLimit', () => {
  const held: ReactionEntry[] = [
    { by: ME, emoji: '👍', seq: 1, at: 10 },
    { by: ME, emoji: '🙏', seq: 1, at: 20 },
    { by: PEER, emoji: '😂', seq: 1, at: 30 },
  ]

  it('lists only my LIVE reactions', () => {
    expect(myReactions(msg(held), ME)).toEqual(['👍', '🙏'])
    expect(myReactions(msg([{ by: ME, emoji: '👍', seq: 2, at: 10, removed: true }]), ME)).toEqual([])
    expect(myReactions(msg(), ME)).toEqual([])
  })

  it('reports the limit once I hold two', () => {
    expect(atReactionLimit(msg(held), ME)).toBe(true)
  })

  it('is not at the limit while I hold fewer than two', () => {
    expect(atReactionLimit(msg([{ by: ME, emoji: '👍', seq: 1, at: 10 }]), ME)).toBe(false)
    expect(atReactionLimit(msg(), ME)).toBe(false)
  })

  it('counts only MY reactions toward my allowance', () => {
    const crowded: ReactionEntry[] = [
      { by: PEER, emoji: '👍', seq: 1, at: 10 },
      { by: OTHER, emoji: '🙏', seq: 1, at: 20 },
    ]
    expect(atReactionLimit(msg(crowded), ME)).toBe(false)
  })

  it('a tombstoned reaction of mine frees the slot', () => {
    expect(atReactionLimit(msg([
      { by: ME, emoji: '👍', seq: 1, at: 10 },
      { by: ME, emoji: '🙏', seq: 2, at: 20, removed: true },
    ]), ME)).toBe(false)
  })
})
