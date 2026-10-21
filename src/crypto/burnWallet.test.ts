// Reading the Caravel Burn Wallet: only verified, only the real one, and public vs private told
// apart from receipts. The receipt fixtures are the two real 0.1 TARI burns of 2026-10-09, trimmed
// to the fields the classifier reads.

import { describe, expect, it } from 'vitest'
import {
  BURN_WALLET_COMPONENT, BURN_WALLET_TEMPLATE, BURN_WALLET_VAULT,
  classifyBurnReceipt, isBuiltinTemplate, parseBurnComponent, parseBurnVault,
  parseDepositEvents, parseIndexerTime, parseTxCreatedAt,
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
      appTemplates: [],
    })
  })

  it('spent stealth outputs and no withdraw is a private burn', () => {
    expect(classifyBurnReceipt(privateBurn)).toEqual({ source: 'private', withdrawVaults: [], epoch: 12044, appTemplates: [] })
  })

  it('a withdraw from the burn wallet’s own vault never counts', () => {
    const odd = { receipt: { epoch: 1, events: [{ substate_id: BURN_WALLET_VAULT, topic: 'std.vault.withdraw' }], diff_summary: { downed: [] } } }
    expect(classifyBurnReceipt(odd).source).toBe('unknown')
  })

  // aadee0ae… (epoch 12313): a Caravel Trade fill paying its 0.3% — taken publicly from the same
  // account vault as the public burn above. The Order withdrew the fee from its escrow and deposited it.
  const ZERO = '0'.repeat(64)
  const ORDER = '73aae2b35810bd46f471986baf797517a00b6a45e9eef924156b2edc4ae8d6d7'
  const fillBurn = { receipt: { epoch: 12313, events: [
    { substate_id: 'vault_ef58a6de5f8a0a3bb545f7b3f3f8a0e34dd44db37355d7b831e92afc6cca82d9', topic: 'std.vault.pay_fee', template_address: ZERO },
    { substate_id: 'vault_efa2aaf45ed1b535a10b5e16949349c21545c9c39eed6b647dd5536677f36096', topic: 'std.vault.withdraw', template_address: ZERO },
    { substate_id: 'vault_a05da7d9756f39f7cfa3a6fa7836844b9b09e51ab39e4926ec2f85ba3c68f94b', topic: 'std.vault.withdraw', template_address: ORDER },
    { substate_id: BURN_WALLET_VAULT, topic: 'std.vault.deposit', template_address: BURN_WALLET_TEMPLATE },
    { substate_id: BURN_WALLET_COMPONENT, topic: 'CaravelBurnWallet.Deposit', template_address: BURN_WALLET_TEMPLATE },
    { substate_id: 'component_a0e8302e3892bc68d0cca3ee3cb3bb93292676544a79a7fd575a89e947390e49', topic: 'CaravelTradeOrder.Filled', template_address: ORDER },
  ], diff_summary: { downed: [] } } }

  it('names the contract that deposited: the Order template on a trade fill; built-ins and the burn wallet never count', () => {
    expect(classifyBurnReceipt(fillBurn).appTemplates).toEqual([ORDER])
    // A person's burn: account (built-in) and burn wallet events only.
    const direct = { receipt: { epoch: 1, events: [
      { substate_id: 'vault_x', topic: 'std.vault.withdraw', template_address: ZERO },
      { substate_id: BURN_WALLET_COMPONENT, topic: 'CaravelBurnWallet.Deposit', template_address: BURN_WALLET_TEMPLATE },
    ] } }
    expect(classifyBurnReceipt(direct).appTemplates).toEqual([])
  })

  it('built-in templates are the zero addresses with at most a low suffix', () => {
    expect(isBuiltinTemplate('0'.repeat(64))).toBe(true)
    expect(isBuiltinTemplate('0'.repeat(63) + '1')).toBe(true)
    expect(isBuiltinTemplate(ORDER)).toBe(false)
    expect(isBuiltinTemplate('1' + '0'.repeat(63))).toBe(false)
  })

  it('no receipt is unknown, not a guess', () => {
    expect(classifyBurnReceipt(null)).toEqual({ source: 'unknown', withdrawVaults: [], epoch: null, appTemplates: [] })
    expect(classifyBurnReceipt({ error: 'not found' })).toEqual({ source: 'unknown', withdrawVaults: [], epoch: null, appTemplates: [] })
  })
})

describe('times', () => {
  it('reads the indexer’s UTC timestamps', () => {
    expect(parseIndexerTime('2026-10-09 12:01:55.0')).toBe(Date.UTC(2026, 9, 9, 12, 1, 55))
    expect(parseIndexerTime(null)).toBeNull()
    expect(parseIndexerTime('yesterday')).toBeNull()
  })

  it('takes a burn’s time from created_at, never from finalized_at (the indexer’s storage time)', () => {
    // cccbb79e as indexer-a served it after the 2026-10-14 resync.
    const body = { transaction: { created_at: '2026-10-13 19:42:19.0', summary: { finalized_at: '2026-10-14 05:25:04.0' } } }
    expect(parseTxCreatedAt(body)).toBe(Date.UTC(2026, 9, 13, 19, 42, 19))
    expect(parseTxCreatedAt({ transaction: { summary: { finalized_at: '2026-10-14 05:25:04.0' } } })).toBeNull()
    expect(parseTxCreatedAt(null)).toBeNull()
    expect(parseTxCreatedAt({})).toBeNull()
  })

})

// Ootle 0.47 serves the value at `state.up.substate`, with `verified` where it was.
describe('the burn wallet parsers on a 0.47 indexer', () => {
  const as047 = ({ substate, ...rest }: { substate: unknown; [k: string]: unknown }) => ({ ...rest, state: { up: { substate } } })

  it('reads the verified component and vault from `state.up.substate`', () => {
    expect(parseBurnComponent(as047(component()))).toEqual({ vault: BURN_WALLET_VAULT, totalDeposited: 1000200000n })
    expect(parseBurnVault(as047(vault()))).toBe(1000200000n)
  })

  it('still refuses an unverified read, and a look-alike', () => {
    expect(parseBurnComponent(as047(component({ verified: false })))).toBeNull()
    expect(parseBurnComponent(as047(component({ owner: { ByPublicKey: 'ab' } })))).toBeNull()
    expect(parseBurnVault(as047(vault({ verified: false })))).toBeNull()
  })
})
