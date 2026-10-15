// The Trade page's words and numbers, held to the trade rules: the 1% fee is tTARI, whoever receives
// tTARI gets N − 1%, the seller of tTARI gets the full cUSD total, and nothing invents a network fee.

import { describe, expect, it } from 'vitest'
import { QuoteChanged } from '../../crypto/quote'
import { BUY, SELL } from '../../crypto/tradeConfig'
import {
  fillRows, fmtCusd, fmtPrice, isTaken, myOrderView, orderTotal, parsePrice, parseTari, placeRows, timeLabel, tradeRowView, usdOf,
} from './tradeModel'

const split = { fee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n }

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

describe('placeRows / fillRows — the fee is tTARI, N − 1% to whoever receives tTARI, full cUSD to the seller', () => {
  it('placing a SELL: you get the full cUSD, the buyer gets N − 1% tTARI, the fee is tTARI', () => {
    const rows = placeRows(SELL, 1_000_000n, 2_500_000n, split)
    expect(rows.map(r => [r.k, r.v])).toEqual([
      ['You receive', '2.50 cUSD'],
      ['Buyer receives', '0.990000 tTARI'],
      ['1% trade fee', '0.010000 tTARI · 0.007000 Caravel, 0.003000 burned'],
    ])
  })
  it('placing a BUY: you pay the cUSD total and receive N − 1% tTARI', () => {
    expect(placeRows(BUY, 1_000_000n, 1_800_000n, split).map(r => r.v)).toEqual(['1.80 cUSD', '0.990000 tTARI', '0.010000 tTARI · 0.007000 Caravel, 0.003000 burned'])
  })
  it('with no Board settings yet, no fee figure is invented', () => {
    expect(placeRows(SELL, 1_000_000n, 2_500_000n, null).slice(1).map(r => r.v)).toEqual(['—', '—'])
  })
  it('filling a SELL order: pay P cUSD, receive N − 1% tTARI', () => {
    expect(fillRows({ side: SELL, n: 1_000_000n, p: 2_200_000n, ...split }).map(r => [r.k, r.v])).toEqual([
      ['You pay', '2.20 cUSD'], ['Trade fee 1%', '0.010000 tTARI · 0.007000 Caravel, 0.003000 burned'], ['You receive', '0.990000 tTARI'],
    ])
  })
  it('filling a BUY order: pay N tTARI (the fee comes out of it), receive the FULL P cUSD', () => {
    const rows = fillRows({ side: BUY, n: 1_000_000n, p: 1_900_000n, ...split })
    expect(rows[0].v).toBe('1.000000 tTARI')
    expect(rows[1].v).toMatch(/^0\.010000 tTARI · .* the buyer receives 0\.990000 tTARI$/)
    expect(rows[2].v).toBe('1.90 cUSD')
    expect(rows.some(r => /cUSD/.test(r.v) && /fee/i.test(r.k))).toBe(false)   // never a cUSD fee
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
    const base = { orderId: 'o', side: SELL as 0, n: 1_000_000n, p: 2_500_000n, fee: 10_000n, price: { micro: 2_500_000n, exact: true }, cancelIndex: 4, placedAt: null }
    expect(myOrderView({ ...base, state: 'open', confirmed: true })).toMatchObject({ status: 'Open', canCancel: true, title: 'Sell 1.000000 tTARI @ 2.5' })
    expect(myOrderView({ ...base, state: 'filled', confirmed: true })).toMatchObject({ status: 'Filled', sub: 'Filled · 2.50 cUSD received' })
    expect(myOrderView({ ...base, side: BUY, state: 'filled', confirmed: true }).sub).toBe('Filled · 0.990000 tTARI received')
    expect(myOrderView({ ...base, state: 'open', confirmed: false })).toMatchObject({ status: 'Unconfirmed', canCancel: false })
  })
  it('recent trades read from the taker side, with an honest time', () => {
    const t = { orderId: 'o', txId: 't', side: SELL as 0, n: 1_000_000n, p: 2_200_000n, price: { micro: 2_200_000n, exact: true }, at: null, atEstimated: false, yours: null }
    expect(tradeRowView(t, now)).toMatchObject({ side: 'Buy', amount: '1.000000', price: '2.2', time: '—', yours: false })
    expect(timeLabel(Date.UTC(2026, 9, 14, 9, 0), true, now)).toBe('~Oct 14')
  })
})
