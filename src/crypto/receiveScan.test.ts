// Naming a receive from the transaction that made it, and never skipping a transaction unread.
//
// The walk is only as good as its cursor. A cursor that moves past a transaction the walk did not
// read drops any payment in it from this path forever, silently — so most of these specs pin the
// advance rule: forward only on proof the walk met the old cursor or ran out of history, and a
// budget-exhausted stretch remembered as a gap and finished later.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setStoreKey } from './sessionKey'
import { RESOURCE_HEX } from './utxoFeed'
import {
  FIRST_SCAN_PAGE_BUDGET, MAX_DISCOVERED, PROBE_PAGE_LIMIT, RECENT_PAGE_LIMIT, RETIRE_AFTER_MS, SCAN_PAGE_BUDGET,
  advanceIndexer, carriedOutputs, discoveredReceives, loadReceiveScan, retireDiscovered, scanRecentReceives, txCreatedAt,
  type IndexerCursor, type RecentPageFetcher, type RecentTxEntry,
} from './receiveScan'

const STORE_KEY = new Uint8Array(32).fill(7)
const ADDR = 'otl_esm_1receivescantest'
const URL_A = 'https://a.test'
const URL_B = 'https://b.test'
const VIEW = new Uint8Array(32)

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

const TARI = `resource_${RESOURCE_HEX}`
const sid = (c: string) => `utxo_${RESOURCE_HEX}_${c}`

/** A StealthTransfer carrying outputs with these commitments. */
const transfer = (commitments: string[], resource = TARI) => ({
  StealthTransfer: {
    resource_address_ref: { Address: resource },
    statement: {
      outputs_statement: {
        outputs: commitments.map(c => ({ output: { commitment: c, sender_public_nonce: 'ab', encrypted_data: 'cd' } })),
      },
    },
  },
})

/** A transaction entry as `/transactions/recent` returns it. */
const tx = (txId: string, commitments: string[] = [], opts: { fee?: boolean; resource?: string } = {}): RecentTxEntry => ({
  transaction_id: txId,
  transaction: { V1: { body: { transaction: {
    instructions: opts.fee ? [] : [transfer(commitments, opts.resource)],
    fee_instructions: opts.fee ? [transfer(commitments, opts.resource)] : [],
  } } } },
})

/** A node whose history is `chain`, newest first, paged by `last_id` exactly as the indexer does. */
function node(chain: RecentTxEntry[]): RecentPageFetcher & { calls: { lastId: string | null; limit: number }[] } {
  const calls: { lastId: string | null; limit: number }[] = []
  const f = (async (_url: string, lastId: string | null, limit: number) => {
    calls.push({ lastId, limit })
    const start = lastId === null ? 0 : chain.findIndex(e => e.transaction_id === lastId) + 1
    // An unknown last_id answers an empty list — measured on the live node.
    if (lastId !== null && start === 0) return []
    return chain.slice(start, start + limit)
  }) as RecentPageFetcher & { calls: typeof calls }
  f.calls = calls
  return f
}

/** `count` transactions, newest first, ids t<count-1> … t0. */
const history = (count: number) =>
  Array.from({ length: count }, (_, i) => tx(`t${count - 1 - i}`))

const NONE: IndexerCursor = { cursor: null, gap: null }
const noop = async () => {}

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

describe('reading outputs out of a transaction', () => {
  it('takes TARI stealth outputs from instructions and from fee instructions', () => {
    expect(carriedOutputs(tx('x', ['aa01', 'bb02'])).map(o => o.commitment)).toEqual(['aa01', 'bb02'])
    expect(carriedOutputs(tx('x', ['cc03'], { fee: true })).map(o => o.commitment)).toEqual(['cc03'])
  })

  // A substate id built under the TARI resource for another resource's output would name a coin
  // the balance does not count.
  it('skips another resource, and a workspace reference it cannot resolve', () => {
    expect(carriedOutputs(tx('x', ['aa01'], { resource: `resource_${'02'.repeat(32)}` }))).toEqual([])
    const ws = { transaction_id: 'x', transaction: { V1: { body: { transaction: {
      instructions: [{ StealthTransfer: { resource_address_ref: { Workspace: 0 }, statement: transfer(['aa01']).StealthTransfer.statement } }],
    } } } } }
    expect(carriedOutputs(ws)).toEqual([])
  })

  it('ignores malformed entries rather than throwing', () => {
    expect(carriedOutputs({ transaction_id: 'x' })).toEqual([])
    expect(carriedOutputs({ transaction_id: 'x', transaction: { V1: { body: { transaction: { instructions: ['DropAllProofsInWorkspace', null] } } } } })).toEqual([])
    expect(carriedOutputs(tx('x', ['not-hex']))).toEqual([])
  })
})

describe('the cursor advances only when the walk proves it read everything', () => {
  it('first walk: sets the cursor to the newest transaction', async () => {
    const f = node(history(5))
    const w = await advanceIndexer(URL_A, NONE, f, noop)
    expect(w.outcome).toBe('first')
    expect(w.after).toEqual({ cursor: 't4', gap: null })
  })

  it('first walk: bounded by FIRST_SCAN_PAGE_BUDGET, then starts from the newest — /utxos owns older history', async () => {
    const f = node(history(RECENT_PAGE_LIMIT * (FIRST_SCAN_PAGE_BUDGET + 5)))
    const w = await advanceIndexer(URL_A, NONE, f, noop)
    expect(w.pages).toBe(FIRST_SCAN_PAGE_BUDGET)
    expect(w.outcome).toBe('first')
    expect(w.after.gap).toBeNull()
  })

  it('reached: walks only what is new, advances to the newest, and probes with a small first page', async () => {
    const chain = history(50)            // t49 … t0
    const f = node(chain)
    const seen: string[] = []
    const w = await advanceIndexer(URL_A, { cursor: 't46', gap: null }, f, async e => { seen.push(e.transaction_id) })
    expect(seen).toEqual(['t49', 't48', 't47'])
    expect(w.outcome).toBe('reached')
    expect(w.after).toEqual({ cursor: 't49', gap: null })
    expect(f.calls[0]!.limit).toBe(PROBE_PAGE_LIMIT)
  })

  it('reached with nothing new: stays exactly where it was', async () => {
    const w = await advanceIndexer(URL_A, { cursor: 't9', gap: null }, node(history(10)), noop)
    expect(w.after).toEqual({ cursor: 't9', gap: null })
  })

  // The node no longer has the cursor (pruned, or never gossiped it). The walk read everything the
  // node holds, so there is nothing further it could have shown us.
  it('ended: history ran out before the cursor — advances, because nothing is left unread', async () => {
    const w = await advanceIndexer(URL_A, { cursor: 'gone', gap: null }, node(history(30)), noop)
    expect(w.outcome).toBe('ended')
    expect(w.after).toEqual({ cursor: 't29', gap: null })
  })

  // THE RULE. Budget exhausted before meeting the cursor: the cursor must NOT move.
  it('gap: budget runs out above the cursor — cursor HELD, the unread stretch remembered', async () => {
    const total = PROBE_PAGE_LIMIT + RECENT_PAGE_LIMIT * SCAN_PAGE_BUDGET + 500
    const chain = history(total)
    const w = await advanceIndexer(URL_A, { cursor: 't0', gap: null }, node(chain), noop)
    expect(w.outcome).toBe('gap')
    expect(w.after.cursor).toBe('t0')                         // not advanced
    expect(w.after.gap?.upper).toBe(`t${total - 1}`)          // newest read
    expect(w.after.gap?.resume).toBeDefined()
    expect(w.after.gap?.resume).not.toBe('t0')
  })

  it('gap: the next walk reads the new top, then finishes the gap, then advances — nothing skipped', async () => {
    const total = PROBE_PAGE_LIMIT + RECENT_PAGE_LIMIT * SCAN_PAGE_BUDGET + 500
    let chain = history(total)
    const seen = new Set<string>()
    const visit = async (e: RecentTxEntry) => { seen.add(e.transaction_id) }
    const w1 = await advanceIndexer(URL_A, { cursor: 't0', gap: null }, node(chain), visit)
    expect(w1.outcome).toBe('gap')

    // Three new transactions arrive before the next scan.
    chain = [tx('n2'), tx('n1'), tx('n0'), ...chain]
    const w2 = await advanceIndexer(URL_A, w1.after, node(chain), visit)
    expect(w2.outcome).toBe('reached')
    expect(w2.after).toEqual({ cursor: 'n2', gap: null })
    // EVERY transaction newer than the original cursor was visited, across the two walks.
    for (const e of chain) if (e.transaction_id !== 't0') expect(seen.has(e.transaction_id)).toBe(true)
  })

  it('a failed request concludes nothing and changes nothing', async () => {
    const before: IndexerCursor = { cursor: 't3', gap: null }
    const failing: RecentPageFetcher = async () => { throw new Error('boom') }
    const w = await advanceIndexer(URL_A, before, failing, noop)
    expect(w.outcome).toBe('held')
    expect(w.after).toEqual(before)
  })

  it('a failure after the first page also holds — partial reads never advance', async () => {
    const chain = history(300)
    const ok = node(chain)
    let n = 0
    const flaky: RecentPageFetcher = async (u, l, lim) => { if (++n === 2) throw new Error('boom'); return ok(u, l, lim) }
    const w = await advanceIndexer(URL_A, { cursor: 't0', gap: null }, flaky, noop)
    expect(w.after).toEqual({ cursor: 't0', gap: null })
  })
})

describe('the walk, end to end', () => {
  const ours = (set: string[]) => async (o: { commitment: string }) => set.includes(o.commitment)

  it('remembers outputs our key opens, and only those', async () => {
    const f = node([tx('t1', ['aa01', 'bb02']), tx('t0', ['cc03'])])
    const r = await scanRecentReceives({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A], fetchPage: f, isOurs: ours(['bb02']), now: 1000,
    })
    expect(r.hits).toEqual([{ substateId: sid('bb02'), commitment: 'bb02', txId: 't1', at: 1000 }])
    expect(discoveredReceives(ADDR)).toEqual([{ id: sid('bb02'), at: 1000 }])
    expect(loadReceiveScan(ADDR).cursors[URL_A]).toEqual({ cursor: 't1', gap: null })
  })

  it('the same transaction on two nodes is decrypted once and remembered once', async () => {
    const chain = [tx('t0', ['aa01'])]
    const isOurs = vi.fn(ours(['aa01']))
    const r = await scanRecentReceives({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A, URL_B], fetchPage: node(chain), isOurs,
    })
    expect(isOurs).toHaveBeenCalledTimes(1)
    expect(r.hits).toHaveLength(1)
    expect(Object.keys(loadReceiveScan(ADDR).found)).toEqual([sid('aa01')])
    expect(Object.keys(loadReceiveScan(ADDR).cursors).sort()).toEqual([URL_A, URL_B])
  })

  it('an incremental walk does not re-read or re-date what it already found', async () => {
    let chain = [tx('t0', ['aa01'])]
    await scanRecentReceives({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A], fetchPage: node(chain), isOurs: ours(['aa01', 'bb02']), now: 1 })
    chain = [tx('t1', ['bb02']), ...chain]
    const r = await scanRecentReceives({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A], fetchPage: node(chain), isOurs: ours(['aa01', 'bb02']), now: 2 })
    expect(r.txsRead).toBe(1)
    expect(discoveredReceives(ADDR)).toEqual([{ id: sid('bb02'), at: 2 }, { id: sid('aa01'), at: 1 }])
  })

  // A send and a balance scan can walk at once. Discoveries are unioned at write time.
  it('two concurrent walks never erase each other\'s discoveries', async () => {
    const a = scanRecentReceives({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A], fetchPage: node([tx('t0', ['aa01'])]), isOurs: ours(['aa01']) })
    const b = scanRecentReceives({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_B], fetchPage: node([tx('u0', ['bb02'])]), isOurs: ours(['bb02']) })
    await Promise.all([a, b])
    expect(Object.keys(loadReceiveScan(ADDR).found).sort()).toEqual([sid('aa01'), sid('bb02')])
  })

  it('never throws for a node that will not answer', async () => {
    const r = await scanRecentReceives({
      walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A],
      fetchPage: async () => { throw new Error('down') }, isOurs: ours([]),
    })
    expect(r.walks[0]!.outcome).toBe('held')
    expect(loadReceiveScan(ADDR).cursors[URL_A]).toEqual({ cursor: null, gap: null })
  })

  it('keeps at most MAX_DISCOVERED, newest first', async () => {
    const many = Array.from({ length: MAX_DISCOVERED + 3 }, (_, i) => i.toString(16).padStart(4, '0'))
    await scanRecentReceives({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A], fetchPage: node([tx('t0', many)]), isOurs: async () => true })
    expect(discoveredReceives(ADDR)).toHaveLength(MAX_DISCOVERED)
  })
})

describe('dating a discovery by its transaction', () => {
  it('reads the indexer\'s zone-less created_at as UTC', () => {
    expect(txCreatedAt({ transaction_id: 'x', created_at: '2026-09-24 20:24:38.0' })).toBe(Date.UTC(2026, 8, 24, 20, 24, 38))
    expect(txCreatedAt({ transaction_id: 'x', created_at: 'nonsense' })).toBeNull()
    expect(txCreatedAt({ transaction_id: 'x' })).toBeNull()
  })

  // A first walk opens old outputs we have long since spent. Dated by discovery, each would be
  // re-read by id for half an hour; dated by its transaction, it is retired on the first absence.
  it('an old, definitively-absent discovery is retired on the first scan that finds it gone', async () => {
    const old = { ...tx('t0', ['aa01']), created_at: '2026-01-01 00:00:00.0' }
    const now = Date.UTC(2026, 8, 24)
    await scanRecentReceives({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A], fetchPage: node([old]), isOurs: async () => true, now })
    expect(discoveredReceives(ADDR)).toEqual([{ id: sid('aa01'), at: Date.UTC(2026, 0, 1) }])
    retireDiscovered(ADDR, new Set(), new Set([sid('aa01')]), now)
    expect(discoveredReceives(ADDR)).toEqual([])
  })

  it('never dates a discovery in the future, whatever the node\'s clock says', async () => {
    const ahead = { ...tx('t0', ['aa01']), created_at: '2099-01-01 00:00:00.0' }
    await scanRecentReceives({ walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A], fetchPage: node([ahead]), isOurs: async () => true, now: 42 })
    expect(discoveredReceives(ADDR)[0]!.at).toBe(42)
  })
})

describe('letting a discovered id go', () => {
  const seed = async () => scanRecentReceives({
    walletAddress: ADDR, viewSecret: VIEW, indexerUrls: [URL_A],
    fetchPage: node([tx('t0', ['aa01', 'bb02'])]), isOurs: async () => true, now: 0,
  })

  it('retires one we have spent', async () => {
    await seed()
    retireDiscovered(ADDR, new Set([sid('aa01')]), new Set(), 1)
    expect(discoveredReceives(ADDR).map(d => d.id)).toEqual([sid('bb02')])
  })

  // A fresh commit can 404 for a few seconds; an aborted transaction 404s forever.
  it('keeps a definitely-absent one until RETIRE_AFTER_MS, then lets it go', async () => {
    await seed()
    retireDiscovered(ADDR, new Set(), new Set([sid('aa01')]), RETIRE_AFTER_MS - 1)
    expect(discoveredReceives(ADDR)).toHaveLength(2)
    retireDiscovered(ADDR, new Set(), new Set([sid('aa01')]), RETIRE_AFTER_MS)
    expect(discoveredReceives(ADDR).map(d => d.id)).toEqual([sid('bb02')])
  })
})
