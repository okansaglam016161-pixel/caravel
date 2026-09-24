// When the faucet offers a claim, and — the part that was broken — when it says nothing.
//
// THE BUG THESE PIN: the ladder used to end in an unconditional `: 'idle'`, and the only balance
// guard asked "is it DEFINITELY high?". So a balance of `null` — which is what every rescan sets
// before it starts — read as "low", and a funded wallet flashed a "Claim test funds" banner on
// every refresh. A scan that errored left it there for good.
//
// `null` is NOT KNOWN and `0n` is a real, empty wallet. Half of what follows exists to keep those
// two apart.

import { describe, expect, it } from 'vitest'
import { HIGH_BALANCE, faucetPhase, isHidden, type FaucetPhaseInputs } from './faucetPhase'

/** A resting, unlocked wallet. Specs override the one field they are about. */
const at = (over: Partial<FaucetPhaseInputs> = {}): FaucetPhaseInputs => ({
  claim: 'idle', cooldown: false, balance: 0n, unlocked: true, ...over,
})

const RICH = HIGH_BALANCE
const POOR = HIGH_BALANCE - 1n

describe('what the balance says', () => {
  it('offers a claim on a CONFIRMED low balance', () => {
    expect(faucetPhase(at({ balance: POOR }))).toBe('idle')
    expect(faucetPhase(at({ balance: 0n }))).toBe('idle')
  })

  it('declines on a CONFIRMED high balance', () => {
    expect(faucetPhase(at({ balance: RICH }))).toBe('plenty')
    expect(faucetPhase(at({ balance: RICH * 10n }))).toBe('plenty')
  })

  // THE FLICKER. Every rescan blanks the balance to null before it starts, so this was reached on
  // every refresh — and fell through to `idle`, flashing a claim banner at a funded wallet.
  it('says NOTHING while the balance is unknown', () => {
    expect(faucetPhase(at({ balance: null }))).toBe('unknown')
  })

  it('and `unknown` renders nothing, like the other two declines', () => {
    expect(isHidden('unknown')).toBe(true)
    expect(isHidden('plenty')).toBe(true)
    expect(isHidden('locked')).toBe(true)
    expect(isHidden('idle')).toBe(false)
  })

  // A scan that fails leaves the balance at null indefinitely. Offering a claim then would be
  // asserting the wallet needs funding on the strength of a reading nobody obtained.
  it('keeps saying nothing when the balance stays unknown', () => {
    const errored = at({ balance: null })
    expect(faucetPhase(errored)).toBe('unknown')
    expect(faucetPhase(errored)).toBe('unknown')
  })

  // The boundary, stated once so it cannot drift: the threshold itself counts as plenty.
  it('treats the threshold as plenty, not as low', () => {
    expect(faucetPhase(at({ balance: HIGH_BALANCE }))).toBe('plenty')
    expect(faucetPhase(at({ balance: HIGH_BALANCE - 1n }))).toBe('idle')
  })
})

describe('an unread balance never hides a claim in flight', () => {
  // ── THE ORDERING GUARD ──
  //
  // A claim TRIGGERS a rescan, so the balance is null for part of every claim. If the unknown
  // check sat above these, the claim's own progress and result would vanish under the user
  // mid-claim. Each of these is a fact about the claim and owes nothing to the balance.
  it.each([
    ['claiming', 'claiming'],
    ['verifying', 'verifying'],
    ['done', 'done'],
    ['lagging', 'lagging'],
    ['error', 'error'],
  ] as const)('%s still renders with the balance unread', (claim, expected) => {
    expect(faucetPhase(at({ claim, balance: null }))).toBe(expected)
    // …and is not hidden, which is the half that would have been visible as a disappearing card.
    expect(isHidden(faucetPhase(at({ claim, balance: null })))).toBe(false)
  })

  it('a cooldown survives an unread balance too', () => {
    expect(faucetPhase(at({ cooldown: true, balance: null }))).toBe('cooldown')
  })

  // The reporting phases outrank even a confirmed high balance: a claim that just landed has
  // something to say, and "you have plenty" is not it.
  it('a finished claim outranks plenty', () => {
    expect(faucetPhase(at({ claim: 'done', balance: RICH }))).toBe('done')
  })
})

describe('locked', () => {
  it('is preferred over offering a control there is no wallet for', () => {
    expect(faucetPhase(at({ unlocked: false, balance: POOR }))).toBe('locked')
  })

  // A locked wallet with an unread balance is still locked — that is the more specific truth,
  // and both are hidden anyway.
  it('wins over unknown', () => {
    expect(faucetPhase(at({ unlocked: false, balance: null }))).toBe('locked')
  })

  // But a claim in flight still reports, even locked: the modal can be open over a locking wallet
  // and a claim that is mid-verify must not blink out.
  it('does not swallow a claim in flight', () => {
    expect(faucetPhase(at({ unlocked: false, claim: 'verifying' }))).toBe('verifying')
  })
})
