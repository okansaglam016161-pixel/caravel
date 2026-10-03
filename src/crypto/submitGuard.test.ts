// The submit guard: a busy refusal is the only thing retried, and only after proof it did not land.
//
// What these pin, because each is a way to pay twice:
//   - an ambiguous failure (timeout, dropped connection, other 5xx) is NEVER resubmitted;
//   - a busy refusal is resubmitted only when the landed check says `not-landed`;
//   - the resubmit is the SAME call — the caller's closure over the one sealed envelope — never a
//     rebuild (asserted by counting calls to that one closure with the one envelope).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexerBusyError, retryTiming } from './indexerRetry'
import {
  SUBMIT_ATTEMPTS,
  SubmitMaybeLandedError,
  inputsStillUnspent,
  submitOnce,
  substateStillAbsent,
  versionsUnchanged,
  type LandedCheck,
} from './submitGuard'

const saved = { ...retryTiming }
beforeEach(() => { retryTiming.sleep = async () => {} })
afterEach(() => {
  Object.assign(retryTiming, saved)
  vi.unstubAllGlobals()
})

const ENVELOPE = { sealed: 'the one envelope' }
const busy = () => new Error('HTTP 503: Service Unavailable - saturated')
const notLanded: LandedCheck = async () => 'not-landed'
const maybeLanded: LandedCheck = async () => 'maybe-landed'

/** A provider double whose submitTransaction answers from a script. */
function provider(script: Array<Error | 'ok'>) {
  const seen: unknown[] = []
  const submitTransaction = vi.fn(async (envelope: unknown) => {
    seen.push(envelope)
    const next = script.shift()
    if (next === undefined) throw new Error('script exhausted')
    if (next instanceof Error) throw next
    return { transaction_id: 'tx_abc' }
  })
  return { submitTransaction, seen }
}

describe('submitOnce', () => {
  it('submits once when the indexer accepts', async () => {
    const p = provider(['ok'])
    const r = await submitOnce(() => p.submitTransaction(ENVELOPE), { landed: notLanded })
    expect(r.transaction_id).toBe('tx_abc')
    expect(p.submitTransaction).toHaveBeenCalledTimes(1)
  })

  it('after a busy refusal that did not land, resubmits the SAME envelope and says so', async () => {
    const p = provider([busy(), 'ok'])
    const onBusyRetry = vi.fn()
    const landed = vi.fn(notLanded)
    await submitOnce(() => p.submitTransaction(ENVELOPE), { landed, onBusyRetry })
    expect(p.seen).toEqual([ENVELOPE, ENVELOPE])
    expect(p.seen[0]).toBe(p.seen[1])          // the identical object, not a rebuild
    expect(landed).toHaveBeenCalledTimes(1)    // checked BEFORE the resubmit
    expect(onBusyRetry).toHaveBeenCalledTimes(1)
  })

  it('does NOT resubmit when the landed check cannot rule out a landing', async () => {
    const p = provider([busy(), 'ok'])
    await expect(submitOnce(() => p.submitTransaction(ENVELOPE), { landed: maybeLanded }))
      .rejects.toBeInstanceOf(SubmitMaybeLandedError)
    expect(p.submitTransaction).toHaveBeenCalledTimes(1)
  })

  for (const [label, err] of [
    ['a timeout', new Error('The operation was aborted due to timeout')],
    ['a dropped connection', new TypeError('fetch failed')],
    ['a 500', new Error('HTTP 500: Internal Server Error')],
    ['a 502', new Error('HTTP 502: Bad Gateway')],
    ['a 400', new Error('HTTP 400: Bad Request - Invalid transaction')],
  ] as const) {
    it(`NEVER resubmits after ${label} — it may have landed`, async () => {
      const p = provider([err, 'ok'])
      const landed = vi.fn(notLanded)
      await expect(submitOnce(() => p.submitTransaction(ENVELOPE), { landed })).rejects.toBe(err)
      expect(p.submitTransaction).toHaveBeenCalledTimes(1)
      expect(landed).not.toHaveBeenCalled()
    })
  }

  it('gives up with the plain busy message after SUBMIT_ATTEMPTS busy refusals', async () => {
    const p = provider(Array.from({ length: SUBMIT_ATTEMPTS }, busy))
    await expect(submitOnce(() => p.submitTransaction(ENVELOPE), { landed: notLanded }))
      .rejects.toBeInstanceOf(IndexerBusyError)
    expect(p.submitTransaction).toHaveBeenCalledTimes(SUBMIT_ATTEMPTS)
  })
})

// ── The landed checks, against a stubbed indexer ────────────────────────────

/** Stub fetch: path → status (and an optional body version). */
function indexer(map: Record<string, { status: number; version?: number } | Array<{ status: number; version?: number }>>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(map).find(k => url.endsWith(k))
    let entry = key ? map[key]! : { status: 404 }
    if (Array.isArray(entry)) entry = entry.length > 1 ? entry.shift()! : entry[0]!
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      headers: { get: () => null },
      json: async () => ({ version: entry.version ?? 0, substate: {} }),
    }
  }))
}

describe('inputsStillUnspent', () => {
  it('not landed while every input coin still exists', async () => {
    indexer({ '/substates/utxo_a': { status: 200 }, '/substates/utxo_b': { status: 200 } })
    expect(await inputsStillUnspent(['utxo_a', 'utxo_b'])()).toBe('not-landed')
  })
  it('maybe landed once any input coin is gone', async () => {
    indexer({ '/substates/utxo_a': { status: 200 }, '/substates/utxo_b': { status: 404 } })
    expect(await inputsStillUnspent(['utxo_a', 'utxo_b'])()).toBe('maybe-landed')
  })
  it('maybe landed with no inputs to check — no evidence is not "not landed"', async () => {
    expect(await inputsStillUnspent([])()).toBe('maybe-landed')
  })
})

describe('substateStillAbsent', () => {
  it('not landed while every indexer says the receipt does not exist', async () => {
    indexer({})
    expect(await substateStillAbsent('nft_receipt')()).toBe('not-landed')
  })
  it('maybe landed once the receipt exists', async () => {
    indexer({ '/substates/nft_receipt': { status: 200 } })
    expect(await substateStillAbsent('nft_receipt')()).toBe('maybe-landed')
  })
  it('maybe landed when no indexer can be read', async () => {
    indexer({ '/substates/nft_receipt': { status: 500 } })
    expect(await substateStillAbsent('nft_receipt')()).toBe('maybe-landed')
  })
})

describe('versionsUnchanged', () => {
  it('not landed while the vault version has not moved', async () => {
    indexer({ '/substates/vault_x': { status: 200, version: 7 } })
    const check = await versionsUnchanged(['vault_x'])
    expect(await check()).toBe('not-landed')
  })
  it('maybe landed once the version moved', async () => {
    // One read for the snapshot, one for the check (pointRead stops at the first indexer that answers).
    indexer({ '/substates/vault_x': [{ status: 200, version: 7 }, { status: 200, version: 8 }] })
    const check = await versionsUnchanged(['vault_x'])
    expect(await check()).toBe('maybe-landed')
  })
  it('maybe landed when the snapshot could not be taken', async () => {
    indexer({ '/substates/vault_x': { status: 500 } })
    const check = await versionsUnchanged(['vault_x'])
    expect(await check()).toBe('maybe-landed')
  })
  it('maybe landed with nothing to snapshot', async () => {
    expect(await (await versionsUnchanged([]))()).toBe('maybe-landed')
  })
})
