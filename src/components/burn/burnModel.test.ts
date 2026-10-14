import { describe, expect, it } from 'vitest'
import type { BurnClassification } from '../../crypto/burnWallet'
import { EPOCH_MS_APPROX } from '../../crypto/burnWallet'
import {
  SUPPLY_REFERENCE, buildBurnRows, burnSettled, burnTimeLabel, burnTitle, compactSupply, depositsComplete, formatSupplyPercent, parseTariInput,
  type RowContext,
} from './burnModel'

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

const cls = (source: BurnClassification['source'], withdrawVaults: string[] = [], epoch: number | null = 100): BurnClassification =>
  ({ source, withdrawVaults, epoch })

const ctx = (over: Partial<RowContext> = {}): RowContext => ({
  ownVaults: new Set(['vault_mine']),
  journalled: new Map(),
  createdAt: new Map(),
  currentEpoch: 104,
  now: 1_000_000_000_000,
  ...over,
})

describe('buildBurnRows', () => {
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

  it('a public burn is yours when it came from your account’s vault; a private one only when journalled here', () => {
    const rows = buildBurnRows(deposits, classes, ctx({ journalled: new Map([['privMine', 5]]) }))
    const by = Object.fromEntries(rows.map(r => [r.txId, r]))
    expect(['pubMine', 'pubOther', 'privMine', 'privOther'].map(t => [by[t].source, by[t].byYou, burnTitle(by[t])])).toEqual([
      ['public', true, 'Burned by you'],
      ['public', false, 'Public burn'],
      ['private', true, 'Burned by you'],
      ['private', false, 'Private burn'],
    ])
  })

  it('times: the journal first, then the transaction’s created_at, then an estimate from the epoch', () => {
    const rows = buildBurnRows(deposits, classes, ctx({
      journalled: new Map([['privMine', 42]]),
      createdAt: new Map([['pubOther', 77], ['pubMine', null], ['privMine', 99]]),
    }))
    const by = Object.fromEntries(rows.map(r => [r.txId, r]))
    expect([by.privMine.at, by.privMine.exact]).toEqual([42, true])
    expect([by.pubOther.at, by.pubOther.exact]).toEqual([77, true])
    expect([by.pubMine.at, by.pubMine.exact]).toEqual([1_000_000_000_000 - 4 * EPOCH_MS_APPROX, false])
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
        { txId: 'mine', amount: 5n },
      ],
      new Map([['old', cls('private', [], 90)]]),
      ctx({
        now: t(23, 0),
        currentEpoch: 104,
        journalled: new Map([['mine', t(21, 0)]]),
        createdAt: new Map([['cccbb79e', t(19, 42)], ['64d022bb', t(20, 35)], ['5d8eceb8', t(19, 34)], ['mine', t(5, 0)]]),
      }),
    )
    // The journal's 21:00 beats the indexer's 05:00 for this device's own burn; the epoch estimate
    // (14 epochs back, about 15:04) sorts among the exact times.
    expect(rows.map(r => r.txId)).toEqual(['mine', '64d022bb', 'cccbb79e', '5d8eceb8', 'old'])
  })

  it('breaks ties by transaction id, puts rows with no time last, and keeps one transaction’s deposits in order', () => {
    const rows = buildBurnRows(
      [
        { txId: 'none2', amount: 1n },
        { txId: 'b', amount: 2n },
        { txId: 'none1', amount: 3n },
        { txId: 'a', amount: 4n },
        { txId: 'b', amount: 5n },
      ],
      new Map(),
      ctx({ createdAt: new Map([['a', 10], ['b', 10]]) }),
    )
    expect(rows.map(r => [r.txId, r.amount])).toEqual([['a', 4n], ['b', 2n], ['b', 5n], ['none1', 3n], ['none2', 1n]])
    // And the same answer from any input order.
    const again = buildBurnRows([...rows].reverse().map(r => ({ txId: r.txId, amount: r.amount })), new Map(), ctx({ createdAt: new Map([['a', 10], ['b', 10]]) }))
    expect(again.map(r => r.txId)).toEqual(['a', 'b', 'b', 'none1', 'none2'])
  })

  it('an unreadable receipt is a plain "Burn", never a guess', () => {
    const [row] = buildBurnRows([{ txId: 'x', amount: 1n }], new Map(), ctx())
    expect(row.source).toBe('unknown')
    expect(burnTitle(row)).toBe('Burn')
    expect(row.at).toBeNull()
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

describe('burnTimeLabel', () => {
  const now = new Date(2026, 9, 9, 15, 0).getTime()
  it('says when, like the rest of the app', () => {
    expect(burnTimeLabel(new Date(2026, 9, 9, 14, 32).getTime(), true, now)).toBe('Today 14:32')
    expect(burnTimeLabel(new Date(2026, 9, 8, 9, 5).getTime(), true, now)).toBe('Yesterday 09:05')
  })

  it('an estimate says so, and carries no time of day', () => {
    expect(burnTimeLabel(now - 5 * 3_600_000, false, now)).toBe('About 5 hours ago')
    expect(burnTimeLabel(now - 3 * 86_400_000, false, now)).toBe('About 3 days ago')
    expect(burnTimeLabel(null, false, now)).toBe('Time unknown')
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
    buildBurnRows([{ txId: 'mine', amount: 100_000n }], new Map([['mine', { source, withdrawVaults: [], epoch: 1 }]]), ctx())

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
