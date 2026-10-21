// Both shapes of `GET /substates/<id>`, read as one.
//
// The 0.47 fixtures are the live shape, as both public Esmeralda indexers served it on 2026-10-21
// (`{ version, state: { up: { substate } }, verified, proof }`). Every reader in the wallet saw
// `undefined` at `body.substate` until this module existed, and showed 0 without an error, so these
// pin the one property that matters: whichever shape arrives, `substate` is where it was.

import { describe, expect, it, vi } from 'vitest'
import { TARI_RESOURCE_ADDRESS, type Provider } from '@tari-project/ootle'
import { getAccountVaultIds, substateValueOf, upgradeSubstateBody, withSubstateShape } from './substateShape'
import { isSubstateNotFound } from './substates'

const VAULT_HEX = 'ef58a6de5f8a0a3bb545f7b3f3f8a0e34dd44db37355d7b831e92afc6cca82d9'
const ACCOUNT = 'component_ef5e9d86ebc1' + '0'.repeat(52)

/** The live account component value: a resource → vault map. */
const accountValue = {
  Component: {
    header: { template_address: '0'.repeat(64), owner_rule: { ByPublicKey: '8c'.repeat(32) } },
    body: {
      state: [
        {
          '@cbor': 'map',
          entries: [[
            { '@cbor': 'tag', tag: 131, value: { '@cbor': 'bytes', hex: '01'.repeat(32) } },
            { '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex: VAULT_HEX } },
          ]],
        },
        {},
      ],
    },
  },
}
const vaultValue = {
  Vault: { resource_container: { Stealth: { address: TARI_RESOURCE_ADDRESS, revealed_amount: '995540589', locked_amount: '0' } }, freeze_flags: 0 },
}

const v046 = (substate: unknown) => ({ version: 0, substate, verified: true })
const v047 = (substate: unknown) => ({ version: 0, state: { up: { substate } }, verified: true, proof: { anchor: {} } })
const down047 = { version: 3, state: { down: {} }, verified: true, proof: { anchor: {}, down_proof: 'x' } }

describe('upgradeSubstateBody', () => {
  it('lifts a 0.47 up value to `substate`, and keeps every other field — `state` included', () => {
    const body = v047(vaultValue)
    expect(upgradeSubstateBody(body)).toEqual({ ...body, substate: vaultValue })
  })

  it('reads a 0.47 down as the absence a 404 is', () => {
    expect(upgradeSubstateBody(down047)).toBeNull()
  })

  it('passes a 0.46 body through untouched', () => {
    const body = v046(vaultValue)
    expect(upgradeSubstateBody(body)).toBe(body)
  })

  it('leaves anything that is not a substate body alone', () => {
    for (const v of [null, undefined, 42, 'x', [], { hello: 1 }, { state: 'not an object' }, { state: {} }]) {
      expect(upgradeSubstateBody(v)).toBe(v)
    }
  })
})

describe('substateValueOf', () => {
  it('is the same value from either shape', () => {
    expect(substateValueOf(v046(accountValue))).toBe(accountValue)
    expect(substateValueOf(v047(accountValue))).toBe(accountValue)
  })

  it('is undefined for a down, a non-body, or nothing', () => {
    expect(substateValueOf(down047)).toBeUndefined()
    expect(substateValueOf({ hello: 1 })).toBeUndefined()
    expect(substateValueOf(null)).toBeUndefined()
  })
})

describe('withSubstateShape — the provider the SDK 0.9 helpers read through', () => {
  it('answers getSubstate in both shapes at once', async () => {
    const inner = { getSubstate: vi.fn(async () => v047(vaultValue)) }
    const res = await withSubstateShape(inner as unknown as Provider).getSubstate('vault_x' as never) as unknown as Record<string, unknown>
    expect(res.substate).toBe(vaultValue)
    expect(res.state).toEqual({ up: { substate: vaultValue } })
  })

  it('turns a down into the not-found the indexer gives for a 404', async () => {
    const inner = { getSubstate: vi.fn(async () => down047) }
    const err = await withSubstateShape(inner as unknown as Provider).getSubstate('vault_x' as never).catch((e: unknown) => e)
    expect(isSubstateNotFound(err)).toBe(true)
  })

  it('leaves every other method working, bound to the real provider', async () => {
    class Real { secret = 7; getSubstate = async () => v046({}); peek() { return this.secret } }
    const wrapped = withSubstateShape(new Real() as unknown as Provider) as unknown as Real
    expect(wrapped.peek()).toBe(7)
  })
})

describe('getAccountVaultIds — the default resolver for every account read', () => {
  const provider = (shape: (v: unknown) => unknown) => ({
    getSubstate: vi.fn(async (id: string) => {
      if (id === ACCOUNT) return shape(accountValue)
      throw new Error(`substate not found: ${id}`)
    }),
  }) as unknown as Provider

  it('finds the account’s vault on a 0.47 indexer (the SDK 0.9 walker alone found none)', async () => {
    expect(await getAccountVaultIds(provider(v047), ACCOUNT)).toEqual([`vault_${VAULT_HEX}`])
  })

  it('and still on a 0.46 one', async () => {
    expect(await getAccountVaultIds(provider(v046), ACCOUNT)).toEqual([`vault_${VAULT_HEX}`])
  })

  it('lets a missing account throw as not-found, so callers can read it as "no account yet"', async () => {
    const err = await getAccountVaultIds(provider(v047), 'component_' + 'f'.repeat(64)).catch((e: unknown) => e)
    expect(isSubstateNotFound(err)).toBe(true)
  })
})
