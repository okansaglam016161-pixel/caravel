// Tests for the display formatters (M9 CP3).
//
// These convert amounts, so they sit on the same rail as the fund modules: BIGINT ONLY, no float
// anywhere. fmt2 exists because the faucet panel had its own `Number(µt) / 1_000_000` doing this
// job — the exact silent-rounding bug the rail forbids, overlooked because it lived in a component
// rather than in crypto.

import { describe, expect, it } from 'vitest'
import { fmt2, fmt6, toInput, formatCooldown, firstSeenLabel } from './format'

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

// ── The faucet cooldown countdown ────────────────────────────────────────────
//
// One rounding rule carries the weight here: the number must never reach zero while the control
// it describes is still disabled. A countdown that sits on "0s" for a second reads as a stuck
// wallet, and the fix — rounding up — is invisible unless something pins it.

describe('formatCooldown', () => {
  it('rounds UP, so it never shows 0s while the wait is still running', () => {
    expect(formatCooldown(1)).toBe('1s')
    expect(formatCooldown(999)).toBe('1s')
    expect(formatCooldown(1_001)).toBe('2s')
  })

  it('shows 0s only when the wait is genuinely over', () => {
    expect(formatCooldown(0)).toBe('0s')
  })

  it('never returns a negative time', () => {
    // A clock that jumps, or a render one tick after the timeout fired.
    expect(formatCooldown(-5_000)).toBe('0s')
  })

  it('counts plain seconds under a minute', () => {
    expect(formatCooldown(42_000)).toBe('42s')
    expect(formatCooldown(59_000)).toBe('59s')
  })

  it('adds minutes at and above a minute — the real 60s cooldown starts here', () => {
    expect(formatCooldown(60_000)).toBe('1m 0s')
    expect(formatCooldown(90_000)).toBe('1m 30s')
  })

  it('drops to hours and minutes for long waits, should the cooldown ever grow', () => {
    // The unit ladder is general so the string stays correct if COOLDOWN_MS changes; today the
    // wallet only ever reaches the seconds branch.
    expect(formatCooldown(3_600_000)).toBe('1h 0m')
    expect(formatCooldown(11_520_000)).toBe('3h 12m')
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
