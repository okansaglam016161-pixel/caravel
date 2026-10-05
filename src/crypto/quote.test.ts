// The confirm-time check: a quote is refused — NOTHING SENT — when it is old, when what it spends
// has moved, or when the final transaction would not be accepted at the exact quoted fee.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIRM_FRESH_MS, QUOTE_MAX_AGE_MS, QuoteChanged, confirmQuote, confirmer } from './quote'

const accept = async () => ({ accepted: true as const })
const fresh = () => Date.now()

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

/** Answer every /substates read with `status` (200 = still there, 404 = gone). */
function substates(status: 200 | 404) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status === 200, status, json: async () => ({}), text: async () => '{}', headers: new Headers(),
  })))
}

describe('confirmQuote', () => {
  it('passes a fresh quote whose inputs are unspent and whose twin is accepted at the fee', async () => {
    substates(200)
    await expect(confirmQuote({ preparedAt: fresh(), simulate: accept, inputs: { ids: ['utxo_a'] } })).resolves.toBeUndefined()
  })

  it('refuses a quote older than two minutes, without even simulating', async () => {
    const simulate = vi.fn(accept)
    const now = 10_000_000
    await expect(confirmQuote({ preparedAt: now - QUOTE_MAX_AGE_MS - 1, simulate }, now))
      .rejects.toMatchObject({ name: 'QuoteChanged', reason: 'stale' })
    expect(simulate).not.toHaveBeenCalled()
  })

  it('refuses when an input has been spent since pricing', async () => {
    substates(404)
    await expect(confirmQuote({ preparedAt: fresh(), simulate: accept, inputs: { ids: ['utxo_a'] } }))
      .rejects.toMatchObject({ reason: 'inputs-gone' })
  })

  it('refuses when a pinned vault has moved', async () => {
    await expect(confirmQuote({ preparedAt: fresh(), simulate: accept, inputs: { landed: async () => 'maybe-landed' } }))
      .rejects.toMatchObject({ reason: 'inputs-gone' })
  })

  it('an underpaid twin is "fee-risen"; any other refusal is "rejected"', async () => {
    await expect(confirmQuote({ preparedAt: fresh(), simulate: async () => ({ accepted: false, kind: 'underpaid', reason: 'Required fees 9500 but 9491 paid' }) }))
      .rejects.toMatchObject({ reason: 'fee-risen', detail: 'Required fees 9500 but 9491 paid' })
    await expect(confirmQuote({ preparedAt: fresh(), simulate: async () => ({ accepted: false, kind: 'reject', reason: 'name taken' }) }))
      .rejects.toMatchObject({ reason: 'rejected' })
  })

  it('every refusal says nothing was sent', () => {
    for (const r of ['stale', 'inputs-gone', 'fee-risen', 'rejected'] as const) {
      const e = new QuoteChanged(r)
      expect(e).toBeInstanceOf(Error)
      expect(e.message).toMatch(/Nothing was sent/)
      expect(e.message).not.toMatch(/µtTARI|envelope|simulat/i)
    }
  })
})

describe('confirmer — confirm once, submit without paying for a second check', () => {
  it('submit re-checks unless confirm() passed within the freshness window', async () => {
    vi.useFakeTimers()
    const simulate = vi.fn(accept)
    const c = confirmer({ preparedAt: Date.now(), simulate })
    await c.confirm()
    await c.ensureConfirmed()
    expect(simulate).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(CONFIRM_FRESH_MS + 1)
    await c.ensureConfirmed()
    expect(simulate).toHaveBeenCalledTimes(2)
  })

  it('a one-shot submit with no confirm() still runs the check', async () => {
    const simulate = vi.fn(async () => ({ accepted: false as const, kind: 'underpaid' }))
    const c = confirmer({ preparedAt: Date.now(), simulate })
    await expect(c.ensureConfirmed()).rejects.toBeInstanceOf(QuoteChanged)
    expect(simulate).toHaveBeenCalledTimes(1)
  })
})
