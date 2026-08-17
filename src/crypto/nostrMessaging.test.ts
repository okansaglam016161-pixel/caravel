// Tests for the per-relay publish retry policy (relay publish reliability, part B).
//
// Only the POLICY is unit-tested, deliberately. Socket behaviour — whether a dial succeeds, whether a
// relay accepts — is exactly what cannot be asserted without a network, and mocking it would assert
// only that the mock was called. What IS worth pinning down is the decision the policy makes, because
// "retries silently stopped after one attempt" is the regression that would reinstate the original
// bug while every other test stayed green.

import { describe, expect, it } from 'vitest'
import { planPublishRetry } from './nostrMessaging'

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
