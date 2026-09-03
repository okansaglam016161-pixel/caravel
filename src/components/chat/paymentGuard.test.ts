// Unit tests for the payment composer's balance pre-check.
//
// The case that matters is `insufficient-looking on an incomplete scan`. That one shipped as a bug:
// the guard blocked a send the wallet could afford, because it compared the spend against a
// truncated scan's lower bound as though it were a balance. It failed silently — a disabled button
// and no explanation — so it is locked here rather than left to be re-derived.

import { describe, expect, it } from 'vitest'
import { balanceIsLowerBound, isInsufficientBalance, type ScanReading } from './paymentGuard'

const FEE = 50_000n            // MAX_FEE — 0.05 tTARI, the ceiling the composer quotes
const TARI = 1_000_000n        // µtTARI per tTARI

function scan(over: Partial<ScanReading> = {}): ScanReading {
  return { balance: 100n * TARI, incomplete: false, status: 'done', ...over }
}

describe('balanceIsLowerBound — when the figure is "what we could see"', () => {
  it('is true for a completed scan the indexer capped', () => {
    expect(balanceIsLowerBound(scan({ incomplete: true }))).toBe(true)
  })

  it('is false for a clean completed scan', () => {
    expect(balanceIsLowerBound(scan())).toBe(false)
  })

  it('is false while a scan is still running, even with the flag set', () => {
    // A running scan has cleared `balance`; a stale flag has nothing to qualify.
    expect(balanceIsLowerBound(scan({ incomplete: true, status: 'scanning' }))).toBe(false)
  })
})

describe('isInsufficientBalance — the block', () => {
  it('does not block a send that fits inside the balance', () => {
    expect(isInsufficientBalance(10n * TARI, FEE, scan())).toBe(false)
  })

  it('blocks a send larger than the balance on a complete scan', () => {
    expect(isInsufficientBalance(200n * TARI, FEE, scan())).toBe(true)
  })

  it('DOES NOT block an over-the-figure send when the scan was truncated', () => {
    // The bug. The figure is a lower bound, so "larger than what we could see" is not "more than you
    // have" — and refusing here blocks a payment the wallet may well be able to make.
    const truncated = scan({ incomplete: true })
    expect(isInsufficientBalance(200n * TARI, FEE, truncated)).toBe(false)
    // ...while the identical spend against the identical figure still blocks once the scan is clean.
    expect(isInsufficientBalance(200n * TARI, FEE, scan())).toBe(true)
  })

  it('does not block when there is no balance reading at all', () => {
    expect(isInsufficientBalance(200n * TARI, FEE, scan({ balance: null }))).toBe(false)
    expect(isInsufficientBalance(200n * TARI, FEE, scan({ balance: null, status: 'scanning' }))).toBe(false)
    expect(isInsufficientBalance(200n * TARI, FEE, scan({ balance: null, status: 'error' }))).toBe(false)
  })

  it('does not block when the composer holds no usable amount', () => {
    expect(isInsufficientBalance(null, FEE, scan({ balance: 0n }))).toBe(false)
  })

  describe('the fee boundary — the fee is part of the spend', () => {
    const balance = 10n * TARI

    it('allows spending the whole balance including the fee', () => {
      expect(isInsufficientBalance(balance - FEE, FEE, scan({ balance }))).toBe(false)
    })

    it('blocks one microtari beyond it', () => {
      expect(isInsufficientBalance(balance - FEE + 1n, FEE, scan({ balance }))).toBe(true)
    })

    it('blocks an amount that fits but whose fee pushes it over', () => {
      // The amount alone is affordable; amount + fee is not. This is the case the fee term exists for.
      expect(isInsufficientBalance(balance, FEE, scan({ balance }))).toBe(true)
    })
  })
})
