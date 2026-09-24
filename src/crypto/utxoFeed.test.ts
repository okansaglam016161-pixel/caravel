// The pagination boundary, against a stub that models the indexer's own SQL.
//
// THESE ARE THE FOUR WAYS A CURSOR WALK GOES WRONG, and each one of them is silent in production:
// a boundary row returned twice inflates a balance, a boundary row skipped loses funds from view,
// a set that is an exact multiple of the page size can terminate one page early, and a cursor the
// indexer does not advance loops against the network forever. The stub honours `id > from_id`
// oldest-first with a `limit`, which is what reader.rs::utxos_list does, so a change to the walk
// that breaks any of the four fails here rather than on someone's balance.

import { describe, expect, it, vi } from 'vitest'
import { UTXO_PAGE_LIMIT, MAX_UTXO_PAGES, fetchAllUtxoRows } from './utxoFeed'

// A single-element indexer list keeps these specs about the CURSOR WALK, which is what they were
// written for. The union across nodes is exercised separately, below.

/** A fake indexer holding `total` rows, honouring `from_id` as `id > from_id`, oldest-first. */
function stubIndexer(total: number, calls: string[]) {
  const all = Array.from({ length: total }, (_, i) => [`c${String(i).padStart(6, '0')}`, { i }] as [string, unknown])
  return vi.fn(async (url: string | URL) => {
    const u = new URL(String(url))
    const from = u.searchParams.get('from_id')
    calls.push(from ?? '<none>')
    const limit = Number(u.searchParams.get('limit'))
    const start = from === null ? 0 : all.findIndex(r => r[0] === from) + 1
    return { ok: true, json: async () => ({ utxos: all.slice(start, start + limit) }) } as Response
  })
}

describe('fetchAllUtxoRows', () => {
  it('reads the whole set across pages, in order, with no dup or skip at the boundary', async () => {
    const calls: string[] = []
    const total = UTXO_PAGE_LIMIT * 2 + 7
    vi.stubGlobal('fetch', stubIndexer(total, calls))
    const { rows, incomplete, pages } = await fetchAllUtxoRows({ indexerUrls: ['https://x.test'] })
    expect(rows).toHaveLength(total)
    expect(new Set(rows.map(r => r[0])).size).toBe(total)          // no duplicates
    expect(rows.map(r => r[0])).toEqual([...rows.map(r => r[0])].sort())  // no skips, order kept
    expect(pages).toBe(3)
    expect(incomplete).toBe(false)
    expect(calls).toEqual(['<none>', `c${String(UTXO_PAGE_LIMIT - 1).padStart(6, '0')}`, `c${String(UTXO_PAGE_LIMIT * 2 - 1).padStart(6, '0')}`])
  })

  it('an exact multiple of the page size still terminates (short final page is empty)', async () => {
    vi.stubGlobal('fetch', stubIndexer(UTXO_PAGE_LIMIT, []))
    const { rows, incomplete, pages } = await fetchAllUtxoRows({ indexerUrls: ['https://x.test'] })
    expect(rows).toHaveLength(UTXO_PAGE_LIMIT)
    expect(pages).toBe(2)
    expect(incomplete).toBe(false)
  })

  it('an empty first page is a real zero, not an error', async () => {
    vi.stubGlobal('fetch', stubIndexer(0, []))
    const { rows, incomplete, pages } = await fetchAllUtxoRows({ indexerUrls: ['https://x.test'] })
    expect(rows).toEqual([])
    expect(incomplete).toBe(false)
    expect(pages).toBe(1)
  })

  it('a stalled cursor stops instead of looping, and says incomplete', async () => {
    const page = Array.from({ length: UTXO_PAGE_LIMIT }, (_, i) => [`c${i}`, {}] as [string, unknown])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ utxos: page }) }) as Response))
    const { incomplete, pages } = await fetchAllUtxoRows({ indexerUrls: ['https://x.test'] })
    expect(incomplete).toBe(true)
    expect(pages).toBe(2)          // asked twice, saw the cursor repeat, stopped
    expect(pages).toBeLessThan(MAX_UTXO_PAGES)
  })
})

// ── THE UNION ACROSS INDEXERS ────────────────────────────────────────────────
//
// The two public Esmeralda nodes do not agree about which outputs are unspent. Measured at one
// moment, both walked to the end: 1118 rows on indexer-a, 1112 on indexer-b, 1125 in the union —
// 13 only on a, 7 only on b. The disagreement is SYMMETRIC, so there is no good node to pick, and
// a wallet reading either alone is missing coins it owns.

/** A node holding exactly these ids, one page, honouring nothing else. */
const node = (ids: string[]) => () =>
  ({ ok: true, json: async () => ({ utxos: ids.map(id => [id, { from: id }]) }) }) as Response

/** Route by host so each node can hold a different set — or fall over. */
function twoNodes(a: () => Response, b: () => Response) {
  return vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.startsWith('https://a.test')) return a()
    if (href.startsWith('https://b.test')) return b()
    throw new TypeError('unreachable')
  })
}
const URLS = ['https://a.test', 'https://b.test']
const dead = () => { throw new TypeError('fetch failed') }

describe('reading more than one indexer', () => {
  it('takes the union, so a coin either node lists is counted', async () => {
    vi.stubGlobal('fetch', twoNodes(node(['x', 'y']), node(['y', 'z'])))
    const { rows, incomplete } = await fetchAllUtxoRows({ indexerUrls: URLS })
    expect(rows.map(r => r[0]).sort()).toEqual(['x', 'y', 'z'])
    expect(incomplete).toBe(false)
  })

  // The same coin from two nodes is ONE coin. Counting it twice would overstate the balance and
  // offer input selection a self-double-spend.
  it('deduplicates by commitment across nodes', async () => {
    vi.stubGlobal('fetch', twoNodes(node(['x', 'y']), node(['x', 'y'])))
    const { rows } = await fetchAllUtxoRows({ indexerUrls: URLS })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r[0])).size).toBe(2)
  })

  it('reports what each node contributed', async () => {
    vi.stubGlobal('fetch', twoNodes(node(['x', 'y']), node(['z'])))
    const { sources } = await fetchAllUtxoRows({ indexerUrls: URLS })
    expect(sources.map(s => [s.url, s.rows, s.ok])).toEqual([
      ['https://a.test', 2, true],
      ['https://b.test', 1, true],
    ])
  })

  it('carries on when a node is down, and says the set may be short', async () => {
    vi.stubGlobal('fetch', twoNodes(dead, node(['z'])))
    const { rows, incomplete, sources } = await fetchAllUtxoRows({ indexerUrls: URLS })
    expect(rows.map(r => r[0])).toEqual(['z'])
    // A node that never answered may hold rows this union never saw — nothing may conclude from
    // an absence, which is exactly what `incomplete` tells every consumer.
    expect(incomplete).toBe(true)
    expect(sources.find(s => s.url === 'https://a.test')!.ok).toBe(false)
  })

  // An empty wallet and an unreachable network must never look the same.
  it('throws when EVERY node fails, rather than reporting an empty set', async () => {
    vi.stubGlobal('fetch', twoNodes(dead, dead))
    await expect(fetchAllUtxoRows({ indexerUrls: URLS })).rejects.toThrow(/any indexer/i)
  })

  it('a single-node list is an ordinary one-node read', async () => {
    vi.stubGlobal('fetch', twoNodes(node(['x']), node(['z'])))
    const { rows, incomplete } = await fetchAllUtxoRows({ indexerUrls: ['https://a.test'] })
    expect(rows.map(r => r[0])).toEqual(['x'])
    expect(incomplete).toBe(false)
  })

  it('refuses to run with no indexer configured at all', async () => {
    await expect(fetchAllUtxoRows({ indexerUrls: [] })).rejects.toThrow(/No indexer configured/i)
  })
})
