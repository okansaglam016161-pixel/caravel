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
import { MAX_RECOVERY_READS, fetchOwnedRows, recoveryCandidates, recoveryCandidatesWithSource } from './ownedFeed'
import { discoveredReceives, type RecentPageFetcher, type RecentTxEntry } from './receiveScan'
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
    expect(feed.recoveries).toEqual([{ substateId: id(A), commitment: A, found: true, via: 'journal' }])
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
    expect(feed.recoveries).toEqual([{ substateId: id(A), commitment: A, found: false, via: 'journal' }])
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

// ── Stage 2c: receives named by the transaction walk ─────────────────────────
//
// crypto/receiveScan finds outputs our view key opens inside recent transactions, before any
// listing carries them. They join the journal's ids as a SECOND source for the same by-id recovery,
// through the same filters — and the same guards against resurrection and double counting.

describe('receives found in transactions — the second source', () => {
  const VIEW = new Uint8Array(32)
  const R = 'ee01', S = 'ff02'

  /** One node whose history is these transactions, newest first. */
  const chain = (...txs: RecentTxEntry[]): RecentPageFetcher => async (_u, lastId, limit) => {
    if (lastId !== null) return []
    return txs.slice(0, limit)
  }
  const tx = (txId: string, commitments: string[]): RecentTxEntry => ({
    transaction_id: txId,
    transaction: { V1: { body: { transaction: { fee_instructions: [], instructions: [{ StealthTransfer: {
      resource_address_ref: { Address: `resource_${RESOURCE_HEX}` },
      statement: { outputs_statement: { outputs: commitments.map(c => ({
        output: { commitment: c, sender_public_nonce: 'ab', encrypted_data: 'cd' },
      })) } },
    } }] } } } },
  })
  const ours = (set: string[]) => async (o: { commitment: string }) => set.includes(o.commitment)
  const walk = (fetchPage: RecentPageFetcher, isOurs: (o: { commitment: string }) => Promise<boolean>, now = 5_000) =>
    ({ fetchPage, isOurs, now })

  // THE POINT OF 2c: a receive no listing has, recovered by id because the walk named it.
  it('recovers a receive the listing does not have yet', async () => {
    const fetchSubstate = vi.fn(async () => liveBody)
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate,
      receiveScan: walk(chain(tx('t0', [R, 'dead'])), ours([R])),
    })
    expect(fetchSubstate).toHaveBeenCalledWith(id(R))
    expect(feed.rows.map(r => r[0])).toEqual([R])
    expect(feed.recoveries).toEqual([{ substateId: id(R), commitment: R, found: true, via: 'receive-scan' }])
    expect(feed.receiveScan?.hits.map(h => h.commitment)).toEqual([R])
  })

  it('is remembered, so a later scan with nothing new still recovers it', async () => {
    await fetchOwnedRows({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate: async () => null,
      receiveScan: walk(chain(tx('t0', [R])), ours([R])),
    })
    // Next scan: the cursor is at t0, so the walk reads nothing — but the id is kept.
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate: async () => liveBody,
      receiveScan: walk(chain(tx('t0', [R])), ours([R])),
    })
    expect(feed.receiveScan?.txsRead).toBe(0)
    expect(feed.rows.map(r => r[0])).toEqual([R])
  })

  it('does not run the walk without a view key — the stage-2b feed, unchanged', async () => {
    const fetchPage = vi.fn(chain(tx('t0', [R])))
    const feed = await fetchOwnedRows({ walletAddress: ADDR, indexerUrls: URLS, receiveScan: { fetchPage } })
    expect(fetchPage).not.toHaveBeenCalled()
    expect(feed.receiveScan).toBeNull()
  })

  // SPENT-SET, direction one: found by the walk, later spent by us. It must not come back.
  it('never re-adds a discovered receive we have since spent — locked or spent', async () => {
    const fetchSubstate = vi.fn(async () => liveBody)
    const receiveScan = walk(chain(tx('t0', [R])), ours([R]))
    await fetchOwnedRows({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate, receiveScan })
    expect(fetchSubstate).toHaveBeenCalledTimes(1)

    markLocked(ADDR, [id(R)], 'spend-it')
    const locked = await fetchOwnedRows({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate, receiveScan })
    expect(locked.rows).toEqual([])
    promoteToSpent(ADDR, 'spend-it')
    const spent = await fetchOwnedRows({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate, receiveScan })
    expect(spent.rows).toEqual([])
    expect(fetchSubstate).toHaveBeenCalledTimes(1)
    // And once spent for good, it is let go entirely.
    expect(discoveredReceives(ADDR)).toEqual([])
  })

  // SPENT-SET, direction two: already spent when the walk finds it (e.g. a re-walk from a fresh
  // cursor over a transaction whose output we have since spent). Never asked for at all.
  it('never asks for a receive that is already in the spend record when the walk finds it', async () => {
    markLocked(ADDR, [id(R)], 'earlier')
    const fetchSubstate = vi.fn(async () => liveBody)
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate,
      receiveScan: walk(chain(tx('t0', [R])), ours([R])),
    })
    expect(fetchSubstate).not.toHaveBeenCalled()
    expect(feed.rows).toEqual([])
  })

  // DEDUP: in the listing AND found by the walk — one row, and no extra read.
  it('a receive the listing already has costs nothing and counts once', async () => {
    vi.stubGlobal('fetch', listing([R]))
    const fetchSubstate = vi.fn(async () => liveBody)
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate,
      receiveScan: walk(chain(tx('t0', [R])), ours([R])),
    })
    expect(fetchSubstate).not.toHaveBeenCalled()
    expect(feed.rows.map(r => r[0])).toEqual([R])
  })

  // DEDUP: our own change output is in the journal AND opened by the walk. Asked for once, and
  // described as the journal's.
  it('an id named by both sources is asked for once, as a journal id', async () => {
    beginEntry(ADDR, sent([id(S)]), 9_000)
    const fetchSubstate = vi.fn(async () => liveBody)
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate,
      receiveScan: walk(chain(tx('t0', [S, R])), ours([S, R]), 9_000),
    })
    expect(fetchSubstate).toHaveBeenCalledTimes(2)
    expect(feed.rows.map(r => r[0]).sort()).toEqual([R, S])
    expect(feed.recoveries.find(r => r.substateId === id(S))?.via).toBe('journal')
    expect(feed.recoveries.find(r => r.substateId === id(R))?.via).toBe('receive-scan')
  })

  it('merges both sources newest first under the one cap', async () => {
    beginEntry(ADDR, sent([id('0ld0')]), 1_000)
    await fetchOwnedRows({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS, fetchSubstate: async () => null,
      receiveScan: walk(chain(tx('t0', [R])), ours([R]), 5_000),
    })
    expect(recoveryCandidatesWithSource(ADDR, new Set(), 1)).toEqual([{ substateId: id(R), via: 'receive-scan' }])
    expect(recoveryCandidates(ADDR, new Set())).toEqual([id(R), id('0ld0')])
  })

  it('a node that cannot be read does not fail the feed', async () => {
    vi.stubGlobal('fetch', listing([A]))
    const feed = await fetchOwnedRows({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: URLS,
      receiveScan: { fetchPage: async () => { throw new Error('down') }, isOurs: ours([]) },
    })
    expect(feed.rows.map(r => r[0])).toEqual([A])
  })
})
