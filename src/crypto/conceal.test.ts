// Tests for the conceal split (M2 C1).
//
// This is the fund-critical arithmetic of the milestone. The engine compares the withdrawn bucket
// against the statement's revealed input with NO tolerance
// (tari-ootle: runtime/working_state.rs:2062-2074), so any drift between those two numbers is a
// rejected transaction — and, in the class of bug that produces it, potentially a withdraw that
// does not match what the statement spends.
//
// planConceal exists so that number is computed ONCE. These tests pin that: what lands private is
// exactly what was asked for, the fee is a separate budget paid from the vault (refunded down to the
// cost), MAX (`all`) moves balance − fee, and the refusals that keep a degenerate split from ever
// reaching a transaction builder.

import { describe, expect, it } from 'vitest'
import { CONCEAL_FEE_RESERVE, MIN_CONCEAL_MICROTARI, assertConcealSplit, maxConcealTyped, planConceal } from './conceal'

const TARI = 1_000_000n

describe('planConceal — the fee on top: the amount typed is the amount that lands private', () => {
  it('lands exactly the amount asked for, and withdraws exactly that into the bucket', () => {
    const split = planConceal(2n * TARI, 9_491n)
    expect(split.stealthAmount).toBe(2n * TARI)
    expect(split.withdrawAmount).toBe(2n * TARI)
  })

  it('the fee is a separate budget, paid from the vault and refunded down to the cost', () => {
    expect(planConceal(2n * TARI, 9_491n).feeBudget).toBe(9_491n)
  })

  it('balances: the withdraw becomes the stealth output, whole, at every scale', () => {
    for (const amount of [MIN_CONCEAL_MICROTARI, 1n * TARI, 999_595_988n, 1_000n * TARI, 2n ** 63n]) {
      for (const fee of [1n, 9_291n, 16_138n, 50_000n]) {
        const s = planConceal(amount, fee)
        expect(s.stealthAmount).toBe(s.withdrawAmount)
        expect(s.stealthAmount).toBe(amount)
      }
    }
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    const amount = 18_446_744_073_709_551_615n
    expect(planConceal(amount, 16_138n).stealthAmount).toBe(amount)
  })
})

describe('planConceal — `all` (MAX): the whole balance leaves, the exact fee out of it', () => {
  it('moves balance − fee, so the vault empties exactly once the fee is taken', () => {
    const balance = 999_595_988n
    const s = planConceal(balance, 16_138n, true)
    expect(s.withdrawAmount).toBe(999_579_850n)
    expect(s.stealthAmount).toBe(999_579_850n)
    expect(s.withdrawAmount + s.feeBudget).toBe(balance)
  })

  it('allows a fee one below the balance — the tightest legal split', () => {
    const s = planConceal(1000n, 999n, true)
    expect(s.stealthAmount).toBe(1n)
    assertConcealSplit(s)
  })

  it('refuses a fee that equals or exceeds the balance (no stealth output is not a conceal)', () => {
    expect(() => planConceal(15_000n, 15_000n, true)).toThrow(/not covered by the amount/)
    expect(() => planConceal(10_000n, 15_000n, true)).toThrow(/not covered by the amount/)
  })
})

describe('planConceal — refusals', () => {
  it.each([0n, -1n, -1_000_000n])('refuses a non-positive amount (%s)', (amount) => {
    expect(() => planConceal(amount, 1_000n)).toThrow(/Amount must be greater than zero/)
    expect(() => planConceal(amount, 1_000n, true)).toThrow(/Amount must be greater than zero/)
  })

  it.each([0n, -1n])('refuses a non-positive fee (%s)', (fee) => {
    expect(() => planConceal(100n * TARI, fee)).toThrow(/Fee must be greater than zero/)
  })
})

describe('maxConcealTyped — a typed amount leaves the pricing reserve in the vault', () => {
  it('is the balance minus the reserve', () => {
    expect(maxConcealTyped(3n * TARI)).toBe(3n * TARI - CONCEAL_FEE_RESERVE)
  })
  it('is zero when the balance cannot cover the reserve', () => {
    expect(maxConcealTyped(CONCEAL_FEE_RESERVE)).toBe(0n)
    expect(maxConcealTyped(0n)).toBe(0n)
  })
})

describe('assertConcealSplit — the tripwire for a future second derivation', () => {
  it('passes every split planConceal produces', () => {
    expect(() => assertConcealSplit(planConceal(100n * TARI, 16_138n))).not.toThrow()
    expect(() => assertConcealSplit(planConceal(100n * TARI, 16_138n, true))).not.toThrow()
  })

  it('catches a withdraw that drifted from the stealth output', () => {
    // With no revealed output, every withdrawn microtari must become the stealth output.
    const drifted = { withdrawAmount: 100n * TARI + 1n, stealthAmount: 100n * TARI, feeBudget: 16_138n }
    expect(() => assertConcealSplit(drifted)).toThrow(/does not balance/)
  })

  it.each([
    ['zero stealth', { withdrawAmount: 16_138n, stealthAmount: 0n, feeBudget: 16_138n }],
    ['zero fee', { withdrawAmount: 100n, stealthAmount: 100n, feeBudget: 0n }],
    ['zero withdraw', { withdrawAmount: 0n, stealthAmount: 0n, feeBudget: 0n }],
    ['negative stealth', { withdrawAmount: 100n, stealthAmount: -1n, feeBudget: 101n }],
  ])('refuses a non-positive component (%s)', (_label, split) => {
    expect(() => assertConcealSplit(split)).toThrow(/non-positive component/)
  })
})

describe('MIN_CONCEAL_MICROTARI', () => {
  it('matches the reveal floor, so both directions of Move behave the same', async () => {
    const { MIN_REVEAL_MICROTARI } = await import('./reveal')
    expect(MIN_CONCEAL_MICROTARI).toBe(MIN_REVEAL_MICROTARI)
  })

  it('sits above every fee measured on this network', () => {
    // Largest observed real fee to date: 16 138 µtTARI (a send, 2026-08-20).
    expect(MIN_CONCEAL_MICROTARI).toBeGreaterThan(16_138n)
  })

  it('produces a viable split at exactly the floor', () => {
    const s = planConceal(MIN_CONCEAL_MICROTARI, 16_138n)
    expect(s.stealthAmount).toBe(MIN_CONCEAL_MICROTARI)
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
    // What the whole chain has to guarantee: MAX (`all`) withdraws exactly the balance, never more.
    const split = planConceal(SEEDED, 16_138n, true)
    expect(split.withdrawAmount + split.feeBudget).toBe(SEEDED)
    expect(split.withdrawAmount).toBeLessThanOrEqual(SEEDED)
    assertConcealSplit(split)
  })
})
