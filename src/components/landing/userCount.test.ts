// The live user count: highest relay wins (never the sum), a slow or broken relay is ignored, no
// answer means no pill, sockets are always closed, and the filter can never match test notes.

import { describe, expect, it, vi } from 'vitest'
import { countOnRelay, liveUserCount, userCountFilter, userCountLabel, type CountingRelay } from './userCount'
import { COUNT_SINCE, PROD_TAG_PREFIX, STAT_NOTE_KIND, TEST_TAG_PREFIX } from '../../config/stats'

const F = userCountFilter(PROD_TAG_PREFIX)

function fakeRelay(answer: () => Promise<number>): CountingRelay & { closed: number } {
  const r = { closed: 0, count: () => answer(), close() { r.closed++ } }
  return r
}

describe('the filter', () => {
  it('is the exact production tag, kind 30078, since launch day', () => {
    expect(F).toEqual({ kinds: [STAT_NOTE_KIND], '#d': ['caravel/identity_created'], since: COUNT_SINCE })
  })

  it('a test-tag filter is a different filter: test notes never match the production count', () => {
    expect(userCountFilter(TEST_TAG_PREFIX)['#d']).toEqual(['caravel-test/identity_created'])
    expect(userCountFilter(TEST_TAG_PREFIX)['#d']).not.toEqual(F['#d'])
  })
})

describe('liveUserCount', () => {
  it('takes the HIGHEST relay answer, never the sum', async () => {
    const answers: Record<string, number | null> = { a: 120, b: 133, c: null, d: 90 }
    expect(await liveUserCount(['a', 'b', 'c', 'd'], F, 1000, async url => answers[url])).toBe(133)
  })

  it('is null when no relay answers with a number', async () => {
    expect(await liveUserCount(['a', 'b'], F, 1000, async () => null)).toBeNull()
    expect(await liveUserCount(['a'], F, 1000, async () => { throw new Error('down') })).toBeNull()
  })
})

describe('countOnRelay', () => {
  it('returns the count and closes the socket', async () => {
    const r = fakeRelay(async () => 42)
    expect(await countOnRelay('wss://x', F, 1000, async () => r)).toBe(42)
    await Promise.resolve()
    expect(r.closed).toBe(1)
  })

  it('times out to null, and still closes the socket when the answer comes late', async () => {
    vi.useFakeTimers()
    try {
      let answer!: (n: number) => void
      const r = fakeRelay(() => new Promise<number>(res => { answer = res }))
      const p = countOnRelay('wss://slow', F, 2500, async () => r)
      await vi.advanceTimersByTimeAsync(2500)
      expect(await p).toBeNull()
      answer(7)
      await vi.runAllTimersAsync()
      expect(r.closed).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('a refusal, a failed connection or a non-number is null', async () => {
    expect(await countOnRelay('wss://x', F, 1000, async () => fakeRelay(async () => { throw new Error('auth-required') }))).toBeNull()
    expect(await countOnRelay('wss://x', F, 1000, async () => { throw new Error('no route') })).toBeNull()
    expect(await countOnRelay('wss://x', F, 1000, async () => fakeRelay(async () => Number.NaN))).toBeNull()
    expect(await countOnRelay('wss://x', F, 1000, async () => fakeRelay(async () => -3))).toBeNull()
  })
})

describe('the label', () => {
  it('reads "1,234 Users Live", and "1 User Live" for one', () => {
    expect(userCountLabel(1234)).toBe('1,234 Users Live')
    expect(userCountLabel(12)).toBe('12 Users Live')
    expect(userCountLabel(1)).toBe('1 User Live')
  })
})
