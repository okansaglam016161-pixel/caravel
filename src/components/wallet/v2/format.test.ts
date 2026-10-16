// Tests for the display formatters.
//
// THE AMOUNT RULE: exact, grouped, only trailing zeros dropped — never rounded, never truncated, never
// padded. fmt6 is the shared formatter (crypto/assets.formatUnits) at tTARI's six decimals. BIGINT
// ONLY: a float on an amount silently rounds past 2^53.

import { describe, expect, it } from 'vitest'
import { fmt6, toInput, firstSeenLabel } from './format'

describe('fmt6 — exact, no trailing zeros', () => {
  it('keeps every real decimal: 0.015194 stays 0.015194', () => {
    expect(fmt6(15_194n)).toBe('0.015194')
    expect(fmt6(1n)).toBe('0.000001')
  })
  it('drops only trailing zeros: 0.100000 → 0.1, 1.000000 → 1, 9,998.90 → 9,998.9', () => {
    expect(fmt6(100_000n)).toBe('0.1')
    expect(fmt6(1_000_000n)).toBe('1')
    expect(fmt6(9_998_900_000n)).toBe('9,998.9')
    expect(fmt6(0n)).toBe('0')
  })
  it('groups thousands', () => {
    expect(fmt6(12_847_503_210n)).toBe('12,847.50321')
    expect(fmt6(1_000_000_000_000n)).toBe('1,000,000')
  })
  it('never goes near a float — exact past 2^53 µtTARI', () => {
    const huge = 9_007_199_254_740_993n
    expect(BigInt(Number(huge))).not.toBe(huge)
    expect(fmt6(huge)).toBe('9,007,199,254.740993')
  })
  it('keeps the sign of a negative amount', () => {
    expect(fmt6(-1_500_000n)).toBe('-1.5')
  })
  it('is display-only — toInput stays ungrouped for the amount field', () => {
    expect(toInput(999_997_686n)).toBe('999.997686')
    expect(toInput(1_234_000_000n)).toBe('1234')
  })
})

// ── The first-seen date ───────────────────────────────────────────────────────
//
// This labels when a scan first REPORTED an output, not when anybody sent it. Nothing is observed
// while the app is closed, so the two can be days apart — which is why there is no time of day
// here. A "14:32" beside a first-seen claims a precision the number does not have and reads as the
// moment the payment happened, which is the one thing it must never be mistaken for.

describe('firstSeenLabel', () => {
  const AUG_31_2026 = new Date(2026, 7, 31, 14, 32).getTime()

  it('renders a bare date — never a time of day', () => {
    const label = firstSeenLabel(AUG_31_2026, AUG_31_2026)
    expect(label).not.toMatch(/\d{1,2}:\d{2}/)
    expect(label).toMatch(/31/)
  })

  it('omits the year in the current year, and includes it otherwise', () => {
    const nowIn2026 = new Date(2026, 11, 1).getTime()
    expect(firstSeenLabel(AUG_31_2026, nowIn2026)).not.toMatch(/2026/)
    const nowIn2027 = new Date(2027, 0, 5).getTime()
    expect(firstSeenLabel(AUG_31_2026, nowIn2027)).toMatch(/2026/)
  })

  it('shows the same date whatever the time of day it was seen', () => {
    // The resolution the value actually has: a UTXO seen at 00:05 and one seen at 23:55 are both
    // just "that day" as far as anything knowable is concerned.
    const early = new Date(2026, 7, 31, 0, 5).getTime()
    const late = new Date(2026, 7, 31, 23, 55).getTime()
    expect(firstSeenLabel(early, AUG_31_2026)).toBe(firstSeenLabel(late, AUG_31_2026))
  })
})
