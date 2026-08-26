// Tests for the error boundary translator (M4 stage 2).
//
// The strings below are the REAL ones the fund modules emit — copied from reveal.ts and conceal.ts,
// not invented — so a change to either that reintroduces base units on screen breaks a test here
// rather than shipping.

import { describe, expect, it } from 'vitest'
import { plainError } from './plainError'

describe('plainError — no base units reach the screen', () => {
  it('collapses a figure that already carries its own TARI gloss', () => {
    // reveal.ts: the MIN_REVEAL refusal.
    expect(plainError('The smallest amount that can be made public is 100000 µtTARI (0.10 TARI).'))
      .toBe('The smallest amount that can be made public is 0.10 TARI.')
  })

  it('collapses conceal.ts’s minimum the same way', () => {
    expect(plainError('The smallest amount that can be made private is 100000 µtTARI (0.10 TARI).'))
      .toBe('The smallest amount that can be made private is 0.10 TARI.')
  })

  it('converts bare base units, and the output count with them', () => {
    // reveal.ts: selectStealthInputs, insufficient funds.
    expect(plainError('Not enough private funds. This reveal needs 5000000 µtTARI (amount + network fee), and the wallet holds 3000000 µtTARI across 2 output(s).'))
      .toBe('Not enough private funds. This reveal needs 5 TARI (amount + network fee), and the wallet holds 3 TARI across 2 payments.')
  })

  it('handles the singular payment case', () => {
    expect(plainError('the wallet holds 3000000 µtTARI across 1 output(s).'))
      .toBe('the wallet holds 3 TARI across 1 payment.')
  })

  it('converts every figure in a multi-figure message', () => {
    // reveal.ts: planReveal's coverage refusal.
    expect(plainError('The selected private funds (2971007 µtTARI) do not cover the amount plus the network fee (1000000 + 14537 = 1014537 µtTARI).'))
      .toBe('The selected private funds (2.971007 TARI) do not cover the amount plus the network fee (1000000 + 14537 = 1.014537 TARI).')
  })

  it('rewrites the fragmentation refusal without the UTXO vocabulary', () => {
    const out = plainError('Your private balance is spread across too many small outputs to reveal 5000000 µtTARI in one transaction (it would need 9, and the limit is 8). Reveal a smaller amount, or send yourself a payment first to consolidate.')
    expect(out).toContain('split across too many small payments')
    expect(out).toContain('5 TARI')
    expect(out).not.toMatch(/µtTARI|output/)
  })

  it('converts the fee-exceeds-reserve refusal', () => {
    expect(plainError('The network fee (60000 µtTARI) is higher than this reveal reserved for it.'))
      .toBe('The network fee (0.06 TARI) is higher than this reveal reserved for it.')
  })

  it('handles underscored literals, in case a message ever formats them that way', () => {
    expect(plainError('needs 1_014_537 µtTARI')).toBe('needs 1.014537 TARI')
  })

  it.each([
    ['a network rejection, verbatim', 'The network rejected this transaction in simulation: FailedToExecuteInstruction { instruction: 4 }'],
    ['a bare connection failure', 'Could not estimate the network fee: the indexer did not respond within 20s.'],
    ['an account problem', 'This wallet’s account could not be identified, so funds cannot be made public. Check your connection and try again.'],
  ])('passes through untouched: %s', (_label, msg) => {
    // A translator that mangled what it did not understand would be worse than none — the network's
    // own words are the most useful thing we are ever told about a failed transaction.
    expect(plainError(msg)).toBe(msg)
  })

  it('leaves an empty message alone', () => {
    expect(plainError('')).toBe('')
  })

  it('NO µtTARI SURVIVES any message the fund modules can emit', () => {
    const all = [
      'The smallest amount that can be made public is 100000 µtTARI (0.10 TARI).',
      'Not enough private funds. This reveal needs 5000000 µtTARI (amount + network fee), and the wallet holds 3000000 µtTARI across 2 output(s).',
      'The selected private funds (2971007 µtTARI) do not cover the amount plus the network fee (1000000 + 14537 = 1014537 µtTARI).',
      'The network fee (60000 µtTARI) exceeds the amount being made private. Try a larger amount.',
      'Revealing 1000000 µtTARI would need 1014537 µtTARI of private funds, and the selected outputs hold 999000.',
    ]
    for (const m of all) expect(plainError(m)).not.toMatch(/µtTARI/)
  })
})
