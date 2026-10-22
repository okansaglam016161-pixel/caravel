// The feed's promises: no figures before the first read, the last read kept but marked when a
// refresh fails, back-off on failure, no polling while hidden or unwatched, one refresh at a time.

import { describe, expect, it, vi } from 'vitest'
import { createMarketFeed } from './marketFeed'
import type { MarketData } from './market'

const data = (at: number) => ({ at, recent: [], book: { sells: [], buys: [], spread: null }, mine: [], hidden: [], discovered: 0 } as unknown as MarketData)

function harness(results: (MarketData | Error)[], hidden = { v: false }) {
  const timers: { fn: () => void; ms: number }[] = []
  let calls = 0
  const reader = { refresh: vi.fn(async () => { const r = results[Math.min(calls++, results.length - 1)]; if (r instanceof Error) throw r; return r }) }
  const feed = createMarketFeed(reader, {
    pollMs: 1000, maxBackoffMs: 8000, isHidden: () => hidden.v,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1 },
    clearTimer: () => {},
  })
  return { feed, reader, timers }
}

describe('marketFeed', () => {
  it('loading → ready; nothing is read until someone subscribes', async () => {
    const h = harness([data(1)])
    expect(h.feed.getSnapshot()).toMatchObject({ status: 'loading', data: null })
    expect(h.reader.refresh).not.toHaveBeenCalled()
    h.feed.subscribe(() => {})
    await h.feed.refresh()
    expect(h.feed.getSnapshot()).toMatchObject({ status: 'ready', data: { at: 1 } })
  })

  it('a failed refresh keeps the last data but says unreachable — and backs off, doubling', async () => {
    const h = harness([data(1), new Error('busy'), new Error('busy')])
    h.feed.subscribe(() => {})
    await h.feed.refresh()
    await h.feed.refresh()
    expect(h.feed.getSnapshot()).toMatchObject({ status: 'unreachable', data: { at: 1 }, error: 'busy' })
    await h.feed.refresh()
    expect(h.timers.slice(-2).map(t => t.ms)).toEqual([2000, 4000])
  })

  it('shows `updating` over the previous data while a refresh runs; one refresh at a time', async () => {
    const h = harness([data(1), data(2)])
    h.feed.subscribe(() => {})
    await h.feed.refresh()
    const a = h.feed.refresh(), b = h.feed.refresh()
    expect(h.feed.getSnapshot()).toMatchObject({ status: 'updating', data: { at: 1 } })
    await Promise.all([a, b])
    expect(h.reader.refresh).toHaveBeenCalledTimes(2)
    expect(h.feed.getSnapshot()).toMatchObject({ status: 'ready', data: { at: 2 } })
  })

  it('a tick while the page is hidden does not read — it waits for the next tick', async () => {
    const hidden = { v: false }
    const h = harness([data(1), data(2)], hidden)
    h.feed.subscribe(() => {})
    await h.feed.refresh()
    hidden.v = true
    h.timers.at(-1)!.fn()
    await Promise.resolve()
    expect(h.reader.refresh).toHaveBeenCalledTimes(1)
  })

  it('a stopped feed (locked wallet) reads nothing more', async () => {
    const h = harness([data(1)])
    h.feed.subscribe(() => {})
    await h.feed.refresh()
    h.feed.stop()
    await h.feed.refresh()
    expect(h.reader.refresh).toHaveBeenCalledTimes(1)
  })
})
