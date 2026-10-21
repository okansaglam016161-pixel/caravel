// cUSD scanning — the balance logic, with the network, the wasm decrypt and the listing all injected.
// What is pinned here is the POLICY: count only verified-live outputs, never a figure that might be
// short, recover our own outputs by id, and sum public from account vaults.

import { describe, expect, it, vi } from 'vitest'
import {
  scanCusdPrivate, readCusdPublic, accountVaultIds, cusdTotal, addCusdOutput, verifiedRead,
  type VerifiedRead, type CusdBalances,
} from './cusdScan'
import { CUSD_ASSET } from './assets'

const C = (n: number) => n.toString(16).padStart(64, '0')     // a fake commitment hex
const idOf = (commitment: string) => `utxo_${CUSD_ASSET.resourceHex}_${commitment}`

/** A verified-live Utxo body answer at `id`, holding `units` our opener will return. */
function liveBody(): unknown {
  return { verified: true, substate: { Utxo: { output: { commitment: 'x' }, is_frozen: false } } }
}

/** An opener keyed by substate id → units (null = not ours). */
function openerFrom(map: Record<string, bigint | null>) {
  return async (id: string) => (id in map ? map[id]! : null)
}

describe('scanCusdPrivate', () => {
  const listRows = (commitments: number[]) => async () => ({
    rows: commitments.map(n => [C(n), liveBody()] as [string, unknown]),
    incomplete: false,
  })

  it('counts only outputs a verified read vouches for, and sums them', async () => {
    const read = async (): Promise<VerifiedRead> => ({ kind: 'verified', body: liveBody() })
    const scan = await scanCusdPrivate({
      open: openerFrom({ [idOf(C(1))]: 5_000_000n, [idOf(C(2))]: 3_000_000n }),
      listRows: listRows([1, 2]),
      read,
      knownIds: [],
    })
    expect(scan.incomplete).toBe(false)
    expect(scan.units).toBe(8_000_000n)
    expect(scan.outputs.map(o => o.id).sort()).toEqual([idOf(C(1)), idOf(C(2))].sort())
  })

  it('drops an output the chain says is gone (spent / 404)', async () => {
    const read = async (path: string): Promise<VerifiedRead> =>
      path.includes(C(2)) ? { kind: 'absent' } : { kind: 'verified', body: liveBody() }
    const scan = await scanCusdPrivate({
      open: openerFrom({ [idOf(C(1))]: 5_000_000n, [idOf(C(2))]: 3_000_000n }),
      listRows: listRows([1, 2]),
      read,
      knownIds: [],
    })
    expect(scan.units).toBe(5_000_000n)
    expect(scan.gone).toContain(idOf(C(2)))
    expect(scan.incomplete).toBe(false)   // a definite "gone" is not incompleteness
  })

  it('is INCOMPLETE — never a short figure — when an owned output cannot be verified', async () => {
    const read = async (path: string): Promise<VerifiedRead> =>
      path.includes(C(2)) ? { kind: 'unknown' } : { kind: 'verified', body: liveBody() }
    const scan = await scanCusdPrivate({
      open: openerFrom({ [idOf(C(1))]: 5_000_000n, [idOf(C(2))]: 3_000_000n }),
      listRows: listRows([1, 2]),
      read,
      knownIds: [],
    })
    expect(scan.incomplete).toBe(true)
    expect(scan.unverified).toContain(idOf(C(2)))
  })

  it('recovers a known claim output the listing has not shown yet', async () => {
    const recovered = idOf(C(9))
    const read = async (): Promise<VerifiedRead> => ({ kind: 'verified', body: liveBody() })
    const scan = await scanCusdPrivate({
      open: openerFrom({ [recovered]: 10_000_000_000n }),
      listRows: listRows([]),           // empty listing
      read,
      knownIds: [recovered],
    })
    expect(scan.recovered).toEqual([recovered])
    expect(scan.units).toBe(10_000_000_000n)
  })

  it('never counts a coin this wallet already spent, even while an indexer still vouches for it', async () => {
    // Measured live (T3b): right after a cUSD spend committed, the first indexer read still returned a
    // `verified: true` live body for the spent coin; both said 404 a minute later.
    const read = async (): Promise<VerifiedRead> => ({ kind: 'verified', body: liveBody() })
    const scan = await scanCusdPrivate({
      open: openerFrom({ [idOf(C(1))]: 9_976_000_000n, [idOf(C(2))]: 9_974_000_000n }),
      listRows: listRows([1, 2]),
      read,
      knownIds: [],
      spentIds: new Set([idOf(C(1))]),
    })
    expect(scan.units).toBe(9_974_000_000n)
  })

  it('counts OUR OWN fresh output from an unverified body (a just-made claim) — never a stranger\'s', async () => {
    // Both read `unknown` verified (freshly written). C(9) is our recorded claim output; C(3) is a
    // listed row our key opens but that we never recorded — still needs a verified read.
    const read = async (): Promise<VerifiedRead> => ({ kind: 'unknown' })
    const readAny = async () => liveBody()
    const scan = await scanCusdPrivate({
      open: openerFrom({ [idOf(C(9))]: 10_000_000_000n, [idOf(C(3))]: 7_000_000n }),
      listRows: listRows([3]),
      read,
      readAny,
      knownIds: [idOf(C(9))],
    })
    expect(scan.outputs.map(o => o.id)).toEqual([idOf(C(9))])
    expect(scan.ownUnverified).toEqual([idOf(C(9))])
    expect(scan.unverified).toEqual([idOf(C(3))])
    expect(scan.incomplete).toBe(true)   // the stranger row keeps the total honest
  })

  it('an own output nobody serves yet stays unverified — the figure is not established', async () => {
    const scan = await scanCusdPrivate({
      open: openerFrom({ [idOf(C(9))]: 10_000_000_000n }),
      listRows: listRows([]),
      read: async () => ({ kind: 'unknown' }),
      readAny: async () => undefined,
      knownIds: [idOf(C(9))],
    })
    expect(scan.units).toBe(0n)
    expect(scan.incomplete).toBe(true)
  })

  it('does not count a recovered id the view key does not actually open', async () => {
    const recovered = idOf(C(9))
    const read = async (): Promise<VerifiedRead> => ({ kind: 'verified', body: liveBody() })
    const scan = await scanCusdPrivate({
      open: openerFrom({}),             // opens nothing
      listRows: listRows([]),
      read,
      knownIds: [recovered],
    })
    expect(scan.units).toBe(0n)
    expect(scan.gone).toContain(recovered)
  })
})

describe('accountVaultIds', () => {
  it('reads CBOR tag-132 vault refs out of account state', () => {
    const body = { substate: { Component: { body: { state: [
      { '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex: 'a'.repeat(64) } },
    ] } } } }
    expect(accountVaultIds(body)).toEqual(['vault_' + 'a'.repeat(64)])
  })
  it('reads a plain vault_ string too', () => {
    const body = { substate: { Component: { body: { state: ['vault_' + 'b'.repeat(64)] } } } }
    expect(accountVaultIds(body)).toEqual(['vault_' + 'b'.repeat(64)])
  })
})

describe('readCusdPublic', () => {
  it('is a real zero when the account does not exist', async () => {
    const read = async (): Promise<VerifiedRead> => ({ kind: 'absent' })
    expect(await readCusdPublic('component_acct', read)).toEqual({ kind: 'ok', units: 0n })
  })

  it('zero for a wallet with no account, without touching the network', async () => {
    let called = false
    const read = async (): Promise<VerifiedRead> => { called = true; return { kind: 'absent' } }
    expect(await readCusdPublic(null, read)).toEqual({ kind: 'ok', units: 0n })
    expect(called).toBe(false)
  })

  it('sums the cUSD revealed in the account vaults', async () => {
    const vault = 'vault_' + 'c'.repeat(64)
    const read = async (path: string): Promise<VerifiedRead> => {
      if (path.endsWith('component_acct')) {
        return { kind: 'verified', body: { substate: { Component: { body: { state: [vault] } } } } }
      }
      return { kind: 'verified', body: { substate: { Vault: { resource_container: { Stealth: {
        address: CUSD_ASSET.resource, revealed_amount: '12000000', locked_amount: '0',
      } } } } } }
    }
    expect(await readCusdPublic('component_acct', read)).toEqual({ kind: 'ok', units: 12_000_000n })
  })

  it('is unknown when a named vault cannot be verified', async () => {
    const vault = 'vault_' + 'c'.repeat(64)
    const read = async (path: string): Promise<VerifiedRead> =>
      path.endsWith('component_acct')
        ? { kind: 'verified', body: { substate: { Component: { body: { state: [vault] } } } } }
        : { kind: 'unknown' }
    expect((await readCusdPublic('component_acct', read)).kind).toBe('unknown')
  })
})

describe('cusdTotal', () => {
  const base = (over: Partial<CusdBalances>): CusdBalances => ({
    private: { outputs: [], units: 0n, incomplete: false, unverified: [], gone: [], recovered: [], ownUnverified: [], listed: 0 },
    public: { kind: 'ok', units: 0n },
    ...over,
  })
  it('sums private and public when both are established', () => {
    expect(cusdTotal(base({
      private: { outputs: [], units: 6_000_000n, incomplete: false, unverified: [], gone: [], recovered: [], ownUnverified: [], listed: 0 },
      public: { kind: 'ok', units: 4_000_000n },
    }))).toBe(10_000_000n)
  })
  it('is null when the private half is incomplete', () => {
    expect(cusdTotal(base({
      private: { outputs: [], units: 6_000_000n, incomplete: true, unverified: ['x'], gone: [], recovered: [], ownUnverified: [], listed: 0 },
    }))).toBeNull()
  })
  it('is null when the public half is unknown', () => {
    expect(cusdTotal(base({ public: { kind: 'unknown', reason: 'x' } }))).toBeNull()
  })
})

describe('addCusdOutput — a claim counted the moment it commits', () => {
  const base: CusdBalances = {
    private: { outputs: [{ id: 'a', units: 5n }], units: 5n, incomplete: false, unverified: [], gone: [], recovered: [], ownUnverified: [], listed: 1 },
    public: { kind: 'ok', units: 3n },
  }
  it('adds the output to the private side, so the total rises by exactly its value', () => {
    const b = addCusdOutput(base, 'claim', 10_000_000_000n)
    expect(cusdTotal(b)).toBe(10_000_000_008n)
  })
  it('never counts the same output twice', () => {
    expect(addCusdOutput(base, 'a', 5n)).toBe(base)
  })
})

// Ootle 0.47 serves the value at `state.up.substate`. On that shape public cUSD read "unknown — the
// account was not in the expected shape" and every private output went to `gone`.
describe('cUSD reads on a 0.47 indexer', () => {
  const up = (substate: unknown) => ({ version: 0, state: { up: { substate } }, verified: true })
  const vault = 'vault_' + 'c'.repeat(64)

  it('accountVaultIds reads the account from `state.up.substate`', () => {
    expect(accountVaultIds(up({ Component: { body: { state: [vault] } } }))).toEqual([vault])
  })

  it('readCusdPublic sums the 0.47 vaults: the test wallet’s 8.4 cUSD', async () => {
    const read = async (path: string): Promise<VerifiedRead> => path.endsWith('component_acct')
      ? { kind: 'verified', body: up({ Component: { body: { state: [vault] } } }) }
      : { kind: 'verified', body: up({ Vault: { resource_container: { Stealth: { address: CUSD_ASSET.resource, revealed_amount: '8400000', locked_amount: '0' } } } }) }
    expect(await readCusdPublic('component_acct', read)).toEqual({ kind: 'ok', units: 8_400_000n })
  })

  it('scanCusdPrivate counts an output whose verified read is in the 0.47 shape', async () => {
    const read = async (): Promise<VerifiedRead> => ({ kind: 'verified', body: up({ Utxo: { output: { commitment: 'x' }, is_frozen: false } }) })
    const scan = await scanCusdPrivate({
      open: openerFrom({ [idOf(C(1))]: 5_000_000n }),
      listRows: async () => ({ rows: [[C(1), liveBody()]], incomplete: false }),
      read, knownIds: [], spentIds: new Set(),
    })
    expect(scan).toMatchObject({ units: 5_000_000n, incomplete: false, gone: [] })
  })
})

describe('verifiedRead — one node at a time, in either shape', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

  it('a verified 0.47 body comes back with `substate` lifted out', async () => {
    const value = { Vault: {} }
    vi.stubGlobal('fetch', vi.fn(async () => ok({ version: 0, state: { up: { substate: value } }, verified: true })))
    const r = await verifiedRead('/substates/vault_x')
    vi.unstubAllGlobals()
    expect(r.kind).toBe('verified')
    expect((r as { body: { substate: unknown } }).body.substate).toEqual(value)
  })

  it('a 0.47 down on every node is absent, the same as a 404 everywhere', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ version: 2, state: { down: {} }, verified: true })))
    const r = await verifiedRead('/substates/utxo_x')
    vi.unstubAllGlobals()
    expect(r).toEqual({ kind: 'absent' })
  })
})
