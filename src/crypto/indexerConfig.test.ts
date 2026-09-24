// Reading past one node's opinion.
//
// THE RULE UNDER TEST is that a 404 from ONE indexer is not an absence. Two readers depend on it
// and both make an expensive, wrong decision if it is broken: crypto/lockSweep turns "gone" into a
// permanent `spent` exclusion, and crypto/paymentResolver turns it into "this payment does not
// exist" shown to the person who received it. An absence is only believed once every node agrees,
// and a transport failure is never an absence at all.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INDEXER_URL, INDEXER_URLS, pointRead } from './indexerConfig'

const [A, B] = INDEXER_URLS as [string, string]

/** Respond per host, so a spec can make one node lie and the other tell the truth. */
function nodes(map: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (url: string | URL) => {
    const href = String(url)
    const base = Object.keys(map).find(b => href.startsWith(b))
    if (!base) throw new TypeError('unreachable')
    return map[base]!()
  })
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })
const notFound = () => new Response('{"error":"not found"}', { status: 404 })
const boom = () => new Response('upstream exploded', { status: 502 })
const dead = () => { throw new TypeError('fetch failed') }

beforeEach(() => { vi.unstubAllGlobals() })

describe('configuration', () => {
  it('reads more than one indexer by default, and the first is the primary', () => {
    expect(INDEXER_URLS.length).toBeGreaterThan(1)
    expect(INDEXER_URL).toBe(INDEXER_URLS[0])
  })

  it('carries no trailing slash, so `${base}/utxos` is never `//utxos`', () => {
    for (const u of INDEXER_URLS) expect(u.endsWith('/')).toBe(false)
  })
})

describe('pointRead', () => {
  it('takes the first definite answer and does not ask again', async () => {
    const fetchSpy = nodes({ [A]: ok({ hello: 'a' }), [B]: ok({ hello: 'b' }) })
    vi.stubGlobal('fetch', fetchSpy)
    const r = await pointRead('/substates/x')
    expect(r).toMatchObject({ body: { hello: 'a' }, answered: true, source: A })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // THE CASE THIS EXISTS FOR.
  it('falls through a 404 to a node that has the substate', async () => {
    vi.stubGlobal('fetch', nodes({ [A]: notFound, [B]: ok({ hello: 'b' }) }))
    const r = await pointRead('/substates/x')
    expect(r.body).toEqual({ hello: 'b' })
    expect(r.source).toBe(B)
  })

  it('believes an absence only once every node has said so', async () => {
    vi.stubGlobal('fetch', nodes({ [A]: notFound, [B]: notFound }))
    const r = await pointRead('/substates/x')
    expect(r.body).toBeNull()
    expect(r.answered).toBe(true)   // a definite "not there"
  })

  // `answered: false` is a different claim from `body: null`, and callers act on the difference:
  // lockSweep keeps a lock on `unknown` and promotes it to spent on `gone`.
  it('reports "nobody answered" when every node is unreachable', async () => {
    vi.stubGlobal('fetch', nodes({ [A]: dead, [B]: dead }))
    expect(await pointRead('/substates/x')).toEqual({ body: null, answered: false, source: null })
  })

  it('a 5xx says nothing about the resource and is not an absence', async () => {
    vi.stubGlobal('fetch', nodes({ [A]: boom, [B]: boom }))
    expect((await pointRead('/substates/x')).answered).toBe(false)
  })

  it('a node that is down is simply skipped', async () => {
    vi.stubGlobal('fetch', nodes({ [A]: dead, [B]: ok({ hello: 'b' }) }))
    expect((await pointRead('/substates/x')).body).toEqual({ hello: 'b' })
  })

  it('an unparseable 200 is not an answer either', async () => {
    vi.stubGlobal('fetch', nodes({
      [A]: () => new Response('<html>nope</html>', { status: 200 }),
      [B]: ok({ hello: 'b' }),
    }))
    expect((await pointRead('/substates/x')).body).toEqual({ hello: 'b' })
  })
})
