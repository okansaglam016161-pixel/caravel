// Caravel Trade reads: the Board and an order parsed from the indexer's tagged-CBOR JSON (shapes copied
// from live esmeralda reads, 2026-10-15), the cancel key out of the access rules, and the legitimacy
// rule that tells a real order from a look-alike.

import { describe, expect, it } from 'vitest'
import { cancelKeyOf, makerOwed, orderLegitimacy, parseBoard, parseOrder, TradeReadError, type OrderInfo } from './tradeRead'
import { tradeFeeSplit } from './trade'
import {
  BUY, SELL, TRADE_BOARD_ADDRESS, TRADE_BOARD_BADGE, TRADE_BOARD_TEMPLATE, TRADE_CARAVEL_FEE_ACCOUNT, TRADE_BURN_WALLET,
  TRADE_ORDER_TEMPLATE, TRADE_QUOTE,
} from './tradeConfig'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'

const tag = (t: number, hex: string) => ({ '@cbor': 'tag', tag: t, value: { '@cbor': 'bytes', hex } })
const hexOf = (addr: string) => addr.split('_').pop()!
const PK = '9030e889f3a77a7de8489056f69e51c0d98331e1d8c3df60e8c60c848907e814'

function orderBody(over: { template?: string; state?: Partial<Record<number, unknown>>; cancel?: unknown } = {}) {
  const state: unknown[] = [
    0, 0,
    tag(128, hexOf(TRADE_BOARD_ADDRESS)), tag(131, hexOf(TRADE_BOARD_BADGE)), tag(131, hexOf(TRADE_QUOTE)),
    1000000, 2000000, 10000, 7000, 3000,
    tag(128, hexOf(TRADE_CARAVEL_FEE_ACCOUNT)), tag(128, hexOf(TRADE_BURN_WALLET)),
    { '@cbor': 'bytes', hex: '' }, [tag(128, 'ab'.repeat(32))],
    tag(132, '7448e0d30cfe2d36190075fe300f20f68f29de71fef91980bba30a1c9a58dc8f'),
  ]
  for (const [i, v] of Object.entries(over.state ?? {})) state[Number(i)] = v
  return {
    version: 1, verified: true,
    substate: { Component: {
      header: {
        template_address: over.template ?? TRADE_ORDER_TEMPLATE, owner_rule: 'None',
        access_rules: { method_access: {
          cancel: over.cancel ?? { Restricted: { Require: { Require: { NonFungibleAddress: { resource_address: 'resource_01' + '00'.repeat(31), id: { U256: PK } } } } } },
          fill: 'AllowAll',
        }, default: 'DenyAll' },
      },
      body: { state },
    } },
  }
}

const BOARD_BODY = {
  version: 4, verified: true,
  substate: { Component: {
    header: { template_address: TRADE_BOARD_TEMPLATE },
    body: { state: [
      { '@cbor': 'bytes', hex: TRADE_ORDER_TEMPLATE }, tag(131, hexOf(TRADE_QUOTE)), 100, 70,
      tag(128, hexOf(TRADE_CARAVEL_FEE_ACCOUNT)), tag(128, hexOf(TRADE_BURN_WALLET)), 1000000, false,
      tag(132, '2769838e526ba2c9589251e02b3e913902cab441f4361719c1ffb7fc8d29aa20'), tag(131, hexOf(TRADE_BOARD_BADGE)),
    ] },
  } },
}

describe('parseBoard', () => {
  it('reads the live Board layout', () => {
    const b = parseBoard(BOARD_BODY)
    expect(b).toMatchObject({
      version: 4, orderTemplate: TRADE_ORDER_TEMPLATE, quote: TRADE_QUOTE, feeBps: 100n, caravelPct: 70n,
      caravelAccount: TRADE_CARAVEL_FEE_ACCOUNT, burnWallet: TRADE_BURN_WALLET, minOrder: 1_000_000n, paused: false,
      badge: TRADE_BOARD_BADGE,
    })
  })
  it('refuses a component running some other template', () => {
    const fake = structuredClone(BOARD_BODY)
    fake.substate.Component.header.template_address = 'ff'.repeat(32)
    expect(() => parseBoard(fake)).toThrow(TradeReadError)
  })
})

describe('parseOrder', () => {
  it('reads the live Order layout, cancel key included', () => {
    const o = parseOrder('component_' + '11'.repeat(32), orderBody())
    expect(o).toMatchObject({
      side: SELL, status: 0, board: TRADE_BOARD_ADDRESS, badge: TRADE_BOARD_BADGE, quote: TRADE_QUOTE,
      n: 1_000_000n, p: 2_000_000n, fee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n,
      payoutStatement: null, payoutAccount: 'component_' + 'ab'.repeat(32), cancelKeyHex: PK,
    })
  })
  it('refuses a component that is not running the Order template (a look-alike)', () => {
    expect(() => parseOrder('component_x', orderBody({ template: 'ff'.repeat(32) }))).toThrow(/not a Caravel Trade order/)
  })
  it('never reads a rounded amount: unsafe JSON numbers are refused', () => {
    expect(() => parseOrder('component_x', orderBody({ state: { 5: 2 ** 60 } }))).toThrow(TradeReadError)
  })
  it('a cancel rule of another shape yields no key (so recovery cannot claim the order)', () => {
    expect(parseOrder('component_x', orderBody({ cancel: 'AllowAll' })).cancelKeyHex).toBeNull()
    expect(cancelKeyOf({})).toBeNull()
  })
})

describe('orderLegitimacy', () => {
  const board = { badge: TRADE_BOARD_BADGE }
  const real = (): OrderInfo => parseOrder('component_' + '11'.repeat(32), orderBody())
  it('accepts a real order', () => expect(orderLegitimacy(real(), board)).toBeNull())
  it('refuses another board, another badge, another quote token', () => {
    expect(orderLegitimacy({ ...real(), board: 'component_' + '22'.repeat(32) }, board)).toMatch(/not placed by/)
    expect(orderLegitimacy({ ...real(), badge: 'resource_' + '33'.repeat(32) }, board)).toMatch(/badge/)
    expect(orderLegitimacy({ ...real(), quote: 'resource_' + '44'.repeat(32) }, board)).toMatch(/Caravel Test Dollars/)
  })
  it('refuses a fee that does not add up, and a payout named twice or not at all', () => {
    expect(orderLegitimacy({ ...real(), burnCut: 2_999n }, board)).toMatch(/fee/)
    expect(orderLegitimacy({ ...real(), payoutStatement: new Uint8Array([1]) }, board)).toMatch(/exactly one way/)
    expect(orderLegitimacy({ ...real(), payoutAccount: null }, board)).toMatch(/exactly one way/)
  })
})

describe('makerOwed and the fee split — as the Order computes them', () => {
  it('a SELL owes the maker P cUSD; a BUY owes N minus the fee in tTARI', () => {
    expect(makerOwed({ side: SELL, n: 1_000_000n, p: 2_000_000n, fee: 10_000n })).toEqual({ resource: TRADE_QUOTE, amount: 2_000_000n })
    expect(makerOwed({ side: BUY, n: 1_000_000n, p: 2_000_000n, fee: 10_000n })).toEqual({ resource: TARI_RESOURCE_ADDRESS, amount: 990_000n })
  })
  it('floors at each step: matches the fee every live order stored (incl. N = 1,234,567 → 12,345 = 8,641 + 3,704)', () => {
    expect(tradeFeeSplit(1_000_000n, 100n, 70n)).toEqual({ fee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n })
    expect(tradeFeeSplit(1_500_000n, 100n, 70n)).toEqual({ fee: 15_000n, caravelCut: 10_500n, burnCut: 4_500n })
    expect(tradeFeeSplit(1_234_567n, 100n, 70n)).toEqual({ fee: 12_345n, caravelCut: 8_641n, burnCut: 3_704n })
    expect(tradeFeeSplit(99n, 100n, 70n)).toEqual({ fee: 0n, caravelCut: 0n, burnCut: 0n })
  })
})
