// Tests for the conceal split (M2 C1).
//
// This is the fund-critical arithmetic of the milestone. The engine compares the withdrawn bucket
// against the statement's revealed input with NO tolerance
// (tari-ootle: runtime/working_state.rs:2062-2074), so any drift between those two numbers is a
// rejected transaction — and, in the class of bug that produces it, potentially a withdraw that
// does not match what the statement spends.
//
// planConceal exists so that number is computed ONCE. These tests pin that: the identity
// `withdrawAmount === amount`, the balance `stealth + fee === withdraw`, and the refusals that keep
// a degenerate split from ever reaching a transaction builder.

import { describe, expect, it } from 'vitest'
import { MIN_CONCEAL_MICROTARI, assertConcealSplit, planConceal } from './conceal'

const TARI = 1_000_000n

describe('planConceal — the withdraw amount IS the statement input', () => {
  it('withdraws exactly the amount asked for', () => {
    // The identity the engine checks. Whatever else changes, this must not.
    const split = planConceal(100n * TARI, 15_000n)
    expect(split.withdrawAmount).toBe(100n * TARI)
  })

  it('carves the fee out of the amount, leaving the rest private', () => {
    const split = planConceal(100n * TARI, 15_000n)
    expect(split.stealthAmount).toBe(100n * TARI - 15_000n)
    expect(split.feeMicrotari).toBe(15_000n)
  })

  it('balances: stealth + fee === withdraw, at every scale', () => {
    for (const amount of [MIN_CONCEAL_MICROTARI, 1n * TARI, 999_595_988n, 1_000n * TARI, 2n ** 63n]) {
      for (const fee of [1n, 13_211n, 16_138n, 50_000n]) {
        if (fee >= amount) continue
        const s = planConceal(amount, fee)
        expect(s.stealthAmount + s.feeMicrotari).toBe(s.withdrawAmount)
        expect(s.withdrawAmount).toBe(amount)
      }
    }
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    // Amounts are 128-bit; a split that went through Number would drift here.
    const amount = 18_446_744_073_709_551_615n
    const s = planConceal(amount, 16_138n)
    expect(s.stealthAmount).toBe(18_446_744_073_709_535_477n)
    expect(s.stealthAmount + s.feeMicrotari).toBe(amount)
  })

  it('handles the MAX case — concealing an entire revealed balance', () => {
    // The whole balance leaves the vault, so the withdraw can never exceed what is there. This is
    // why the amount is defined as "moved out" rather than "landed private".
    const balance = 999_595_988n
    const s = planConceal(balance, 16_138n)
    expect(s.withdrawAmount).toBe(balance)
    expect(s.stealthAmount).toBe(999_579_850n)
  })

  it('allows a fee one below the amount — the tightest legal split', () => {
    const s = planConceal(1000n, 999n)
    expect(s.stealthAmount).toBe(1n)
    assertConcealSplit(s)
  })
})

describe('planConceal — refusals', () => {
  it('refuses a fee that equals the amount (zero stealth output is not a conceal)', () => {
    expect(() => planConceal(15_000n, 15_000n)).toThrow(/not covered by the amount/)
  })

  it('refuses a fee above the amount', () => {
    expect(() => planConceal(10_000n, 15_000n)).toThrow(/not covered by the amount/)
  })

  it.each([0n, -1n, -1_000_000n])('refuses a non-positive amount (%s)', (amount) => {
    expect(() => planConceal(amount, 1_000n)).toThrow(/Amount must be greater than zero/)
  })

  it.each([0n, -1n])('refuses a non-positive fee (%s)', (fee) => {
    expect(() => planConceal(100n * TARI, fee)).toThrow(/Fee must be greater than zero/)
  })
})

describe('assertConcealSplit — the tripwire for a future second derivation', () => {
  it('passes every split planConceal produces', () => {
    expect(() => assertConcealSplit(planConceal(100n * TARI, 16_138n))).not.toThrow()
  })

  it('catches a withdraw that drifted from the statement input', () => {
    // The exact bug this guards: someone recomputes the withdraw amount separately and the two
    // stop agreeing. On-chain this is an opaque bucket-mismatch rejection; here it is a caught bug.
    const drifted = { withdrawAmount: 100n * TARI + 1n, stealthAmount: 100n * TARI - 16_138n, feeMicrotari: 16_138n }
    expect(() => assertConcealSplit(drifted)).toThrow(/does not balance/)
  })

  it('catches a stealth amount that drifted', () => {
    const drifted = { withdrawAmount: 100n * TARI, stealthAmount: 99n * TARI, feeMicrotari: 16_138n }
    expect(() => assertConcealSplit(drifted)).toThrow(/does not balance/)
  })

  it.each([
    ['zero stealth', { withdrawAmount: 16_138n, stealthAmount: 0n, feeMicrotari: 16_138n }],
    ['zero fee', { withdrawAmount: 100n, stealthAmount: 100n, feeMicrotari: 0n }],
    ['zero withdraw', { withdrawAmount: 0n, stealthAmount: 0n, feeMicrotari: 0n }],
    ['negative stealth', { withdrawAmount: 100n, stealthAmount: -1n, feeMicrotari: 101n }],
  ])('refuses a non-positive component (%s)', (_label, split) => {
    expect(() => assertConcealSplit(split)).toThrow(/non-positive component/)
  })
})

describe('MIN_CONCEAL_MICROTARI', () => {
  it('sits above the dry-run probe, so a legal amount can always be simulated', () => {
    // The probe reserves 50_000 out of the amount being moved. An amount at or below that cannot be
    // simulated at all, which is what this floor exists to prevent.
    expect(MIN_CONCEAL_MICROTARI).toBeGreaterThan(50_000n)
  })

  it('sits above every fee measured on this network', () => {
    // Largest observed real fee to date: 16 138 µtTARI (a send, 2026-08-20).
    expect(MIN_CONCEAL_MICROTARI).toBeGreaterThan(16_138n)
  })

  it('produces a viable split at exactly the floor', () => {
    const s = planConceal(MIN_CONCEAL_MICROTARI, 16_138n)
    expect(s.stealthAmount).toBeGreaterThan(0n)
    assertConcealSplit(s)
  })
})
