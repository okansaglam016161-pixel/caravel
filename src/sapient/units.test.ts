import { describe, expect, it } from 'vitest'
import { formatTari, TICKER } from './units'

describe('formatTari', () => {
  it('is exact, grouped, and drops only trailing zeros', () => {
    expect(formatTari(15194n)).toBe('0.015194')
    expect(formatTari(100000n)).toBe('0.1')
    expect(formatTari(1000000n)).toBe('1')
    expect(formatTari(9998900000n)).toBe('9,998.9')
    expect(formatTari(12847503210000n)).toBe('12,847,503.21')
    expect(TICKER).toBe('TARI')
  })
})
