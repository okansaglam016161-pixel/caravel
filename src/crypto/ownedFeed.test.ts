// Asking the chain for our own coins when no listing will admit they exist.
//
// THE FAILURE THIS CLOSES, measured: a change output returning HTTP 200 from `/substates/<id>` on
// BOTH public indexers while absent from BOTH nodes' fully-paginated `/utxos`. The balance came up
// short and the evidence-settle waited for a commitment the scan was structurally unable to find.
//
// The recovery is narrow on purpose — it asks only for ids the wallet RECORDED as its own, never
// for an arbitrary or discovered one — and the specs below pin the three filters that keep it
// narrow, plus the one thing it must never do: put a spent coin back.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setStoreKey } from './sessionKey'
import { beginEntry } from './journalStore'
import { markLocked, promoteToSpent, __resetSpentSessionForTests } from './spentOutputs'
import { MAX_RECOVERY_READS, fetchOwnedRows, recoveryCandidates } from './ownedFeed'
import { RESOURCE_HEX } from './utxoFeed'
import type { JournalDraft } from './journal'

const STORE_KEY = new Uint8Array(32).fill(11)
const ADDR = 'otl_esm_1tnay4uzgpe0cvu4tzwfmhdhtvc3pq97s'
const URLS = ['https://a.test']

const id = (c: string) => `utxo_${RESOURCE_HEX}_${c}`
const A = 'aaa', B = 'bbb', C = 'ccc'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

/** A send that created these outputs for us. */
const sent = (selfOutputIds: string[] | null): JournalDraft => ({
  kind: 'send', amountMicrotari: 1n, feeMicrotari: null,
  from: 'private', to: 'external', counterparty: null, note: null,
  source: 'local-journal', selfOutputIds, spentInputIds: null,
})

/** A listing holding exactly these commitments. */
const listing = (commitments: string[]) => vi.fn(async () =>
  ({ ok: true, json: async () => ({ utxos: commitments.map(c => [c, { listed: c }]) }) }) as Response)

/** A live UTXO body, shaped exactly as a listing row's body is. */
const liveBody = { output: { output: { public_nonce: 'dd' } }, is_frozen: false }

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  __resetSpentSessionForTests()
  setStoreKey(Uint8Array.from(STORE_KEY))
  vi.stubGlobal('fetch', listing([]))
})

describe('which of our outputs are worth asking about', () => {
  it('offers a recorded output the listing does not have', () => {
    beginEntry(ADDR, sent([id(A)]))
    expect(recoveryCandidates(ADDR, new Set())).toEqual([id(A)])
  })

  it('skips one the listing already returned — nothing to recover', () => {
    beginEntry(ADDR, sent([id(A)]))
    expect(recoveryCandidates(ADDR, new Set([A]))).toEqual([])
  })

  // THE ONE THAT MATTERS. Re-adding a spent coin would resurrect it into the balance AND into coin
  // selection — the precise failure crypto/spentOutputs exists to prevent, through a side door.
  it('never offers a coin we have already spent', () => {
    beginEntry(ADDR, sent([id(A)]))
    markLocked(ADDR, [id(A)], 'tx1')
    expect(recoveryCandidates(ADDR, new Set())).toEqual([])
    promoteToSpent(ADDR, 'tx1')
    expect(recoveryCandidates(ADDR, new Set())).toEqual([])
  })

  it('ignores entries with no readable outputs, and those that created none', () => {
    beginEntry(ADDR, sent(null))
    beginEntry(ADDR, sent([]))
    expect(recoveryCandidates(ADDR, new Set())).toEqual([])
  })

  it('offers each id once, however many entries mention it', () => {
    beginEntry(ADDR, sent([id(A)]), 1_000)
    beginEntry(ADDR, sent([id(A)]), 2_000)
    expect(recoveryCandidates(ADDR, new Set())).toEqual([id(A)])
  })

  // Newest first, so a hard cap spends its budget where recovery actually matters — a change
  // output from minutes ago, not a coin from last month.
  it('takes the newest first and stops at the cap', () => {
    beginEntry(ADDR, sent([id('old')]), 1_000)
    beginEntry(ADDR, sent([id('new')]), 9_000)
    expect(recoveryCandidates(ADDR, new Set(), 1)).toEqual([id('new')])
    expect(MAX_RECOVERY_READS).toBeGreaterThan(1)
  })

  it('is empty without a wallet address', () => {
    beginEntry(ADDR, sent([id(A)]))
    expect(recoveryCandidates('', new Set())).toEqual([])
  })
})

describe('the recovered feed', () => {
  it('does no extra reads when every recorded output is listed — the common case', async () => {
    beginEntry(ADDR, sent([id(A)]))
    vi.stubGlobal('fetch', listing([A]))
    const fetchSubstate = vi.fn()
    const feed = await fetchOwnedRows({ walletAddress: ADDR, indexerUrls: URLS, fetchSubstate })
    expect(fetchSubstate).not.toHaveBeenCalled()
    expect(feed.recoveries).toEqual([])
    expect(feed.rows.map(r => r[0])).toEqual([A])
  })

  it('does no recovery at all without a wallet address', async () => {
    beginEntry(ADDR, sent([id(A)]))
    const fetchSubstate = vi.fn()
    const feed = await fetchOwnedRows({ indexerUrls: URLS, fetchSubstate })
    expect(fetchSubstate).not.toHaveBeenCalled()
    expect(feed.recoveries).toEqual([])
  })

  // THE WHOLE POINT.
  it('recovers a live coin that no listing returned', async () => {
    beginEntry(ADDR, sent([id(A)]))
    const fetchSubstate = vi.fn(async () => liveBody)
    const feed = await fetchOwnedRows({ walletAddress: ADDR, indexerUrls: URLS, fetchSubstate })
    expect(fetchSubstate).toHaveBeenCalledWith(id(A))
    expect(feed.rows.map(r => r[0])).toEqual([A])
    expect(feed.recoveries).toEqual([{ substateId: id(A), commitment: A, found: true }])
  })

  it('hands the recovered coin back in the same shape a listing row has', async () => {
    beginEntry(ADDR, sent([id(A)]))
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, indexerUrls: URLS, fetchSubstate: async () => liveBody,
    })
    // Same tuple shape, same body — so the decrypt and parse downstream cannot tell them apart.
    expect(feed.rows[0]).toEqual([A, liveBody])
  })

  it('adds it alongside the listing, deduplicated', async () => {
    beginEntry(ADDR, sent([id(A), id(B)]))
    vi.stubGlobal('fetch', listing([B, C]))
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, indexerUrls: URLS, fetchSubstate: async () => liveBody,
    })
    expect(feed.rows.map(r => r[0]).sort()).toEqual([A, B, C])
    expect(new Set(feed.rows.map(r => r[0])).size).toBe(3)
  })

  // A coin that is genuinely gone, or a change output not yet on chain: both 404 everywhere.
  it('does not add one the chain has nothing for', async () => {
    beginEntry(ADDR, sent([id(A)]))
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, indexerUrls: URLS, fetchSubstate: async () => null,
    })
    expect(feed.rows).toEqual([])
    expect(feed.recoveries).toEqual([{ substateId: id(A), commitment: A, found: false }])
  })

  // NO NEGATIVE CACHE, deliberately: a 404 today and a 404 forever look identical at this moment,
  // so remembering the first would quietly stop looking for a coin that is about to arrive.
  it('asks again next scan for one that was not there yet', async () => {
    beginEntry(ADDR, sent([id(A)]))
    const fetchSubstate = vi.fn(async () => null)
    await fetchOwnedRows({ walletAddress: ADDR, indexerUrls: URLS, fetchSubstate })
    await fetchOwnedRows({ walletAddress: ADDR, indexerUrls: URLS, fetchSubstate })
    expect(fetchSubstate).toHaveBeenCalledTimes(2)
  })

  it('never asks for a coin we have spent', async () => {
    beginEntry(ADDR, sent([id(A)]))
    markLocked(ADDR, [id(A)], 'tx1')
    promoteToSpent(ADDR, 'tx1')
    const fetchSubstate = vi.fn(async () => liveBody)
    const feed = await fetchOwnedRows({ walletAddress: ADDR, indexerUrls: URLS, fetchSubstate })
    expect(fetchSubstate).not.toHaveBeenCalled()
    expect(feed.rows).toEqual([])
  })
})
