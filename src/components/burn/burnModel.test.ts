import { describe, expect, it } from 'vitest'
import type { BurnClassification } from '../../crypto/burnWallet'
import { EPOCH_MS_APPROX } from '../../crypto/burnWallet'
import {
  SUPPLY_REFERENCE, buildBurnRows, burnTimeLabel, burnTitle, compactSupply, depositsComplete, formatSupplyPercent, parseTariInput,
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
  finalizedAt: new Map(),
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
    expect(rows.map(r => [r.txId, r.source, r.byYou])).toEqual([
      ['pubMine', 'public', true],
      ['pubOther', 'public', false],
      ['privMine', 'private', true],
      ['privOther', 'private', false],
    ])
    expect(rows.map(burnTitle)).toEqual(['Burned by you', 'Public burn', 'Burned by you', 'Private burn'])
  })

  it('times: the journal first, then the indexer’s finalized_at, then an estimate from the epoch', () => {
    const rows = buildBurnRows(deposits, classes, ctx({
      journalled: new Map([['privMine', 42]]),
      finalizedAt: new Map([['pubOther', 77], ['pubMine', null]]),
    }))
    const by = Object.fromEntries(rows.map(r => [r.txId, r]))
    expect([by.privMine.at, by.privMine.exact]).toEqual([42, true])
    expect([by.pubOther.at, by.pubOther.exact]).toEqual([77, true])
    expect([by.pubMine.at, by.pubMine.exact]).toEqual([1_000_000_000_000 - 4 * EPOCH_MS_APPROX, false])
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
