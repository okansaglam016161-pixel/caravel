// Reading the Caravel Burn Wallet: only verified, only the real one, and public vs private told
// apart from receipts. The receipt fixtures are the two real 0.1 TARI burns of 2026-10-09, trimmed
// to the fields the classifier reads.

import { describe, expect, it } from 'vitest'
import {
  BURN_WALLET_COMPONENT, BURN_WALLET_TEMPLATE, BURN_WALLET_VAULT,
  classifyBurnReceipt, estimateEpochTime, EPOCH_MS_APPROX, parseBurnComponent, parseBurnVault,
  parseDepositEvents, parseIndexerTime,
} from './burnWallet'

const TARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101'
const VAULT_HEX = BURN_WALLET_VAULT.slice('vault_'.length)

function component({ verified = true, template = BURN_WALLET_TEMPLATE, owner = 'None' as unknown, vault = VAULT_HEX, total = 1000200000 as unknown } = {}) {
  return {
    verified,
    substate: {
      Component: {
        header: { template_address: template, owner_rule: owner },
        body: { state: [{ '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex: vault } }, total] },
      },
    },
  }
}

function vault({ verified = true, address = TARI, amount = '1000200000' } = {}) {
  return { verified, substate: { Vault: { resource_container: { Stealth: { address, revealed_amount: amount, locked_amount: '0' } } } } }
}

describe('parseBurnComponent', () => {
  it('reads a verified burn wallet', () => {
    expect(parseBurnComponent(component())).toEqual({ vault: BURN_WALLET_VAULT, totalDeposited: 1000200000n })
  })

  it('refuses an unverified read — it may be stale', () => {
    expect(parseBurnComponent(component({ verified: false }))).toBeNull()
  })

  it('refuses a look-alike: another template, an owner, or another vault', () => {
    expect(parseBurnComponent(component({ template: 'a'.repeat(64) }))).toBeNull()
    expect(parseBurnComponent(component({ owner: 'OwnedBySigner' }))).toBeNull()
    expect(parseBurnComponent(component({ vault: 'b'.repeat(64) }))).toBeNull()
  })

  it('accepts total_deposited as a number or a decimal string, and nothing else', () => {
    expect(parseBurnComponent(component({ total: '1000200000' }))?.totalDeposited).toBe(1000200000n)
    expect(parseBurnComponent(component({ total: -1 }))).toBeNull()
    expect(parseBurnComponent(component({ total: '12abc' }))).toBeNull()
  })
})

describe('parseBurnVault', () => {
  it('reads the revealed TARI of a verified vault', () => {
    expect(parseBurnVault(vault())).toBe(1000200000n)
  })

  it('refuses unverified reads and other resources', () => {
    expect(parseBurnVault(vault({ verified: false }))).toBeNull()
    expect(parseBurnVault(vault({ address: 'resource_' + 'f'.repeat(64) }))).toBeNull()
  })
})

describe('parseDepositEvents', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    substate_id: BURN_WALLET_COMPONENT, template_address: BURN_WALLET_TEMPLATE,
    topic: 'CaravelBurnWallet.Deposit', payload: { amount: '100000' }, ...over,
  })

  it('keeps Deposit events from the burn wallet', () => {
    expect(parseDepositEvents({ events: [['tx1', event()]] })).toEqual([{ txId: 'tx1', amount: 100000n }])
  })

  it('drops the same topic from any other component or template — the topic proves nothing', () => {
    const page = { events: [
      ['spoof1', event({ substate_id: 'component_' + 'c'.repeat(64) })],
      ['spoof2', event({ template_address: 'd'.repeat(64) })],
    ] }
    expect(parseDepositEvents(page)).toEqual([])
  })

  it('drops the component’s other events and malformed amounts', () => {
    const page = { events: [
      ['a', event({ topic: 'std.component.updated', payload: {} })],
      ['b', event({ payload: { amount: '0' } })],
      ['c', event({ payload: { amount: 'lots' } })],
      'not an entry',
    ] }
    expect(parseDepositEvents(page)).toEqual([])
  })
})

describe('classifyBurnReceipt — the two real burns', () => {
  // cad7d13f…: account.pay_fee + account.withdraw → deposit.
  const publicBurn = { receipt: { outcome: 'Commit', epoch: 12044, events: [
    { substate_id: 'vault_ef58a6de5f8a0a3bb545f7b3f3f8a0e34dd44db37355d7b831e92afc6cca82d9', topic: 'std.vault.pay_fee' },
    { substate_id: 'vault_ef58a6de5f8a0a3bb545f7b3f3f8a0e34dd44db37355d7b831e92afc6cca82d9', topic: 'std.vault.withdraw' },
    { substate_id: BURN_WALLET_VAULT, topic: 'std.vault.deposit' },
    { substate_id: BURN_WALLET_COMPONENT, topic: 'CaravelBurnWallet.Deposit' },
    { substate_id: BURN_WALLET_COMPONENT, topic: 'std.component.updated' },
  ], diff_summary: { downed: [] } } }

  // 8bbcc654…: stealth inputs → revealed bucket → deposit; one-time keys only.
  const privateBurn = { receipt: { outcome: 'Commit', epoch: 12044, events: [
    { substate_id: BURN_WALLET_VAULT, topic: 'std.vault.deposit' },
    { substate_id: BURN_WALLET_COMPONENT, topic: 'CaravelBurnWallet.Deposit' },
    { substate_id: BURN_WALLET_COMPONENT, topic: 'std.component.updated' },
  ], diff_summary: { downed: [
    { substate_id: 'utxo_0101010101010101010101010101010101010101010101010101010101010101_b00bbb11ef37150596700dd71db5a9a1500710e21ee30492b84717624ff5135a' },
  ] } } }

  it('a withdraw from an account vault is a public burn, and names that vault', () => {
    expect(classifyBurnReceipt(publicBurn)).toEqual({
      source: 'public',
      withdrawVaults: ['vault_ef58a6de5f8a0a3bb545f7b3f3f8a0e34dd44db37355d7b831e92afc6cca82d9'],
      epoch: 12044,
    })
  })

  it('spent stealth outputs and no withdraw is a private burn', () => {
    expect(classifyBurnReceipt(privateBurn)).toEqual({ source: 'private', withdrawVaults: [], epoch: 12044 })
  })

  it('a withdraw from the burn wallet’s own vault never counts', () => {
    const odd = { receipt: { epoch: 1, events: [{ substate_id: BURN_WALLET_VAULT, topic: 'std.vault.withdraw' }], diff_summary: { downed: [] } } }
    expect(classifyBurnReceipt(odd).source).toBe('unknown')
  })

  it('no receipt is unknown, not a guess', () => {
    expect(classifyBurnReceipt(null)).toEqual({ source: 'unknown', withdrawVaults: [], epoch: null })
    expect(classifyBurnReceipt({ error: 'not found' })).toEqual({ source: 'unknown', withdrawVaults: [], epoch: null })
  })
})

describe('times', () => {
  it('reads the indexer’s UTC timestamps', () => {
    expect(parseIndexerTime('2026-10-09 12:01:55.0')).toBe(Date.UTC(2026, 9, 9, 12, 1, 55))
    expect(parseIndexerTime(null)).toBeNull()
    expect(parseIndexerTime('yesterday')).toBeNull()
  })

  it('estimates from the epoch, never into the future', () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0)
    expect(estimateEpochTime(12040, 12044, now)).toBe(now - 4 * EPOCH_MS_APPROX)
    expect(estimateEpochTime(12050, 12044, now)).toBe(now)
  })
})
