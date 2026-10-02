import { beforeEach, describe, expect, it } from 'vitest'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import {
  FAUCET_COMPONENT_ADDRESS,
  FAUCET_TEMPLATE_ADDRESS,
  FAUCET_VAULT_ADDRESS,
  faucetReceiptId,
} from './faucetConfig'
import {
  decodeFaucetState,
  decodeFaucetVault,
  faucetStatusFrom,
  loadFaucetClaimed,
  markFaucetClaimed,
  readFaucetStatus,
} from './faucetStatus'
import type { PointRead } from './indexerConfig'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  } as Storage
}

beforeEach(() => { globalThis.localStorage = memoryStorage() })

const WALLET = 'otl_esm_1testwallet'
const PK = 'ab'.repeat(32)

// The component substate exactly as `GET /substates/<faucet>` served it live after new().
function componentBody({ claimAmount = 1_000_000_000 as unknown, paused = false as unknown, template = FAUCET_TEMPLATE_ADDRESS } = {}) {
  return {
    version: 0,
    substate: {
      Component: {
        header: { template_address: template, owner_rule: { ByPublicKey: '20db'.padEnd(64, '0') } },
        body: {
          state: [
            { '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex: FAUCET_VAULT_ADDRESS.slice(6) } },
            claimAmount,
            paused,
            { '@cbor': 'tag', tag: 131, value: { '@cbor': 'bytes', hex: '56'.repeat(32) } },
            { '@cbor': 'tag', tag: 128, value: { '@cbor': 'bytes', hex: '4c'.repeat(32) } },
          ],
        },
      },
    },
  }
}

function vaultBody(revealed: string | number) {
  return {
    version: 1,
    substate: {
      Vault: {
        resource_container: { Stealth: { address: TARI_RESOURCE_ADDRESS, revealed_amount: revealed, locked_amount: '0' } },
        freeze_flags: 0,
      },
    },
  }
}

const found = (body: unknown): PointRead => ({ body, answered: true, source: 'a' })
const notFound: PointRead = { body: null, answered: true, source: 'a' }
const unreachable: PointRead = { body: null, answered: false, source: null }

describe('faucetReceiptId', () => {
  it('is the u256 NFT id of the claimer key under the receipt resource', () => {
    expect(faucetReceiptId(PK.toUpperCase()))
      .toBe(`nft_5694c70e0eaa25809e593c2f4ee85862b3fa71ea45d9ad01bf18f8accf35d621_uuid_${PK}`)
  })
})

describe('decodeFaucetState', () => {
  it('reads the claim amount and pause flag by position', () => {
    expect(decodeFaucetState(componentBody())).toEqual({ claimAmount: 1_000_000_000n, paused: false })
    expect(decodeFaucetState(componentBody({ paused: true }))).toEqual({ claimAmount: 1_000_000_000n, paused: true })
  })

  it('accepts a string amount and refuses one that lost precision', () => {
    expect(decodeFaucetState(componentBody({ claimAmount: '1000000000' }))?.claimAmount).toBe(1_000_000_000n)
    expect(decodeFaucetState(componentBody({ claimAmount: 2 ** 60 }))).toBeNull()
  })

  it('refuses a component from another template', () => {
    expect(decodeFaucetState(componentBody({ template: 'ff'.repeat(32) }))).toBeNull()
  })

  it('refuses anything that is not the expected shape', () => {
    expect(decodeFaucetState(null)).toBeNull()
    expect(decodeFaucetState({ substate: { Vault: {} } })).toBeNull()
    expect(decodeFaucetState(componentBody({ paused: 'no' }))).toBeNull()
    const short = componentBody()
    short.substate.Component.body.state.pop()
    expect(decodeFaucetState(short)).toBeNull()
  })
})

describe('decodeFaucetVault', () => {
  it('reads the revealed TARI', () => {
    expect(decodeFaucetVault(vaultBody('100000000000'))).toBe(100_000_000_000n)
  })
  it('is null for a shape it does not read', () => {
    expect(decodeFaucetVault({ substate: { Component: {} } })).toBeNull()
  })
})

describe('faucetStatusFrom — the order is claimed > paused > empty > open', () => {
  const open = [found(componentBody()), found(vaultBody('100000000000'))] as const

  it('open: not claimed, not paused, at least one claim left', () => {
    expect(faucetStatusFrom(...open, notFound))
      .toEqual({ kind: 'open', claimAmount: 1_000_000_000n, available: 100_000_000_000n })
  })

  it('claimed outranks everything, including a paused or empty faucet', () => {
    const receipt = found({ substate: { NonFungible: null } })
    expect(faucetStatusFrom(...open, receipt)).toEqual({ kind: 'claimed' })
    expect(faucetStatusFrom(found(componentBody({ paused: true })), found(vaultBody('0')), receipt)).toEqual({ kind: 'claimed' })
    // The receipt alone decides it: a faucet that cannot be read changes nothing.
    expect(faucetStatusFrom(unreachable, unreachable, receipt)).toEqual({ kind: 'claimed' })
  })

  it('paused outranks empty', () => {
    expect(faucetStatusFrom(found(componentBody({ paused: true })), found(vaultBody('0')), notFound))
      .toEqual({ kind: 'paused', claimAmount: 1_000_000_000n })
  })

  it('empty means less than one whole claim — the same test claim() makes', () => {
    expect(faucetStatusFrom(found(componentBody()), found(vaultBody('999999999')), notFound))
      .toEqual({ kind: 'empty', claimAmount: 1_000_000_000n, available: 999_999_999n })
    expect(faucetStatusFrom(found(componentBody()), found(vaultBody('1000000000')), notFound).kind).toBe('open')
  })

  it('unknown when the receipt cannot be read — it never guesses "not claimed"', () => {
    expect(faucetStatusFrom(...open, unreachable).kind).toBe('unknown')
  })

  it('unknown when the faucet or its vault cannot be read or decoded', () => {
    expect(faucetStatusFrom(unreachable, found(vaultBody('1')), notFound).kind).toBe('unknown')
    expect(faucetStatusFrom(notFound, found(vaultBody('1')), notFound).kind).toBe('unknown')
    expect(faucetStatusFrom(found({}), found(vaultBody('1')), notFound).kind).toBe('unknown')
    expect(faucetStatusFrom(found(componentBody()), unreachable, notFound).kind).toBe('unknown')
    expect(faucetStatusFrom(found(componentBody()), found({}), notFound).kind).toBe('unknown')
  })
})

describe('readFaucetStatus', () => {
  function reader(map: Record<string, PointRead>) {
    const asked: string[] = []
    const read = async (path: string) => { asked.push(path); return map[path] ?? unreachable }
    return { read, asked }
  }

  it('reads the component, the vault and this key’s receipt', async () => {
    const { read, asked } = reader({
      [`/substates/${FAUCET_COMPONENT_ADDRESS}`]: found(componentBody()),
      [`/substates/${FAUCET_VAULT_ADDRESS}`]: found(vaultBody('100000000000')),
      [`/substates/${faucetReceiptId(PK)}`]: notFound,
    })
    expect((await readFaucetStatus(WALLET, PK, read)).kind).toBe('open')
    expect(asked.sort()).toEqual([
      `/substates/${FAUCET_COMPONENT_ADDRESS}`,
      `/substates/${FAUCET_VAULT_ADDRESS}`,
      `/substates/${faucetReceiptId(PK)}`,
    ].sort())
    expect(loadFaucetClaimed(WALLET)).toBe(false)
  })

  it('records a receipt found on chain, and answers from the record afterwards without asking', async () => {
    const first = reader({ [`/substates/${faucetReceiptId(PK)}`]: found({ substate: {} }) })
    expect((await readFaucetStatus(WALLET, PK, first.read)).kind).toBe('claimed')
    expect(loadFaucetClaimed(WALLET)).toBe(true)

    const second = reader({})
    expect((await readFaucetStatus(WALLET, PK, second.read)).kind).toBe('claimed')
    expect(second.asked).toEqual([])
  })
})

describe('the claimed record', () => {
  it('is per wallet', () => {
    markFaucetClaimed(WALLET)
    expect(loadFaucetClaimed(WALLET)).toBe(true)
    expect(loadFaucetClaimed('otl_esm_1another')).toBe(false)
  })

  it('ignores an empty address', () => {
    markFaucetClaimed('')
    expect(loadFaucetClaimed('')).toBe(false)
  })

  it('survives blocked storage without throwing', () => {
    const boom = () => { throw new Error('blocked') }
    globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 } as unknown as Storage
    expect(() => markFaucetClaimed(WALLET)).not.toThrow()
    expect(loadFaucetClaimed(WALLET)).toBe(false)
  })
})
