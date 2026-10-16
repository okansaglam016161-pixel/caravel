// The Trade page's words and numbers, held to the trade rules: the 1% fee is tTARI, whoever receives
// tTARI gets N − 1%, the seller of tTARI gets the full cUSD total, and nothing invents a network fee.

import { describe, expect, it } from 'vitest'
import { QuoteChanged } from '../../crypto/quote'
import { BUY, SELL } from '../../crypto/tradeConfig'
import {
  fillRows, fmtCusd, fmtPrice, isTaken, myOrderView, orderTotal, parsePrice, parseTari, placeRows, termsLine, timeLabel, tradeMessage, tradeRowView, usdOf,
} from './tradeModel'

const split = { fee: 10_000n }

describe('parsing', () => {
  it('tTARI and prices to six decimals, positive, nothing else', () => {
    expect(parseTari('1')).toBe(1_000_000n)
    expect(parseTari('1.5')).toBe(1_500_000n)
    expect(parseTari('0.000001')).toBe(1n)
    for (const bad of ['', '0', '1.0000001', '-1', '1e3', 'abc']) expect(parseTari(bad)).toBeNull()
    expect(parsePrice('2.2')).toBe(2_200_000n)
  })
  it('the total is N × price, exact, and says when it rounded', () => {
    expect(orderTotal(1_000_000n, 2_200_000n)).toEqual({ p: 2_200_000n, exact: true })
    expect(orderTotal(1_500_000n, 1_666_667n)).toEqual({ p: 2_500_000n, exact: false })   // 2.5000005 → 2.500000
  })
})

describe('formatting', () => {
  it('cUSD keeps two decimals, its dollar value is exact; prices flag a truncated ratio', () => {
    expect(fmtCusd(2_200_000n)).toBe('2.20')
    expect(fmtCusd(1n)).toBe('0.000001')
    expect(usdOf(10_000_000_000n)).toBe('$10,000.00')
    expect(fmtPrice({ micro: 1_666_666n, exact: false })).toBe('1.666666…')
    expect(fmtPrice({ micro: 2_200_000n, exact: true })).toBe('2.2')
  })
})

describe('placeRows / fillRows — what you give, what you get; the fee stays tTARI', () => {
  it('placing a SELL: you receive the FULL cUSD; the buyer receives N − 1% tTARI', () => {
    expect(placeRows(SELL, 1_000_000n, 2_500_000n, split).map(r => r.note ? ['note', r.v] : [r.k, r.v])).toEqual([
      ['You receive', '2.50 cUSD'],
      ['note', 'Buyer receives 0.990000 tTARI after the 1% trading fee'],
    ])
  })
  it('placing a BUY: you pay the cUSD total, receive N − 1% tTARI; one fee note', () => {
    expect(placeRows(BUY, 1_000_000n, 1_800_000n, split).map(r => r.note ? ['note', r.v] : [r.k, r.v])).toEqual([
      ['You pay', '1.80 cUSD'], ['You receive', '0.990000 tTARI'], ['note', 'Includes 1% trading fee'],
    ])
  })
  it('with no fee settings yet, no figure is invented', () => {
    expect(placeRows(SELL, 1_000_000n, 2_500_000n, null)[1].v).toBe('Buyer receives — after the 1% trading fee')
  })
  it('filling a SELL order: pay P cUSD, receive N − 1% tTARI', () => {
    expect(fillRows({ side: SELL, n: 1_000_000n, p: 2_200_000n, fee: 10_000n }).map(r => r.v)).toEqual(['2.20 cUSD', '0.990000 tTARI', 'Includes 1% trading fee'])
  })
  it('filling a BUY order: pay N tTARI, receive the FULL P cUSD — never a cUSD fee', () => {
    const rows = fillRows({ side: BUY, n: 1_000_000n, p: 1_900_000n, fee: 10_000n })
    expect(rows.map(r => r.v)).toEqual(['1.000000 tTARI', '1.90 cUSD', 'Includes 1% trading fee'])
  })
  it('an order\'s terms in one line', () => {
    expect(termsLine(1_000_000n, 2_500_000n)).toBe('1.000000 tTARI @ 2.5')
  })
})

describe('tradeMessage — plain words, no internals', () => {
  it('maps every kind of refusal to something a person can act on', () => {
    expect(tradeMessage(new Error('Could not read the trade Board verified — try again in a moment.'))).toBe('Can’t reach the network. Nothing was sent. Try again in a moment.')
    expect(tradeMessage(new Error('Failed to fetch'))).toBe('Can’t reach the network. Nothing was sent. Try again in a moment.')
    expect(tradeMessage(new Error('Not enough private cUSD: this needs 5000001, and the wallet holds 400000 spendable.'))).toBe('Insufficient balance.')
    expect(tradeMessage(new Error('This wallet has no public account to pay from.'))).toBe('Insufficient balance.')
    expect(tradeMessage(new Error('New orders are paused on the Board right now.'))).toMatch(/^New orders are paused right now/)
    expect(tradeMessage(new Error('This order was not placed by the Caravel Trade Board.'))).toBe('This order isn’t available.')
    expect(tradeMessage(new Error('weird internal thing'))).toBe('Something went wrong. Nothing was sent. Try again in a moment.')
  })
  it('never lets an internal term through', () => {
    for (const raw of ['Board', 'verified', 'SubstateNotFound', 'indexer HTTP 503', 'TemplateError']) {
      expect(tradeMessage(new Error(raw))).not.toMatch(/Board|verified|Substate|indexer|Template/)
    }
  })
})

describe('isTaken — somebody got there first, nothing charged', () => {
  it('reads the refusals that mean the order went, and nothing else', () => {
    expect(isTaken(new Error('This order is no longer open.'))).toBe(true)
    expect(isTaken(new QuoteChanged('inputs-gone'))).toBe(true)
    expect(isTaken(new Error("This order's payout output already exists, so filling it would fail. It cannot be filled."))).toBe(true)
    expect(isTaken(new QuoteChanged('fee-risen'))).toBe(false)
    expect(isTaken(new Error('Not enough private cUSD'))).toBe(false)
  })
})

describe('rows', () => {
  const now = Date.UTC(2026, 9, 15, 13, 0, 0)
  it('my orders: open shows Cancel; unconfirmed never claims a state as fact', () => {
    const base = { orderId: 'o', side: SELL as 0, n: 1_000_000n, p: 2_500_000n, fee: 10_000n, price: { micro: 2_500_000n, exact: true }, cancelIndex: 4, placedAt: null, placedEstimated: false, placedTx: null, closedAt: null, closedEstimated: false }
    expect(myOrderView({ ...base, state: 'open', confirmed: true })).toMatchObject({ status: 'Open', canCancel: true, title: 'Sell 1.000000 tTARI @ 2.5' })
    expect(myOrderView({ ...base, state: 'filled', confirmed: true })).toMatchObject({ status: 'Filled', sub: 'Filled · 2.50 cUSD received' })
    expect(myOrderView({ ...base, side: BUY, state: 'filled', confirmed: true }).sub).toBe('Filled · 0.990000 tTARI received')
    expect(myOrderView({ ...base, state: 'open', confirmed: false })).toMatchObject({ status: 'Unconfirmed', canCancel: false })
  })
  it('my orders: every order carries its time — placed, filled or cancelled; "~" only when estimated', () => {
    const base = { orderId: 'o', side: SELL as 0, n: 1_000_000n, p: 2_500_000n, fee: 10_000n, price: { micro: 2_500_000n, exact: true }, cancelIndex: 4, placedTx: null, confirmed: true }
    const today = Date.now()
    const hhmm = new Date(today).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    expect(myOrderView({ ...base, state: 'open', placedAt: today, placedEstimated: false, closedAt: null, closedEstimated: false }).sub).toBe(`Total 2.50 cUSD · placed ${hhmm}`)
    expect(myOrderView({ ...base, state: 'filled', placedAt: today, placedEstimated: false, closedAt: today, closedEstimated: false }).sub).toBe(`Filled · 2.50 cUSD received · ${hhmm}`)
    expect(myOrderView({ ...base, state: 'cancelled', placedAt: null, placedEstimated: false, closedAt: Date.UTC(2026, 9, 14, 20, 0), closedEstimated: true }).sub).toBe('Cancelled · everything returned · ~Oct 14')
  })
  it('recent trades read from the taker side, with an honest time', () => {
    const t = { orderId: 'o', txId: 't', side: SELL as 0, n: 1_000_000n, p: 2_200_000n, price: { micro: 2_200_000n, exact: true }, at: null, atEstimated: false, yours: null }
    expect(tradeRowView(t, now)).toMatchObject({ side: 'Buy', amount: '1.000000', price: '2.2', time: '—', yours: false })
    expect(timeLabel(Date.UTC(2026, 9, 14, 9, 0), true, now)).toBe('~Oct 14')
  })
})
