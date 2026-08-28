// Tests for the fiat display layer.
//
// The rule under test is one sentence: NO BALANCE, NO DOLLAR. Everything else here is arithmetic.

import { describe, expect, it } from 'vitest'
import { fiatForBalance, fiatForTotal, usdFromMicrotari } from './fiat'
import type { BalanceView } from './balances'
import type { TotalView } from './total'

describe('usdFromMicrotari — exact, truncated, never a float', () => {
  it('prices the design’s figure', () => {
    // 1,284.503921 XTR x $0.0004 = $0.51380157 -> four places under a dollar.
    expect(usdFromMicrotari(1_284_503_921n)).toBe('$0.5138')
  })

  it('prices each side of that total', () => {
    expect(usdFromMicrotari(1_050_000_000n)).toBe('$0.4200')
    expect(usdFromMicrotari(234_503_921n)).toBe('$0.0938')
  })

  it('shows a real zero as zero — a balance of nothing IS nothing', () => {
    expect(usdFromMicrotari(0n)).toBe('$0.0000')
  })

  it('switches to two places at a dollar and above', () => {
    expect(usdFromMicrotari(2_500_000_000n)).toBe('$1.00')       // 2,500 XTR
    expect(usdFromMicrotari(2_499_999_999n)).toBe('$0.9999')     // a hair under
  })

  it('groups thousands', () => {
    expect(usdFromMicrotari(30_000_000_000_000n)).toBe('$12,000.00')
  })

  it('TRUNCATES rather than rounding up — a balance never displays as more than it is', () => {
    // 2,499.9999 XTR -> $0.99999996, which must not become $1.00.
    expect(usdFromMicrotari(2_499_999_900n)).toBe('$0.9999')
  })

  it('does not lose precision on a figure that would break a float', () => {
    // Number(9007199254740993n) * 0.0004 loses the last digit; bigint math does not.
    expect(usdFromMicrotari(9_007_199_254_740_993n)).toBe('$3,602,879.70')
  })
})

describe('fiatForTotal — no total, no dollar', () => {
  it('prices a ready total', () => {
    expect(fiatForTotal({ status: 'ready', microtari: 1_284_503_921n })).toBe('$0.5138')
  })

  // THE STATES THAT MUST NEVER PRODUCE A FIGURE. Each of these means the wallet does not know what
  // the balance is, and a dollar value derived from a number nobody has is the exact failure this
  // whole module is arranged to make impossible.
  it.each<TotalView>([
    { status: 'loading' },
    { status: 'settling' },
    { status: 'unreadable', reason: 'both-unavailable' },
    { status: 'unreadable', reason: 'private-unavailable' },
    { status: 'unreadable', reason: 'public-unavailable' },
    { status: 'unreadable', reason: 'private-incomplete' },
    { status: 'unreadable', reason: 'settle-lagged' },
  ])('returns null for $status', total => {
    expect(fiatForTotal(total)).toBeNull()
  })

  it('never returns a zero-dollar string for an unknown balance', () => {
    for (const total of [
      { status: 'loading' },
      { status: 'settling' },
      { status: 'unreadable', reason: 'settle-lagged' },
    ] as TotalView[]) {
      expect(fiatForTotal(total)).not.toBe('$0.00')
      expect(fiatForTotal(total)).not.toBe('$0.0000')
    }
  })
})

describe('fiatForBalance — one side, same rule', () => {
  it('prices a ready side', () => {
    expect(fiatForBalance({ status: 'ready', microtari: 1_050_000_000n })).toBe('$0.4200')
  })

  it.each<BalanceView>([
    { status: 'loading' },
    { status: 'unavailable' },
  ])('returns null for $status — an unread side is not a side worth nothing', balance => {
    expect(fiatForBalance(balance)).toBeNull()
  })
})
