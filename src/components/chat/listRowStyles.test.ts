import { describe, expect, it } from 'vitest'
import { shortenMiddle } from './listRowStyles'

describe('shortenMiddle', () => {
  it('keeps the first 10 and last 8 characters of a long value', () => {
    const addr = 'otl_1u6fr8' + 'x'.repeat(60) + '0m3c863h'
    expect(shortenMiddle(addr)).toBe('otl_1u6fr8…0m3c863h')
  })

  it('leaves a value that is already short alone', () => {
    expect(shortenMiddle('npub1abc')).toBe('npub1abc')
    expect(shortenMiddle('a'.repeat(22))).toBe('a'.repeat(22))
  })
})
