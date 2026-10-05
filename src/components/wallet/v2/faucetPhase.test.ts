// When the faucet offers a claim, and when it says nothing.
//
// What these pin: the CLAIM STATUS read from the chain decides, never the balance (there is no
// balance input any more); a status nobody has read renders nothing; and a claim in flight is never
// hidden by the status changing underneath it.

import { describe, expect, it } from 'vitest'
import { faucetAddedMessage, faucetPhase, isHidden, type FaucetPhaseInputs } from './faucetPhase'

/** A resting, unlocked wallet whose faucet is open. Specs override the one field they are about. */
const at = (over: Partial<FaucetPhaseInputs> = {}): FaucetPhaseInputs => ({
  claim: 'idle', status: 'open', unlocked: true, ...over,
})

describe('what the claim status says', () => {
  it('offers a claim only when the faucet is open and this wallet has not claimed', () => {
    expect(faucetPhase(at())).toBe('open')
    expect(isHidden('open')).toBe(false)
  })

  it('a claimed wallet never sees the faucet again', () => {
    expect(faucetPhase(at({ status: 'claimed' }))).toBe('claimed')
    expect(isHidden('claimed')).toBe(true)
  })

  it('a never-claimed wallet is told when the faucet is paused or empty', () => {
    expect(faucetPhase(at({ status: 'paused' }))).toBe('paused')
    expect(faucetPhase(at({ status: 'empty' }))).toBe('empty')
    expect(isHidden('paused')).toBe(false)
    expect(isHidden('empty')).toBe(false)
  })

  it('says NOTHING before the status is read, or when it could not be', () => {
    expect(faucetPhase(at({ status: null }))).toBe('unknown')
    expect(faucetPhase(at({ status: 'unknown' }))).toBe('unknown')
    expect(isHidden('unknown')).toBe(true)
  })
})

describe('locked', () => {
  it('offers nothing without an identity, whatever the faucet says', () => {
    for (const status of ['open', 'paused', 'empty', 'claimed', 'unknown', null] as const) {
      expect(faucetPhase(at({ unlocked: false, status }))).toBe('locked')
    }
    expect(isHidden('locked')).toBe(true)
  })
})

describe('a claim in flight outranks the status', () => {
  // A committed claim turns this wallet's status into `claimed` — which is hidden. The claim's own
  // progress and result must survive that, and survive the status going unknown during a rescan.
  for (const status of ['claimed', 'unknown', null, 'paused', 'empty'] as const) {
    it(`keeps every claim state visible when the status reads ${String(status)}`, () => {
      expect(faucetPhase(at({ claim: 'claiming', status }))).toBe('claiming')
      expect(faucetPhase(at({ claim: 'verifying', status }))).toBe('verifying')
      expect(faucetPhase(at({ claim: 'done', status }))).toBe('done')
      expect(faucetPhase(at({ claim: 'lagging', status }))).toBe('lagging')
      expect(faucetPhase(at({ claim: 'error', status }))).toBe('error')
    })
  }

  it('and outranks a lock too — a result is reported, not withdrawn', () => {
    expect(faucetPhase(at({ claim: 'done', unlocked: false }))).toBe('done')
  })
})

describe('faucetAddedMessage — the claim\'s own amount, never the balance change', () => {
  it('reports what the claim paid in', () => {
    // A 1,000 claim at a 10,245 µtTARI fee lands 999.989755.
    expect(faucetAddedMessage(999_989_755n)).toMatch(/^Added 999\.99 TARI\./)
  })

  it('a payment landing in the same window does not inflate it', () => {
    // The balance rose by 1,000.99 (claim + a 1 TARI payment); the claim itself was 999.99.
    const claim = 999_989_755n
    const balanceRise = claim + 1_000_000n
    expect(faucetAddedMessage(claim)).toContain('999.99')
    expect(faucetAddedMessage(claim)).not.toContain('1,000.99')
    expect(faucetAddedMessage(claim)).not.toContain(String(balanceRise))
  })

  it('with no amount, says only that it arrived', () => {
    expect(faucetAddedMessage(null)).toMatch(/^Tokens received\./)
  })
})
