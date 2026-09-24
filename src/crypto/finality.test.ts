// Waiting for a decision, and reading it ourselves.
//
// TWO PROPERTIES ARE UNDER TEST and both were paid for in production incidents:
//
//   THE VERDICT IS OURS. `PendingTransaction.watch()` resolves on a commit and throws on anything
//   else, folding `FeeIntentCommit` into a rejection error. That is close to right, and this
//   codebase has already been burned once by trusting a summary of a three-variant union — a
//   fee-only commit reported to a user as a success. So the watcher supplies TIMING and
//   crypto/txResult supplies the verdict, and a throw from `watch()` must change nothing.
//
//   A VERDICT THAT EXISTS IS NEVER LOST. A dropped stream, a proxy that eats event streams, a
//   transient error on the SDK's own read — none of them may turn a decided transaction into a
//   `Timeout`, because a `Timeout` strands the spend's inputs until a later sweep.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { awaitFinality, SETTLE_TIMEOUT_MS } from './finality'
import type { IndexerProvider } from '@tari-project/ootle-indexer'

const finalized = (result: unknown, decision = 'Commit') => ({
  result: { Finalized: { final_decision: decision, execution_result: { finalize: { result } } } },
})
const ACCEPT = finalized({ Accept: {} })
const REJECT = finalized({ Reject: { ExecutionFailure: 'Input substate utxo_… is down' } })
const FEE_ONLY = finalized({ AcceptFeeRejectRest: [{}, { SubstateNotFound: 'vault_6a6de7ab' }] })
const UNDECIDED = { result: { Finalized: { final_decision: '' } } }

const TX = 'tx_abc123'

/** The specs are about which answer wins, not about how long anything waits. */
const FAST = { timeoutMs: 120, pollIntervalMs: 10, useStream: true }

/** A provider whose watcher behaves however a spec needs it to. */
function fakeProvider(opts: {
  watch?: () => Promise<unknown>
  receipt?: () => Promise<unknown>
  createThrows?: boolean
}): { provider: IndexerProvider; watchTransactionSSE: ReturnType<typeof vi.fn> } {
  const watchTransactionSSE = vi.fn((_txId: string, _timeoutMs?: number) => {
    if (opts.createThrows) throw new Error('watcher unavailable')
    return {
      watch: opts.watch ?? (async () => 'Commit'),
      getReceipt: opts.receipt ?? (async () => ACCEPT),
    }
  })
  return { provider: { watchTransactionSSE } as unknown as IndexerProvider, watchTransactionSSE }
}

beforeEach(() => {
  // Any REST fallback must be explicit in a spec; by default there is no network.
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch
})

describe('reading the verdict', () => {
  it('Accept is a Commit, and the body comes back for the caller', async () => {
    const { provider } = fakeProvider({ receipt: async () => ACCEPT })
    const r = await awaitFinality(provider, TX, FAST)
    expect(r.outcome).toBe('Commit')
    expect(r.body).toEqual(ACCEPT)
    expect(r.reason).toBeUndefined()
  })

  it('Reject is a Reject, with the network’s own words', async () => {
    const { provider } = fakeProvider({
      watch: async () => { throw new Error('TransactionRejectedError') },
      receipt: async () => REJECT,
    })
    const r = await awaitFinality(provider, TX, FAST)
    expect(r.outcome).toBe('Reject')
    expect(r.reason).toContain('is down')
  })

  // THE ONE THAT MATTERS. A fee-only commit took the fee and moved nothing; reporting it as a
  // success is the bug crypto/txResult exists to prevent, and switching to a push watcher must
  // not quietly reintroduce it.
  it('a fee-only commit is a failure, not a success', async () => {
    const { provider } = fakeProvider({ receipt: async () => FEE_ONLY })
    const r = await awaitFinality(provider, TX, FAST)
    expect(r.outcome).toBe('Reject')
    expect(r.reason).toContain('took the fee')
  })

  it('an undecided result is a Timeout, never a verdict', async () => {
    const { provider } = fakeProvider({ receipt: async () => UNDECIDED })
    expect((await awaitFinality(provider, TX, FAST)).outcome).toBe('Timeout')
  })

  // The watcher's classification is deliberately not trusted in either direction.
  it('ignores a throw from watch() when the receipt says Accept', async () => {
    const { provider } = fakeProvider({
      watch: async () => { throw new Error('TransactionTimeoutError') },
      receipt: async () => ACCEPT,
    })
    expect((await awaitFinality(provider, TX, FAST)).outcome).toBe('Commit')
  })

  it('ignores a resolve from watch() when the receipt says Reject', async () => {
    const { provider } = fakeProvider({ watch: async () => 'Commit', receipt: async () => REJECT })
    expect((await awaitFinality(provider, TX, FAST)).outcome).toBe('Reject')
  })
})

describe('the fallback', () => {
  it('reads the result itself when the SDK’s receipt read fails', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(ACCEPT), { status: 200 })) as typeof fetch
    const { provider } = fakeProvider({ receipt: async () => { throw new Error('stream dropped') } })
    const r = await awaitFinality(provider, TX, FAST)
    expect(r.outcome).toBe('Commit')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('reads the result itself when the watcher cannot even be created', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(REJECT), { status: 200 })) as typeof fetch
    const { provider } = fakeProvider({ createThrows: true })
    expect((await awaitFinality(provider, TX, FAST)).outcome).toBe('Reject')
  })

  // Only when BOTH the watcher and our own read come up empty is it a timeout.
  it('times out only when nothing anywhere is readable', async () => {
    const { provider } = fakeProvider({ receipt: async () => { throw new Error('no') } })
    const r = await awaitFinality(provider, TX, FAST)
    expect(r.outcome).toBe('Timeout')
    expect(r.body).toBeNull()
  })

  it('a failing REST fallback does not throw', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline') }) as typeof fetch
    const { provider } = fakeProvider({ receipt: async () => { throw new Error('no') } })
    await expect(awaitFinality(provider, TX, FAST)).resolves.toMatchObject({ outcome: 'Timeout' })
  })
})

describe('the timeout', () => {
  // Three minutes against a 60-90s settle time. The old thirty seconds sat BELOW the normal settle
  // time, which is why timeouts were routine rather than informative.
  it('is far above the network’s real settle time', () => {
    expect(SETTLE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
  })

  it('is what the watcher is given, and is overridable per call', async () => {
    // The watcher resolves immediately with an Accept, so neither call waits on the race.
    const { provider, watchTransactionSSE } = fakeProvider({})
    await awaitFinality(provider, TX, { useStream: true })
    expect(watchTransactionSSE).toHaveBeenCalledWith(TX, SETTLE_TIMEOUT_MS)
    await awaitFinality(provider, TX, { timeoutMs: 5_000, useStream: true })
    expect(watchTransactionSSE).toHaveBeenLastCalledWith(TX, 5_000)
  })
})

describe('the race', () => {
  // THE MEASURED REALITY on Esmeralda: `/events` holds the connection open and sends only
  // keep-alive comments, so the watcher never resolves and REST carries every verdict. Before the
  // race existed, that cost 181 seconds on a real send for a decision the chain made in ninety.
  it('REST wins when the stream never speaks', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(ACCEPT), { status: 200 })) as typeof fetch
    const { provider } = fakeProvider({
      // A stream that stays open and says nothing, exactly as both public indexers do today.
      watch: () => new Promise(() => {}),
      receipt: () => new Promise(() => {}),
    })
    const r = await awaitFinality(provider, TX, FAST)
    expect(r.outcome).toBe('Commit')
  })

  it('the stream wins when it does speak, and the polling stops', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 404 }))
    globalThis.fetch = fetchSpy as typeof fetch
    const { provider } = fakeProvider({ receipt: async () => ACCEPT })
    const r = await awaitFinality(provider, TX, { timeoutMs: 5_000, pollIntervalMs: 2_000, useStream: true })
    expect(r.outcome).toBe('Commit')
    // Decided before the first poll interval even elapsed.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Neither side may turn an undecided transaction into a verdict.
  it('times out when neither side ever becomes decisive', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(UNDECIDED), { status: 200 })) as typeof fetch
    const { provider } = fakeProvider({ receipt: async () => UNDECIDED })
    const r = await awaitFinality(provider, TX, FAST)
    expect(r.outcome).toBe('Timeout')
    // The last body seen is still handed back, for the caller's diagnostics.
    expect(r.body).toEqual(UNDECIDED)
  })
})

describe('the stream side is currently off', () => {
  // Not a design retreat — see USE_SSE_WATCHER. The stream delivers nothing on Esmeralda today,
  // and stopping it trips an unhandled rejection inside the SDK's own generator. The race still
  // runs; REST is simply the only runner until that changes.
  it('does not open a connection by default, and REST still answers', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(ACCEPT), { status: 200 })) as typeof fetch
    const { provider, watchTransactionSSE } = fakeProvider({})
    const r = await awaitFinality(provider, TX, { timeoutMs: 120, pollIntervalMs: 10 })
    expect(watchTransactionSSE).not.toHaveBeenCalled()
    expect(r.outcome).toBe('Commit')
  })
})
