// Tests for the combined-balance rules (M7).
//
// The arithmetic here is trivial — one addition. Everything worth testing is the REFUSAL to do that
// addition: the two ways a balance can be untrustworthy without the sum knowing, and the difference
// between "a number is coming" and "we can't read this".

import { describe, expect, it } from 'vitest'
import { computeTotal, unreadableReasonText, type BalanceStatus, type TotalInputs } from './total'

const ready = (v: bigint): BalanceStatus => ({ status: 'ready', microtari: v })
const LOADING: BalanceStatus = { status: 'loading' }
const OUT: BalanceStatus = { status: 'unavailable' }

const inputs = (over: Partial<TotalInputs> = {}): TotalInputs => ({
  privateBalance: ready(348_862_232n),
  privateIncomplete: false,
  publicBalance: ready(700_997_686n),
  settling: false,
  ...over,
})

// ── The sum ───────────────────────────────────────────────────────────────────

describe('the sum', () => {
  it('adds the two sides — the real seeded-wallet figures', () => {
    expect(computeTotal(inputs())).toEqual({ status: 'ready', microtari: 1_049_859_918n })
  })

  it('is BIGINT — exact past Number.MAX_SAFE_INTEGER', () => {
    // A total computed through Number would drift here; these two sum past 2^53.
    const t = computeTotal(inputs({
      privateBalance: ready(9_007_199_254_740_993n),
      publicBalance: ready(9_007_199_254_740_993n),
    }))
    expect(t).toEqual({ status: 'ready', microtari: 18_014_398_509_481_986n })
    // Why bigint matters: round-tripping that exact total through Number loses it. (Written as a
    // round-trip rather than a literal comparison — a decimal literal this large is ALREADY
    // rounded by the parser, so comparing two literals proves nothing.)
    const exact = 18_014_398_509_481_986n
    expect(BigInt(Number(exact))).not.toBe(exact)
    expect(BigInt(Number(exact))).toBe(18_014_398_509_481_984n)
  })

  it('handles either side at zero', () => {
    expect(computeTotal(inputs({ publicBalance: ready(0n) })).status).toBe('ready')
    expect(computeTotal(inputs({ privateBalance: ready(0n), publicBalance: ready(5n) })))
      .toEqual({ status: 'ready', microtari: 5n })
  })

  it('a wallet with nothing totals zero, confidently', () => {
    expect(computeTotal(inputs({ privateBalance: ready(0n), publicBalance: ready(0n) })))
      .toEqual({ status: 'ready', microtari: 0n })
  })

  it('is commutative and exact across many pairs', () => {
    for (const a of [0n, 1n, 985_544n, 700_997_686n, 2n ** 63n]) {
      for (const b of [0n, 7n, 348_862_232n, 2n ** 62n]) {
        const t = computeTotal(inputs({ privateBalance: ready(a), publicBalance: ready(b) }))
        expect(t).toEqual({ status: 'ready', microtari: a + b })
      }
    }
  })
})

// ── The refusals — the whole point of the file ───────────────────────────────

describe('unreadable — never a confident wrong number', () => {
  it('public unavailable → “—”, naming the public side', () => {
    expect(computeTotal(inputs({ publicBalance: OUT })))
      .toEqual({ status: 'unreadable', reason: 'public-unavailable' })
  })

  it('private unavailable → “—”, naming the private side', () => {
    expect(computeTotal(inputs({ privateBalance: OUT })))
      .toEqual({ status: 'unreadable', reason: 'private-unavailable' })
  })

  it('both unavailable → “—”, naming both', () => {
    expect(computeTotal(inputs({ privateBalance: OUT, publicBalance: OUT })))
      .toEqual({ status: 'unreadable', reason: 'both-unavailable' })
  })

  it('AN INCOMPLETE SCAN IS UNREADABLE, not a caveated number', () => {
    // The scanner hit the indexer's page cap, so the private figure is a LOWER BOUND. Summing it
    // yields a total that is plausible, specific and too small — the confident-wrong-number case
    // in its purest form.
    const t = computeTotal(inputs({ privateIncomplete: true }))
    expect(t).toEqual({ status: 'unreadable', reason: 'private-incomplete' })
    expect(t).not.toHaveProperty('microtari')
  })

  it('an incomplete flag on a scan that has not produced a figure does not fire', () => {
    // Nothing has been claimed yet, complete or otherwise — that is plain loading.
    expect(computeTotal(inputs({ privateBalance: LOADING, privateIncomplete: true })).status).toBe('loading')
  })

  it('NEVER returns a microtari value in any unreadable case', () => {
    for (const over of [
      { publicBalance: OUT }, { privateBalance: OUT },
      { privateBalance: OUT, publicBalance: OUT }, { privateIncomplete: true },
    ]) {
      expect(computeTotal(inputs(over))).not.toHaveProperty('microtari')
    }
  })
})

// ── “updating…” vs “—” — two different claims ────────────────────────────────

describe('settling vs unreadable — the distinction that must not blur', () => {
  it('settling with both sides readable keeps the number, marked in flight', () => {
    expect(computeTotal(inputs({ settling: true })))
      .toEqual({ status: 'settling', microtari: 1_049_859_918n })
  })

  it('settling mid-rescan has no number yet — the ordinary case', () => {
    // A settle triggers rescan(), so both reads go back to loading while it runs.
    expect(computeTotal(inputs({ settling: true, privateBalance: LOADING, publicBalance: LOADING })))
      .toEqual({ status: 'settling', microtari: null })
  })

  it('UNREADABLE OUTRANKS SETTLING — a failure is not “work in progress”', () => {
    // Showing "updating…" over a side we cannot read promises a number that is never coming.
    expect(computeTotal(inputs({ settling: true, publicBalance: OUT })))
      .toEqual({ status: 'unreadable', reason: 'public-unavailable' })
    expect(computeTotal(inputs({ settling: true, privateIncomplete: true })))
      .toEqual({ status: 'unreadable', reason: 'private-incomplete' })
  })

  it('settling outranks loading — something IS happening', () => {
    expect(computeTotal(inputs({ settling: true, privateBalance: LOADING })).status).toBe('settling')
    expect(computeTotal(inputs({ settling: false, privateBalance: LOADING })).status).toBe('loading')
  })
})

describe('loading', () => {
  it.each([
    ['private still reading', { privateBalance: LOADING }],
    ['public still reading', { publicBalance: LOADING }],
    ['both still reading', { privateBalance: LOADING, publicBalance: LOADING }],
  ])('%s → loading, not a partial sum', (_label, over) => {
    const t = computeTotal(inputs(over))
    expect(t).toEqual({ status: 'loading' })
    // Half a total is not a total.
    expect(t).not.toHaveProperty('microtari')
  })
})

// ── The copy ─────────────────────────────────────────────────────────────────

describe('unreadableReasonText', () => {
  it.each([
    ['public-unavailable', /public balance couldn’t be read/],
    ['private-unavailable', /private balance couldn’t be read/],
    ['both-unavailable', /Neither balance could be read/],
    ['private-incomplete', /a total would be too low/],
  ] as const)('%s explains which side and what to do', (reason, matcher) => {
    expect(unreadableReasonText(reason)).toMatch(matcher)
  })

  it('never leaves the user with a dash and no next step', () => {
    for (const r of ['public-unavailable', 'private-unavailable', 'both-unavailable', 'private-incomplete'] as const) {
      const text = unreadableReasonText(r)
      expect(text.length).toBeGreaterThan(40)
      expect(text).toMatch(/[.!]$/)
    }
  })

  it('says nothing about base units or outputs', () => {
    for (const r of ['public-unavailable', 'private-unavailable', 'both-unavailable', 'private-incomplete'] as const) {
      expect(unreadableReasonText(r)).not.toMatch(/µtTARI|UTXO|output|indexer|substate/i)
    }
  })
})
