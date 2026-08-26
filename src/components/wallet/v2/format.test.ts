// Tests for the display formatters (M9 CP3).
//
// These convert amounts, so they sit on the same rail as the fund modules: BIGINT ONLY, no float
// anywhere. fmt2 exists because the faucet panel had its own `Number(µt) / 1_000_000` doing this
// job — the exact silent-rounding bug the rail forbids, overlooked because it lived in a component
// rather than in crypto.

import { describe, expect, it } from 'vitest'
import { fmt2, fmt6, toInput } from './format'

describe('fmt2', () => {
  it('formats an ordinary balance with grouping', () => {
    expect(fmt2(12_847_503_210n)).toBe('12,847.50')
  })

  it('always shows two decimals, including a whole number', () => {
    expect(fmt2(1_000_000n)).toBe('1.00')
    expect(fmt2(0n)).toBe('0.00')
  })

  it('pads a single-digit remainder rather than dropping it', () => {
    // 0.05, not "0.5" — a missing pad moves the decimal point by a factor of ten.
    expect(fmt2(50_000n)).toBe('0.05')
  })

  it('rounds half-up on the third decimal, in integer arithmetic', () => {
    expect(fmt2(1_004_999n)).toBe('1.00')
    expect(fmt2(1_005_000n)).toBe('1.01')
    expect(fmt2(1_005_001n)).toBe('1.01')
  })

  it('rounds up across the whole-number boundary', () => {
    expect(fmt2(1_999_999n)).toBe('2.00')
  })

  it('never uses a float — exact past 2^53 µtTARI, where Number() silently rounds', () => {
    // THE BUG THIS REPLACES. Number(9007199254740993n) === 9007199254740992, so the old
    // `Number(µt) / 1_000_000` misreported the last microtari of a large balance.
    const huge = 9_007_199_254_740_993n
    expect(BigInt(Number(huge))).not.toBe(huge)      // the float path really does lose it
    expect(fmt2(huge)).toBe('9,007,199,254.74')      // this one does not go near a float
  })

  it('handles a negative amount without mangling the sign', () => {
    expect(fmt2(-1_500_000n)).toBe('-1.50')
  })

  it('agrees with fmt6 on the digits it keeps', () => {
    const v = 4_321_987_654n
    expect(fmt6(v).startsWith(fmt2(v).slice(0, -1))).toBe(true)
  })

  it('is display-only — toInput stays full precision for the amount field', () => {
    // MAX round-trips through toInput, never through a rounded formatter. Rounding an entry value
    // is how the M2 MAX bug happened.
    expect(toInput(999_997_686n)).toBe('999.997686')
    expect(fmt2(999_997_686n)).toBe('1,000.00')
  })
})
