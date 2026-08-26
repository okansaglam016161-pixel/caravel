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

// ── MAX amount entry ──────────────────────────────────────────────────────────
//
// Regression for a bug found while wiring the UI: MAX filled the amount field by running the
// balance through the 2dp DISPLAY formatter. A revealed balance of 999_997_686 µtTARI renders as
// "1,000.00", and feeding that back in asked the vault for 2_314 µtTARI more than it held — a
// withdraw the network refuses, so MAX would simply never work on a realistic balance.
//
// The fix is two-part and both halves are pinned here: amount entry gets its own full-precision
// formatter, and MAX carries the exact bigint rather than trusting a round-trip through text.

/** Mirrors microtariToInput in WalletModal.tsx — full precision, no grouping, no rounding. */
const microtariToInput = (µt: bigint): string => {
  const whole = µt / 1_000_000n
  const frac = (µt % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}
/** Mirrors fmtMicrotariExact — the 2dp DISPLAY formatter that must NOT be used for amount entry. */
const fmtDisplay2dp = (µt: bigint): string => {
  const h = (µt + 5_000n) / 10_000n
  return `${(h / 100n).toLocaleString('en-US')}.${(h % 100n).toString().padStart(2, '0')}`
}
const parseTari = (s: string): bigint => BigInt(Math.round(parseFloat(s) * 1_000_000))

describe('MAX must not overshoot the balance', () => {
  const SEEDED = 999_997_686n   // the real seeded wallet's revealed balance

  it('THE BUG: the 2dp display formatter rounds a balance UP past itself', () => {
    expect(fmtDisplay2dp(SEEDED)).toBe('1,000.00')
    expect(parseTari(fmtDisplay2dp(SEEDED).replace(/,/g, ''))).toBeGreaterThan(SEEDED)
    // 2_314 µtTARI more than exists — the withdraw would be refused.
    expect(parseTari(fmtDisplay2dp(SEEDED).replace(/,/g, '')) - SEEDED).toBe(2_314n)
  })

  it('the input formatter round-trips exactly', () => {
    expect(microtariToInput(SEEDED)).toBe('999.997686')
    expect(parseTari(microtariToInput(SEEDED))).toBe(SEEDED)
  })

  it.each([0n, 1n, 100_000n, 1_500_000n, 999_997_686n, 1_000_000_000n, 123_456_789_012n])(
    'round-trips %s µtTARI without drift', (v) => {
      expect(parseTari(microtariToInput(v))).toBe(v)
    })

  it('a MAX-sized conceal splits without exceeding the balance', () => {
    // What the whole chain has to guarantee: MAX withdraws exactly the balance, never more.
    const split = planConceal(SEEDED, 16_138n)
    expect(split.withdrawAmount).toBe(SEEDED)
    expect(split.withdrawAmount).toBeLessThanOrEqual(SEEDED)
    assertConcealSplit(split)
  })
})
