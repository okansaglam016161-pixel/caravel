// THE TRAP, for cUSD, with the real SDK and the real wasm: nothing about the coin is mocked.
//
// The cUSD balance (crypto/cusdScan) and the coins a trade spends (crypto/tradeCoins) each held UTXO
// bodies and wrapped them in a hand-built 0.46-shape response for `decryptOwnedUtxo`. SDK 0.10+ reads
// only `state.up.substate` and answers an unparseable response with the same null as "not ours", so
// every cUSD coin read as a stranger's: a 0 balance, and "not enough cUSD" for every trade. These
// build a real cUSD output for a real view key, lay it out as the live indexer lists one, serve the
// verified reads in the 0.47 shape, and require both paths to find its exact value.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Network, WasmStealthCrypto, createOutput } from '@tari-project/ootle'
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { CUSD_ASSET } from './assets'
import { scanCusdPrivate, verifiedRead, viewKeyOpener } from './cusdScan'
import { UnreadableUtxoError } from './openUtxo'
import { liveEverywhere, scanTradeCoins } from './tradeCoins'
import { retryTiming } from './indexerRetry'

const crypto = new WasmStealthCrypto(Network.Esmeralda)
const UNITS = 10_005_700_000n   // the test wallet's private cUSD, in base units

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, v) },
  }
}

beforeEach(() => { globalThis.localStorage = memoryStorage(); retryTiming.sleep = async () => {} })
afterEach(() => { vi.unstubAllGlobals() })

/** A real cUSD output to `wallet`, as a `/utxos` row with the live field names. */
async function cusdRowFor(wallet: SecretKeyWallet, amount = UNITS): Promise<[string, unknown]> {
  const { statement } = await crypto.generateOutputsStatement(
    [createOutput({ destination: await wallet.getAddress(), amount, resourceAddress: CUSD_ASSET.resource })],
    null,
  )
  const out = (statement.parsed() as {
    outputs: { output: { commitment: string; sender_public_nonce: string; encrypted_data: string }; auth: unknown; tag: number }[]
  }).outputs[0]!
  return [out.output.commitment, {
    output: {
      output: { public_nonce: out.output.sender_public_nonce, encrypted_data: out.output.encrypted_data, minimum_value_promise: 0, viewable_balance: null },
      auth: out.auth,
      tag: out.tag,
    },
    is_frozen: false,
  }]
}

const idOf = (commitment: string) => `utxo_${CUSD_ASSET.resourceHex}_${commitment}`
/** A verified 0.47 answer for a UTXO body. */
const verified047 = (utxo: unknown) => ({ version: 0, state: { up: { substate: { Utxo: utxo } } }, verified: true })

/** Every indexer: the cUSD listing, and each listed coin served by id, verified, in the 0.47 shape. */
function serve(rows: [string, unknown][]) {
  const byId = new Map(rows.map(([c, b]) => [idOf(c), b]))
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = new URL(String(url))
    if (u.pathname === '/utxos') return new Response(JSON.stringify({ utxos: rows }), { status: 200 })
    const id = decodeURIComponent(u.pathname.replace(/^\/substates\//, ''))
    const body = byId.get(id)
    return body ? new Response(JSON.stringify(verified047(body)), { status: 200 }) : new Response('{}', { status: 404 })
  }))
}

describe('the cUSD balance on a real coin', () => {
  it('opens our own cUSD coin to its exact value', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const [c, body] = await cusdRowFor(me)
    expect(await viewKeyOpener(await me.getViewSecret())(idOf(c), body)).toBe(UNITS)
  })

  it('is null for somebody else’s coin, and THROWS on one it cannot read', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const [c, body] = await cusdRowFor(SecretKeyWallet.randomWithViewKey(Network.Esmeralda))
    const open = viewKeyOpener(await me.getViewSecret())
    expect(await open(idOf(c), body)).toBeNull()
    await expect(open(idOf(c), 'garbage')).rejects.toBeInstanceOf(UnreadableUtxoError)
  })

  it('scanCusdPrivate counts it from 0.47 verified reads, complete and exact', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const mine = await cusdRowFor(me)
    const theirs = await cusdRowFor(SecretKeyWallet.randomWithViewKey(Network.Esmeralda), 1n)
    serve([mine, theirs])
    const scan = await scanCusdPrivate({ open: viewKeyOpener(await me.getViewSecret()), read: verifiedRead, knownIds: [], spentIds: new Set() })
    expect(scan).toMatchObject({ units: UNITS, incomplete: false, gone: [], unverified: [] })
    expect(scan.outputs.map(o => o.id)).toEqual([idOf(mine[0])])
  })
})

describe('the cUSD a trade may spend, on a real coin', () => {
  it('scanTradeCoins finds it whole: value, and the one-time spend key from its auth', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const mine = await cusdRowFor(me)
    serve([mine, await cusdRowFor(SecretKeyWallet.randomWithViewKey(Network.Esmeralda), 7n)])
    const coins = await scanTradeCoins(crypto, await me.getViewSecret(), await me.getAddress(), CUSD_ASSET.resource)
    expect(coins.map(c => c.value)).toEqual([UNITS])
    expect(coins[0]!.spendKey?.length).toBe(32)
  })
})

describe('liveEverywhere — both shapes, and an unreadable body is not "not live"', () => {
  const ID = idOf('ab'.repeat(32))
  const live = { output: { output: { public_nonce: 'aa', encrypted_data: 'bb' } }, is_frozen: false }
  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))

  it('live in the 0.47 shape, and in the 0.46 one', async () => {
    answer(verified047(live))
    expect(await liveEverywhere(ID)).toBe(true)
    answer({ version: 0, substate: { Utxo: live }, verified: true })
    expect(await liveEverywhere(ID)).toBe(true)
  })

  it('a spent output (null output), a 0.47 down and a 404 are all not live', async () => {
    answer(verified047({ ...live, output: null }))
    expect(await liveEverywhere(ID)).toBe(false)
    answer({ version: 1, state: { down: {} }, verified: true })
    expect(await liveEverywhere(ID)).toBe(false)
    answer({ error: 'not found' }, 404)
    expect(await liveEverywhere(ID)).toBe(false)
  })

  it('a body in neither shape is UNKNOWN (null), so the trade stops instead of dropping a good coin', async () => {
    answer({ version: 0, something: { new: true }, verified: true })
    expect(await liveEverywhere(ID)).toBeNull()
  })
})
