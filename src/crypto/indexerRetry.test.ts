// The retry rules for a busy indexer (Ootle 0.43: 429 rate limited, 503 saturated).
//
// What these pin: busy and transient answers are retried and definite ones never are; Retry-After
// is honoured but capped; the "Network busy, retrying…" hook fires only for BUSY; and running out
// of attempts while busy yields the one plain message that says nothing was sent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IndexerBusyError,
  NETWORK_BUSY_MESSAGE,
  backoffMs,
  classifyStatus,
  fetchWithRetry,
  isBusyError,
  parseRetryAfter,
  retryTiming,
  withBusyRetry,
} from './indexerRetry'

const A = 'https://a.test'
const B = 'https://b.test'
const saved = { ...retryTiming }
let slept: number[] = []

beforeEach(() => {
  slept = []
  retryTiming.sleep = async (ms: number) => { slept.push(ms) }
})
afterEach(() => {
  Object.assign(retryTiming, saved)
  vi.unstubAllGlobals()
})

/** A fetch double that answers from a script, one entry per call, and records the URLs asked. */
function scripted(answers: Array<number | Error | { status: number; retryAfter?: string }>) {
  const urls: string[] = []
  const fn = vi.fn(async (url: string) => {
    urls.push(url)
    const next = answers.shift()
    if (next === undefined) throw new Error('script exhausted')
    if (next instanceof Error) throw next
    const { status, retryAfter } = typeof next === 'number' ? { status: next, retryAfter: undefined } : next
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
      json: async () => ({ status }),
      text: async () => '',
    }
  })
  vi.stubGlobal('fetch', fn)
  return { fn, urls }
}

const opts = { attempts: 4, timeoutMs: 1_000 }

describe('classifyStatus', () => {
  it('429 and 503 are busy', () => {
    expect(classifyStatus(429)).toBe('busy')
    expect(classifyStatus(503)).toBe('busy')
  })
  it('other 5xx are transient', () => {
    expect(classifyStatus(500)).toBe('transient')
    expect(classifyStatus(502)).toBe('transient')
  })
  it('2xx, 404 and 400 are definite — a 400 dry run is not worth asking again', () => {
    for (const s of [200, 204, 400, 404, 422]) expect(classifyStatus(s)).toBe('definite')
  })
})

describe('isBusyError — the SDK transport throws "HTTP 503: …"', () => {
  it('recognises the SDK’s busy errors and our own', () => {
    expect(isBusyError(new Error('HTTP 503: Service Unavailable - saturated'))).toBe(true)
    expect(isBusyError(new Error('HTTP 429: Too Many Requests'))).toBe(true)
    expect(isBusyError(new IndexerBusyError())).toBe(true)
  })
  it('does not mistake other failures for busy', () => {
    expect(isBusyError(new Error('HTTP 500: Internal Server Error'))).toBe(false)
    expect(isBusyError(new Error('HTTP 400: Bad Request - missing input'))).toBe(false)
    expect(isBusyError(new Error('fetch failed'))).toBe(false)
    expect(isBusyError(null)).toBe(false)
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('3')).toBe(3_000)
    expect(parseRetryAfter(' 0 ')).toBe(0)
  })
  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    expect(parseRetryAfter('Sat, 03 Oct 2026 12:00:04 GMT', now)).toBe(4_000)
  })
  it('never goes negative for a date in the past', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    expect(parseRetryAfter('Sat, 03 Oct 2026 11:00:00 GMT', now)).toBe(0)
  })
  it('caps a long wait', () => {
    expect(parseRetryAfter('3600')).toBe(retryTiming.retryAfterCapMs)
  })
  it('is null for absent or unreadable values', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
  })
})

describe('backoffMs', () => {
  it('uses Retry-After when the indexer gave one', () => {
    expect(backoffMs(1, 2_500)).toBe(2_500)
  })
  it('otherwise doubles per attempt with full jitter, capped', () => {
    expect(backoffMs(1, null, () => 0.999)).toBeLessThan(retryTiming.baseMs)
    expect(backoffMs(3, null, () => 0.999)).toBeLessThan(retryTiming.baseMs * 4)
    expect(backoffMs(3, null, () => 0.999)).toBeGreaterThanOrEqual(retryTiming.baseMs * 2)
    expect(backoffMs(20, null, () => 0.999)).toBeLessThan(retryTiming.capMs)
    expect(backoffMs(2, null, () => 0)).toBe(0)
  })
})

describe('fetchWithRetry', () => {
  it('returns the first answer when it is definite', async () => {
    const { fn } = scripted([200])
    const res = await fetchWithRetry([A], '/x', {}, opts)
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('never retries a 400 — the dry run would be refused again', async () => {
    const { fn } = scripted([400])
    expect((await fetchWithRetry([A], '/x', {}, opts)).status).toBe(400)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('waits out busy answers, says so before each retry, and then succeeds', async () => {
    scripted([503, 429, 200])
    const onBusyRetry = vi.fn()
    const res = await fetchWithRetry([A], '/x', {}, { ...opts, onBusyRetry })
    expect(res.status).toBe(200)
    expect(onBusyRetry).toHaveBeenCalledTimes(2)
  })

  it('honours Retry-After on a busy answer', async () => {
    scripted([{ status: 503, retryAfter: '2' }, 200])
    await fetchWithRetry([A], '/x', {}, opts)
    expect(slept).toEqual([2_000])
  })

  it('alternates to the other indexer when allowed', async () => {
    const { urls } = scripted([503, 200])
    await fetchWithRetry([A, B], '/x', {}, { ...opts, alternate: true })
    expect(urls).toEqual([`${A}/x`, `${B}/x`])
  })

  it('stays on the first indexer when not allowed to alternate', async () => {
    const { urls } = scripted([503, 200])
    await fetchWithRetry([A, B], '/x', {}, opts)
    expect(urls).toEqual([`${A}/x`, `${A}/x`])
  })

  it('throws IndexerBusyError, with the plain message, when it stays busy', async () => {
    const { fn } = scripted([503, 503, 429, 503])
    const err = await fetchWithRetry([A], '/x', {}, opts).catch(e => e)
    expect(err).toBeInstanceOf(IndexerBusyError)
    expect(err.message).toBe(NETWORK_BUSY_MESSAGE)
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('retries a transient failure without announcing "busy"', async () => {
    scripted([new Error('network down'), 502, 200])
    const onBusyRetry = vi.fn()
    expect((await fetchWithRetry([A], '/x', {}, { ...opts, onBusyRetry })).status).toBe(200)
    expect(onBusyRetry).not.toHaveBeenCalled()
  })

  it('rethrows the last transient failure when attempts run out', async () => {
    scripted([502, 502])
    await expect(fetchWithRetry([A], '/x', {}, { ...opts, attempts: 2 })).rejects.toThrow('indexer HTTP 502')
  })

  it('stops at once on an intentional abort', async () => {
    scripted([200])
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(fetchWithRetry([A], '/x', {}, { ...opts, signal: ctrl.signal })).rejects.toThrow()
  })
})

describe('withBusyRetry — for SDK calls', () => {
  it('retries a busy SDK error and returns the eventual value', async () => {
    let n = 0
    const v = await withBusyRetry(async () => {
      if (n++ < 2) throw new Error('HTTP 503: Service Unavailable')
      return 'ok'
    }, { attempts: 3 })
    expect(v).toBe('ok')
  })

  it('rethrows anything that is not busy, immediately', async () => {
    const fn = vi.fn(async () => { throw new Error('HTTP 404: substate not found') })
    await expect(withBusyRetry(fn, { attempts: 3 })).rejects.toThrow('HTTP 404')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ends in the plain busy message', async () => {
    await expect(withBusyRetry(async () => { throw new Error('HTTP 429: slow down') }, { attempts: 2 }))
      .rejects.toThrow(NETWORK_BUSY_MESSAGE)
  })
})
