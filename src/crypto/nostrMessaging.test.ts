// Tests for the per-relay publish retry policy (relay publish reliability, part B).
//
// Only the POLICY is unit-tested, deliberately. Socket behaviour — whether a dial succeeds, whether a
// relay accepts — is exactly what cannot be asserted without a network, and mocking it would assert
// only that the mock was called. What IS worth pinning down is the decision the policy makes, because
// "retries silently stopped after one attempt" is the regression that would reinstate the original
// bug while every other test stayed green.

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { planPublishRetry, unwrapMessage, wrapMessage } from './nostrMessaging'

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
