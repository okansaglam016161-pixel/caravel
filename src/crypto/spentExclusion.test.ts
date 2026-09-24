// The two places a spent coin must disappear from, and the reason there are two.
//
// walletScanner feeds the BALANCE; stealthUtxos feeds the SPENDABLE INPUTS. They are separate
// walks over the same listing, and excluding in only one of them fixes only one of the two
// confirmed failures:
//
//   balance only   — the number looks right and the next send still selects the spent coin, so the
//                    chain rejects it ("Input substate utxo_... is down") after taking the fee.
//   selection only — the transaction is fine and the wallet goes on displaying money it spent.
//
// Both are covered here, against the same crafted listing, so neither can regress alone.
//
// THE SDK AND THE NETWORK ARE BOTH FAKED, deliberately. What is under test is the filtering, not
// the cryptography: a real decrypt would need real wasm and a real view key to prove a property
// that is purely about set membership. The live proof that the real decrypt still works is the
// harness (`scripts/harness.mjs scan`), which runs the unmocked modules against the real indexer.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tari-project/ootle', () => ({
  TARI_RESOURCE_ADDRESS: 'resource_0101',
  Network: { Esmeralda: 38 },
  WasmStealthCrypto: class { constructor(_n?: number) { /* stateless fake */ } },
  // Ours iff the commitment is in OWNED, mirroring a trial decrypt that succeeds or returns null.
  decryptOwnedUtxo: vi.fn(async (_c: unknown, _v: Uint8Array, _s: unknown, substateId: string) => {
    const value = OWNED[substateId]
    return value === undefined ? null : { value, mask: {}, memo: undefined }
  }),
}))

const { scanWallet } = await import('./walletScanner')
const { scanOwnedUtxos } = await import('./stealthUtxos')
const { RESOURCE_HEX } = await import('./utxoFeed')

const id = (c: string) => `utxo_${RESOURCE_HEX}_${c}`

/** commitment hex → value. Everything else in the listing belongs to somebody else. */
const OWNED: Record<string, bigint> = {}

const A = 'aaa', B = 'bbb', C = 'ccc'

/** A listing row. `public_nonce` is what stealthUtxos requires before it will call a row spendable. */
const row = (commitment: string) => [commitment, { output: { output: { public_nonce: 'dd' } } }]

beforeEach(() => {
  for (const k of Object.keys(OWNED)) delete OWNED[k]
  OWNED[id(A)] = 100n
  OWNED[id(B)] = 250n
  // C decrypts for nobody — a stranger's output, which is the overwhelming majority of the set.
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ utxos: [row(A), row(B), row(C)] }), { status: 200 })) as typeof fetch
})

const crypto = {} as Parameters<typeof scanOwnedUtxos>[0]
const VIEW = new Uint8Array(32).fill(1)
const scan = (excluded?: Set<string>) => scanWallet(VIEW, () => {}, new AbortController().signal, { excluded })

describe('the balance scan', () => {
  it('counts everything it owns when nothing is excluded', async () => {
    const r = await scan()
    expect(r.balance).toBe(350n)
    expect(r.utxos.map(u => u.id)).toEqual([id(A), id(B)])
    expect(r.excludedPresent).toEqual([])
  })

  it('drops a spent coin out of the balance even while the indexer still lists it', async () => {
    const r = await scan(new Set([id(A)]))
    expect(r.balance).toBe(250n)
    expect(r.utxos.map(u => u.id)).toEqual([id(B)])
  })

  // The value rides along: it is decrypted here anyway, and its sum is the exact understatement
  // the safety net reports. Throwing it away is what made a 1110 tTARI gap invisible.
  it('reports the excluded coin as still listed, WITH its value', async () => {
    const r = await scan(new Set([id(A)]))
    expect(r.excludedPresent).toEqual([{ id: id(A), microtari: 100n }])
  })

  // The whole set spent, and the listing has not caught up with any of it.
  it('goes to zero when everything it owns is spent', async () => {
    const r = await scan(new Set([id(A), id(B)]))
    expect(r.balance).toBe(0n)
    expect(r.utxos).toEqual([])
    expect(r.excludedPresent).toEqual([{ id: id(A), microtari: 100n }, { id: id(B), microtari: 250n }])
  })

  // Rows are still WALKED — exclusion is not truncation, and the diagnostic must stay honest.
  it('still reports every row it examined', async () => {
    const r = await scan(new Set([id(A), id(B)]))
    expect(r.totalScanned).toBe(3)
  })

  // A new change output is an ordinary unexcluded row: the set only ever subtracts.
  it('picks up a new owned output that is not excluded', async () => {
    const CHANGE = 'ddd'
    OWNED[id(CHANGE)] = 90n
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ utxos: [row(A), row(B), row(C), row(CHANGE)] }), { status: 200 })) as typeof fetch
    const r = await scan(new Set([id(A)]))
    expect(r.balance).toBe(340n)
    expect(r.utxos.map(u => u.id)).toContain(id(CHANGE))
  })
})

describe('input selection', () => {
  it('offers everything it owns when nothing is excluded', async () => {
    const owned = await scanOwnedUtxos(crypto, VIEW)
    expect(owned.map(u => u.substateId)).toEqual([id(A), id(B)])
  })

  // The half that prevents a doomed transaction rather than a wrong number.
  it('refuses to offer a spent coin as an input', async () => {
    const owned = await scanOwnedUtxos(crypto, VIEW, { excluded: new Set([id(A)]) })
    expect(owned.map(u => u.substateId)).toEqual([id(B)])
  })

  it('offers nothing when every owned output is spent', async () => {
    const owned = await scanOwnedUtxos(crypto, VIEW, { excluded: new Set([id(A), id(B)]) })
    expect(owned).toEqual([])
  })
})

describe('the two agree', () => {
  // They are separate walks; a coin excluded from one and not the other is the drift this pairing
  // exists to catch.
  it('balance and selection exclude the same coin', async () => {
    const excluded = new Set([id(B)])
    const [r, owned] = await Promise.all([scan(excluded), scanOwnedUtxos(crypto, VIEW, { excluded: excluded })])
    expect(r.utxos.map(u => u.id)).toEqual([id(A)])
    expect(owned.map(u => u.substateId)).toEqual([id(A)])
  })
})
