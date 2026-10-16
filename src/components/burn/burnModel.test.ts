import { describe, expect, it } from 'vitest'
import type { BurnClassification } from '../../crypto/burnWallet'
import { TRADE_BOARD_TEMPLATE, TRADE_ORDER_TEMPLATE } from '../../crypto/tradeConfig'
import { estimateFromEpoch, type TxTime } from '../../crypto/txTimes'
import { timeLabel } from '../wallet/v2/format'
import {
  SUPPLY_REFERENCE, buildBurnRows, burnDetail, burnSettled, burnTitle, compactSupply, depositsComplete, formatSupplyPercent, parseTariInput,
  type RowContext,
} from './burnModel'
import { KNOWN_BURN_APPS, burnAppOf } from './burnApps'

describe('parseTariInput — exact, no float', () => {
  it('parses whole and fractional TARI to µtTARI exactly', () => {
    expect(parseTariInput('1')).toBe(1_000_000n)
    expect(parseTariInput('0.1')).toBe(100_000n)
    expect(parseTariInput('12.345678')).toBe(12_345_678n)
    expect(parseTariInput(' 3. ')).toBe(3_000_000n)
    // A float would land this a microtari off.
    expect(parseTariInput('9007199254.740993')).toBe(9_007_199_254_740_993n)
  })

  it('refuses zero, more than six places, and anything that is not a plain decimal', () => {
    for (const bad of ['', '0', '0.000000', '1.1234567', '-1', '1e3', '1,000', 'abc', '.5']) {
      expect(parseTariInput(bad)).toBeNull()
    }
  })
})

const cls = (source: BurnClassification['source'], withdrawVaults: string[] = [], epoch: number | null = 100, appTemplates: string[] = []): BurnClassification =>
  ({ source, withdrawVaults, epoch, appTemplates })

const exact = (at: number): TxTime => ({ at, estimated: false })

const ctx = (over: Partial<RowContext> = {}): RowContext => ({
  ownVaults: new Set(['vault_mine']),
  journalled: new Set(),
  times: new Map(),
  ...over,
})

const OTHER_APP = 'ab'.repeat(32)

describe('buildBurnRows — who burned', () => {
  const deposits = [
    { txId: 'pubMine', amount: 1n },
    { txId: 'pubOther', amount: 2n },
    { txId: 'privMine', amount: 3n },
    { txId: 'privOther', amount: 4n },
  ]
  const classes = new Map([
    ['pubMine', cls('public', ['vault_mine'])],
    ['pubOther', cls('public', ['vault_theirs'])],
    ['privMine', cls('private')],
    ['privOther', cls('private')],
  ])

  it('a person: "Burn"; this wallet: "Burned by you" — public from your account, private only when journalled here', () => {
    const rows = buildBurnRows(deposits, classes, ctx({ journalled: new Set(['privMine']) }))
    const by = Object.fromEntries(rows.map(r => [r.txId, r]))
    expect(['pubMine', 'pubOther', 'privMine', 'privOther'].map(t => [by[t].byYou, burnTitle(by[t]), burnDetail(by[t])])).toEqual([
      [true, 'Burned by you', 'Public'],
      [false, 'Burn', 'Public'],
      [true, 'Burned by you', 'Private'],
      [false, 'Burn', 'Private'],
    ])
  })

  it('a Caravel Trade fill: "Caravel Trade burn · Trading fee" — NEVER yours, even when your account paid in it', () => {
    // A fill this wallet took publicly: its own account vault withdrew in the same transaction.
    const fill = cls('public', ['vault_order_escrow', 'vault_mine'], 100, [TRADE_ORDER_TEMPLATE])
    const [row] = buildBurnRows([{ txId: 'fill', amount: 3_000n }], new Map([['fill', fill]]), ctx({ journalled: new Set(['fill']) }))
    expect([row.byYou, burnTitle(row), burnDetail(row)]).toEqual([false, 'Caravel Trade burn', 'Trading fee'])
  })

  it('any other contract: "App burn · Unknown app"', () => {
    const [row] = buildBurnRows([{ txId: 'x', amount: 1n }], new Map([['x', cls('public', ['vault_mine'], 1, [OTHER_APP])]]), ctx())
    expect([row.byYou, burnTitle(row), burnDetail(row)]).toEqual([false, 'App burn', 'Unknown app'])
  })

  it('an unreadable receipt is a plain "Burn" with no detail, never a guess', () => {
    const [row] = buildBurnRows([{ txId: 'x', amount: 1n }], new Map(), ctx())
    expect(row.source).toBe('unknown')
    expect([burnTitle(row), burnDetail(row)]).toEqual(['Burn', null])
    expect(row.at).toBeNull()
  })
})

describe('burnAppOf — the known apps list', () => {
  it('names Caravel Trade by its Order or Board template; a known app wins over an unknown one beside it', () => {
    expect(burnAppOf([TRADE_ORDER_TEMPLATE])?.name).toBe('Caravel Trade burn')
    expect(burnAppOf([TRADE_BOARD_TEMPLATE])?.name).toBe('Caravel Trade burn')
    expect(burnAppOf([OTHER_APP, TRADE_ORDER_TEMPLATE].sort())?.name).toBe('Caravel Trade burn')
    expect(burnAppOf([OTHER_APP])?.name).toBe('App burn')
    expect(burnAppOf([])).toBeNull()
    expect(KNOWN_BURN_APPS.size).toBe(2)
  })
})

describe('buildBurnRows — times (the Trade page rule)', () => {
  it('takes crypto/txTimes as it is: exact, or estimated and marked; never this device’s journal', () => {
    const rows = buildBurnRows(
      [{ txId: 'a', amount: 1n }, { txId: 'b', amount: 1n }],
      new Map(),
      ctx({ journalled: new Set(['a']), times: new Map([['a', exact(77)], ['b', { at: estimateFromEpoch(12300), estimated: true }]]) }),
    )
    const by = Object.fromEntries(rows.map(r => [r.txId, r]))
    expect([by.a.at, by.a.estimated]).toEqual([77, false])
    expect([by.b.at, by.b.estimated]).toEqual([estimateFromEpoch(12300), true])
  })

  it('labels like Trade: HH:MM today, a date before, "~" only when estimated', () => {
    const now = new Date(2026, 9, 16, 15, 0).getTime()
    expect(timeLabel(new Date(2026, 9, 16, 14, 32).getTime(), false, now)).toBe('14:32')
    expect(timeLabel(new Date(2026, 9, 14, 9, 5).getTime(), false, now)).toBe('Oct 14')
    expect(timeLabel(new Date(2026, 9, 14, 9, 5).getTime(), true, now)).toBe('~Oct 14')
    expect(timeLabel(null, false, now)).toBe('—')
  })

  it('sorts newest first by that time, whatever order the indexer listed them in', () => {
    // The 2026-10-14 resync: the indexer listed cccbb79e (19:42) above 64d022bb (20:35).
    const t = (h: number, m: number) => Date.UTC(2026, 9, 13, h, m)
    const rows = buildBurnRows(
      [
        { txId: 'cccbb79e', amount: 1n },
        { txId: '64d022bb', amount: 2n },
        { txId: 'old', amount: 3n },
        { txId: '5d8eceb8', amount: 4n },
      ],
      new Map(),
      ctx({ times: new Map([
        ['cccbb79e', exact(t(19, 42))], ['64d022bb', exact(t(20, 35))], ['5d8eceb8', exact(t(19, 34))],
        ['old', { at: t(15, 4), estimated: true }],
      ]) }),
    )
    expect(rows.map(r => r.txId)).toEqual(['64d022bb', 'cccbb79e', '5d8eceb8', 'old'])
  })

  it('breaks ties by transaction id, puts rows with no time last, and keeps one transaction’s deposits in order', () => {
    const times = new Map([['a', exact(10)], ['b', exact(10)]])
    const rows = buildBurnRows(
      [
        { txId: 'none2', amount: 1n },
        { txId: 'b', amount: 2n },
        { txId: 'none1', amount: 3n },
        { txId: 'a', amount: 4n },
        { txId: 'b', amount: 5n },
      ],
      new Map(),
      ctx({ times }),
    )
    expect(rows.map(r => [r.txId, r.amount])).toEqual([['a', 4n], ['b', 2n], ['b', 5n], ['none1', 3n], ['none2', 1n]])
    // And the same answer from any input order.
    const again = buildBurnRows([...rows].reverse().map(r => ({ txId: r.txId, amount: r.amount })), new Map(), ctx({ times }))
    expect(again.map(r => r.txId)).toEqual(['a', 'b', 'b', 'none1', 'none2'])
  })
})

describe('depositsComplete', () => {
  it('is complete only when the list adds up to the verified total exactly', () => {
    const d = [{ txId: 'a', amount: 1_000_000_000n }, { txId: 'b', amount: 100_000n }]
    expect(depositsComplete(d, 1_000_100_000n)).toBe(true)
    expect(depositsComplete(d, 1_000_200_000n)).toBe(false)
    expect(depositsComplete(d, null)).toBe(false)
  })
})

describe('formatSupplyPercent — share of the 21B reference, two significant figures', () => {
  const TARI = 1_000_000n
  it('the live total today: 1,000.2 tTARI is 0.0000048%', () => {
    expect(formatSupplyPercent(1_000_200_000n)).toBe('0.0000048')
  })

  it('never reads as zero, however small, and never in scientific notation', () => {
    expect(formatSupplyPercent(1n)).toBe('0.0000000000000048')   // 1 µtTARI
    expect(formatSupplyPercent(100_000n)).toBe('0.00000000048')     // 0.1 TARI
    expect(formatSupplyPercent(0n)).toBe('0')
  })

  it('rounds half-up to two significant figures and trims trailing zeros', () => {
    expect(formatSupplyPercent(21_000_000n * TARI)).toBe('0.1')        // exactly 0.10
    expect(formatSupplyPercent(98_700_000n * TARI)).toBe('0.47')       // 0.47
    expect(formatSupplyPercent(209_895_000n * TARI)).toBe('1')         // 0.9995 → 1.0
    expect(formatSupplyPercent(2_583_000_000n * TARI)).toBe('12')      // 12.3
    expect(formatSupplyPercent(SUPPLY_REFERENCE * TARI)).toBe('100')
  })

  it('names the reference short', () => {
    expect(compactSupply()).toBe('21B')
    expect(compactSupply(1_500_000n)).toBe('1.5M')
  })
})

describe('one transaction depositing twice', () => {
  it('gives two rows with distinct keys', () => {
    const rows = buildBurnRows([{ txId: 'tx', amount: 2n }, { txId: 'tx', amount: 3n }], new Map(), ctx())
    expect(rows.map(r => r.amount)).toEqual([2n, 3n])
    expect(new Set(rows.map(r => r.key)).size).toBe(2)
  })
})

describe('untrusted, enormous figures', () => {
  it('formatSupplyPercent never falls into scientific notation, however large', () => {
    const huge = formatSupplyPercent(10n ** 40n)
    expect(huge).not.toMatch(/e/i)
    expect(huge).toMatch(/^[\d,]+$/)
  })
})

describe('burnSettled — a fresh burn is watched until its row is classified', () => {
  const row = (source: 'public' | 'private' | 'unknown') =>
    buildBurnRows([{ txId: 'mine', amount: 100_000n }], new Map([['mine', cls(source, [], 1)]]), ctx())

  it('the total including it is not enough while its receipt is still unread', () => {
    expect(burnSettled(1_100_000n, 1_000_000n, 100_000n, row('unknown'), 'mine')).toBe(false)
  })

  it('settled once the total includes it and its row is classified', () => {
    expect(burnSettled(1_100_000n, 1_000_000n, 100_000n, row('public'), 'mine')).toBe(true)
    expect(burnSettled(1_100_000n, 1_000_000n, 100_000n, row('private'), 'mine')).toBe(true)
  })

  it('not settled before the total includes it, without a list, or without its row', () => {
    expect(burnSettled(1_050_000n, 1_000_000n, 100_000n, row('public'), 'mine')).toBe(false)
    expect(burnSettled(1_100_000n, 1_000_000n, 100_000n, null, 'mine')).toBe(false)
    expect(burnSettled(1_100_000n, 1_000_000n, 100_000n, row('public'), 'other')).toBe(false)
    expect(burnSettled(null, 1_000_000n, 100_000n, row('public'), 'mine')).toBe(false)
  })
})
