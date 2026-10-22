// What a committed transaction created — and still, once the indexer has pruned its result.
//
// The fixture is the live cancel x1c of the 0.47 matrix (tx 23a7d7a1…, 09:58:31), as `GET
// /transactions/<id>` served it an hour later, when `/transactions/<id>/result` already answered 404.
// Its two outputs are wallet A's: the 1 tTARI escrow back and the fee's 0.697293 change.

import { afterEach, describe, expect, it, vi } from 'vitest'
import body from './cancelTx.x1c.json'
import { fetchCreatedUtxoIds } from './txOutputs'

const TX = '23a7d7a1e4fcfabd1ff2b2e7c97fd88762c533157a7a13b83edf4c2144e6e759'
const TARI = 'utxo_' + '01'.repeat(32) + '_'
const ESCROW_BACK = TARI + 'f68f61e2f7771c598684a07941f11b93e5f93d1fcb92c69e1919d563a22b3a52'
const FEE_CHANGE = TARI + 'fee0da2824397288cd6584dffbd79f8d118f32061108619144ebdba16548055d'

function serve(routes: Record<string, { status: number; json?: unknown }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    const r = routes[path] ?? { status: 500 }
    return new Response(r.json === undefined ? '{}' : JSON.stringify(r.json), { status: r.status })
  }))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchCreatedUtxoIds', () => {
  it('a result the indexer has PRUNED (404): the committed transaction\'s own outputs answer', async () => {
    serve({ [`/transactions/${TX}/result`]: { status: 404 }, [`/transactions/${TX}`]: { status: 200, json: body } })
    expect((await fetchCreatedUtxoIds(TX))?.sort()).toEqual([ESCROW_BACK, FEE_CHANGE].sort())
  })

  it('a transaction that did not commit created nothing to claim: a hole (null), not []', async () => {
    const rejected = { ...body, transaction: { ...body.transaction, summary: { ...body.transaction.summary, outcome: 'Reject' } } }
    serve({ [`/transactions/${TX}/result`]: { status: 404 }, [`/transactions/${TX}`]: { status: 200, json: rejected } })
    expect(await fetchCreatedUtxoIds(TX)).toBeNull()
  })

  it('both gone: a hole (null) — asked again later, never read as "created nothing"', async () => {
    serve({ [`/transactions/${TX}/result`]: { status: 404 }, [`/transactions/${TX}`]: { status: 404 } })
    expect(await fetchCreatedUtxoIds(TX)).toBeNull()
  })
})
