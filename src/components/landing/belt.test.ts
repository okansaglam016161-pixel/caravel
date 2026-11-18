import { describe, expect, it } from 'vitest'
import { BELT_PX_PER_SECOND, beltDurationSeconds } from './belt'

describe('the belt keeps one speed', () => {
  it('the original set (3 x 398px) still takes 36s, and a wider set takes proportionally longer', () => {
    expect(beltDurationSeconds(1194)).toBeCloseTo(36)
    expect(beltDurationSeconds(2440)).toBeCloseTo(2440 / BELT_PX_PER_SECOND)
    expect(beltDurationSeconds(2440) / beltDurationSeconds(1220)).toBeCloseTo(2)
  })

  it('falls back to 36s for a width it cannot use', () => {
    expect(beltDurationSeconds(0)).toBe(36)
    expect(beltDurationSeconds(Number.NaN)).toBe(36)
  })
})
