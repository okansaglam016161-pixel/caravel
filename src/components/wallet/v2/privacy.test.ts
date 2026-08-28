// The Privacy card's split must never state a ratio it cannot support.
//
// These tests are the honesty rule written down. The positive cases are almost incidental; what
// matters is the negative half — that every state short of a complete, current, visible reading
// produces `unknown`, and specifically NOT a 100% that would read as "all your funds are private".

import { describe, expect, it } from 'vitest'
import { privacySplit, splitLabel, type SplitView } from './privacy'
import type { BalanceView } from './balances'
import type { TotalUnreadableReason, TotalView } from './total'

const ready = (v: bigint): BalanceView => ({ status: 'ready', microtari: v })
const LOADING: BalanceView = { status: 'loading' }
const UNAVAIL: BalanceView = { status: 'unavailable' }

const total = (v: bigint): TotalView => ({ status: 'ready', microtari: v })
const SETTLING: TotalView = { status: 'settling' }
const T_LOADING: TotalView = { status: 'loading' }
const unreadable = (reason: TotalUnreadableReason): TotalView => ({ status: 'unreadable', reason })

/** Asserts the shape refuses a ratio — and that no percentage leaked onto the result. */
function expectNoRatio(s: SplitView) {
  expect(s.kind).toBe('unknown')
  expect(s).not.toHaveProperty('privatePct')
}

describe('privacySplit — when a ratio may be stated', () => {
  it('states the split when both halves are known and visible', () => {
    const s = privacySplit(total(1000n), ready(900n), ready(100n), false)
    expect(s).toEqual({ kind: 'known', privatePct: 90 })
  })

  it('is exact on an uneven split rather than pre-rounded', () => {
    const s = privacySplit(total(3n), ready(1n), ready(2n), false)
    expect(s.kind).toBe('known')
    if (s.kind === 'known') expect(s.privatePct).toBeCloseTo(33.33, 2)
  })

  it('keeps full precision above Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n
    const s = privacySplit(total(big * 2n), ready(big), ready(big), false)
    expect(s).toEqual({ kind: 'known', privatePct: 50 })
  })

  it('reports 100 when the balance is genuinely all private', () => {
    expect(privacySplit(total(500n), ready(500n), ready(0n), false)).toEqual({ kind: 'known', privatePct: 100 })
  })

  it('reports 0 when the balance is genuinely all public', () => {
    expect(privacySplit(total(500n), ready(0n), ready(500n), false)).toEqual({ kind: 'known', privatePct: 0 })
  })
})

describe('privacySplit — an empty wallet has no ratio', () => {
  it('returns `empty`, not 0% and not 100%', () => {
    const s = privacySplit(total(0n), ready(0n), ready(0n), false)
    expect(s).toEqual({ kind: 'empty' })
    expect(s).not.toHaveProperty('privatePct')
  })
})

describe('privacySplit — the four refusals', () => {
  it('refuses a ratio while balances are hidden, and says nothing about why', () => {
    // The bar is a composition. Masking the figures while still drawing 90/10 would defeat the eye.
    const s = privacySplit(total(1000n), ready(900n), ready(100n), true)
    expectNoRatio(s)
    expect(s).toEqual({ kind: 'unknown', label: null })
  })

  it('refuses a ratio while settling', () => {
    // The halves are from different moments; their ratio is not a fact about any of them.
    expectNoRatio(privacySplit(SETTLING, ready(900n), ready(100n), false))
    expect(privacySplit(SETTLING, ready(900n), ready(100n), false)).toEqual({ kind: 'unknown', label: 'Updating' })
  })

  it('refuses a ratio while loading', () => {
    expectNoRatio(privacySplit(T_LOADING, LOADING, LOADING, false))
  })

  it('refuses a ratio when the total is unreadable', () => {
    expectNoRatio(privacySplit(unreadable('private-unavailable'), UNAVAIL, ready(100n), false))
    expectNoRatio(privacySplit(unreadable('public-unavailable'), ready(900n), UNAVAIL, false))
  })

  it('NEVER reports 100% private when only the public half failed to read', () => {
    // The regression this file exists for. A known private half beside an unreadable public one is
    // the exact input that would otherwise render "100% private" over a wallet holding public funds.
    const s = privacySplit(unreadable('public-unavailable'), ready(900n), UNAVAIL, false)
    expectNoRatio(s)
    expect(JSON.stringify(s)).not.toContain('100')
  })

  it('refuses a ratio if a half is not ready even when the total claims to be', () => {
    // Defensive: computeTotal cannot produce this pairing today. If it ever could, the bar must
    // still refuse rather than read a microtari off a union member that has none.
    expectNoRatio(privacySplit(total(900n), ready(900n), LOADING, false))
    expectNoRatio(privacySplit(total(900n), UNAVAIL, ready(900n), false))
  })
})

describe('splitLabel — the roundings that would lie', () => {
  it('does not round a real public balance away to 100%', () => {
    expect(splitLabel(99.6)).toBe('>99% private')
    expect(splitLabel(99.99)).toBe('>99% private')
  })

  it('does not round a real private balance away to 0%', () => {
    expect(splitLabel(0.4)).toBe('<1% private')
  })

  it('says 100% only when it is exactly true', () => {
    expect(splitLabel(100)).toBe('100% private')
  })

  it('says 0% only when it is exactly true', () => {
    expect(splitLabel(0)).toBe('0% private')
  })

  it('rounds ordinary values to a whole percent', () => {
    expect(splitLabel(90)).toBe('90% private')
    expect(splitLabel(33.33)).toBe('33% private')
    expect(splitLabel(66.67)).toBe('67% private')
  })
})
