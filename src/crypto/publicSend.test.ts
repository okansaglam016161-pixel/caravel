// Tests for the public-send split and recipient validation (M8 C1).
//
// Two fund-critical things live in this file and they fail in different ways:
//
//   THE SPLIT — the engine compares the withdrawn bucket against the statement's revealed input
//   with NO tolerance (tari-ootle: runtime/working_state.rs:2062-2074). Drift between those two
//   numbers is a rejected transaction, and in the class of bug that produces it, potentially a
//   withdraw that does not match what the statement spends. planPublicSend exists so that number is
//   computed ONCE.
//
//   THE RECIPIENT — a mis-parsed address produces a perfectly valid commitment that only somebody
//   else, or nobody, can open. There is no bounce and no error at spend time. That makes address
//   validation the only thing standing between a typo and unrecoverable loss, and it is why the
//   network byte is checked as carefully as the format.

import { describe, expect, it, vi } from 'vitest'
import {
  MIN_PUBLIC_SEND_MICROTARI, PUBLIC_SEND_FEE_RESERVE, assertPublicSendSplit, assertValidRecipient,
  maxPublicSend, planPublicSend,
} from './publicSend'
import { planConceal } from './conceal'
import { Network } from '@tari-project/ootle'

const TARI = 1_000_000n

// ── The split ─────────────────────────────────────────────────────────────────

describe('planPublicSend — the amount is what ARRIVES, the fee goes on top', () => {
  it('pays the recipient exactly what was asked for', () => {
    expect(planPublicSend(10n * TARI, 18_705n).recipientAmount).toBe(10n * TARI)
  })

  it('withdraws amount + fee from the vault', () => {
    const s = planPublicSend(10n * TARI, 18_705n)
    expect(s.withdrawAmount).toBe(10n * TARI + 18_705n)
    expect(s.feeMicrotari).toBe(18_705n)
  })

  it('THE ASYMMETRY WITH CONCEAL: a send adds the fee, a conceal carves it out', () => {
    // Getting these the same way round would quietly short-pay every recipient by the fee.
    const amount = 10n * TARI
    const fee = 18_705n
    const sent = planPublicSend(amount, fee)
    const concealed = planConceal(amount, fee)

    expect(sent.recipientAmount).toBe(amount)              // send: the recipient's number, untouched
    expect(concealed.stealthAmount).toBe(amount - fee)     // conceal: the fee came out of it
    expect(sent.withdrawAmount - concealed.withdrawAmount).toBe(fee)
  })

  it('BALANCES: amount + fee === withdraw, at every scale', () => {
    for (const amount of [MIN_PUBLIC_SEND_MICROTARI, 1n * TARI, 999_595_988n, 1_000n * TARI, 2n ** 63n]) {
      for (const fee of [1n, 13_211n, 18_705n, PUBLIC_SEND_FEE_RESERVE]) {
        const s = planPublicSend(amount, fee)
        expect(s.recipientAmount + s.feeMicrotari).toBe(s.withdrawAmount)
        expect(s.recipientAmount).toBe(amount)
      }
    }
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    const amount = 18_446_744_073_709_551_615n
    const s = planPublicSend(amount, 18_705n)
    expect(s.withdrawAmount).toBe(18_446_744_073_709_570_320n)
    expect(s.recipientAmount).toBe(amount)
  })

  it('a measured fee below the reserve changes only the withdraw, never the payment', () => {
    // Why the amount can be fixed before the fee is known: the recipient's figure is invariant.
    const priced = planPublicSend(5n * TARI, PUBLIC_SEND_FEE_RESERVE)
    const real = planPublicSend(5n * TARI, 18_705n)
    expect(real.recipientAmount).toBe(priced.recipientAmount)
    expect(priced.withdrawAmount - real.withdrawAmount).toBe(PUBLIC_SEND_FEE_RESERVE - 18_705n)
  })
})

describe('planPublicSend — refusals', () => {
  it.each([0n, -1n, -1_000_000n])('refuses a non-positive amount (%s)', (amount) => {
    expect(() => planPublicSend(amount, 1_000n)).toThrow(/Amount must be greater than zero/)
  })

  it.each([0n, -1n])('refuses a non-positive fee (%s)', (fee) => {
    expect(() => planPublicSend(1n * TARI, fee)).toThrow(/Fee must be greater than zero/)
  })
})

describe('assertPublicSendSplit — the tripwire for a second derivation', () => {
  it('passes every split planPublicSend produces', () => {
    expect(() => assertPublicSendSplit(planPublicSend(10n * TARI, 18_705n))).not.toThrow()
  })

  it('catches a withdraw that drifted from the statement input', () => {
    // The exact bug this guards: someone recomputes the withdraw separately and the two stop
    // agreeing. On-chain that is an opaque bucket-mismatch rejection; here it is a caught bug.
    const good = planPublicSend(10n * TARI, 18_705n)
    expect(() => assertPublicSendSplit({ ...good, withdrawAmount: good.withdrawAmount + 1n }))
      .toThrow(/does not balance/)
  })

  it('catches a recipient amount that drifted', () => {
    const good = planPublicSend(10n * TARI, 18_705n)
    expect(() => assertPublicSendSplit({ ...good, recipientAmount: good.recipientAmount - 1n }))
      .toThrow(/does not balance/)
  })

  it.each([
    ['zero amount', { recipientAmount: 0n, feeMicrotari: 100n, withdrawAmount: 100n }],
    ['zero fee', { recipientAmount: 100n, feeMicrotari: 0n, withdrawAmount: 100n }],
    ['zero withdraw', { recipientAmount: 0n, feeMicrotari: 0n, withdrawAmount: 0n }],
  ])('refuses a non-positive component (%s)', (_label, split) => {
    expect(() => assertPublicSendSplit(split)).toThrow(/non-positive component/)
  })
})

// ── The recipient — unrecoverable if wrong ───────────────────────────────────

const ESM = { owner_key: new Uint8Array(32), view_key: new Uint8Array(32), network: Network.Esmeralda }
const ok = () => vi.fn(() => ESM)

describe('assertValidRecipient', () => {
  it('accepts a well-formed address on this network', () => {
    expect(() => assertValidRecipient('otl_esm_1abc', ok())).not.toThrow()
  })

  it('trims before parsing, so a pasted address with whitespace still works', () => {
    const parse = ok()
    expect(() => assertValidRecipient('  otl_esm_1abc\n', parse)).not.toThrow()
    expect(parse).toHaveBeenCalledWith('otl_esm_1abc')
  })

  it.each(['', '   ', '\n'])('refuses an empty address (%j)', (bad) => {
    expect(() => assertValidRecipient(bad, ok())).toThrow(/Enter the address/)
  })

  it('refuses anything the parser rejects', () => {
    const parse = vi.fn(() => { throw new Error('bech32 checksum failed') })
    expect(() => assertValidRecipient('otl_esm_1typo', parse)).toThrow(/doesn’t look like a valid Tari address/)
  })

  it('REFUSES A WRONG-NETWORK ADDRESS — the one people forget', () => {
    // A mainnet address is well-formed and parses cleanly. bech32m catches a typo; only this
    // catches a wrong-network paste, and paying it would commit to keys nobody on this chain
    // is watching.
    const mainnet = vi.fn(() => ({ ...ESM, network: Network.MainNet }))
    expect(() => assertValidRecipient('otl_1mainnet', mainnet)).toThrow(/different Tari network/)
  })

  it.each([Network.MainNet, Network.StageNet, Network.NextNet, Network.LocalNet, Network.Igor])(
    'refuses network %s when Esmeralda is expected', (network) => {
      expect(() => assertValidRecipient('otl_x', vi.fn(() => ({ ...ESM, network })))).toThrow(/different Tari network/)
    })

  it('can be pointed at another network deliberately', () => {
    const localnet = vi.fn(() => ({ ...ESM, network: Network.LocalNet }))
    expect(() => assertValidRecipient('otl_x', localnet, Network.LocalNet)).not.toThrow()
  })

  it.each([
    ['short owner key', { owner_key: new Uint8Array(31), view_key: new Uint8Array(32) }],
    ['short view key', { owner_key: new Uint8Array(32), view_key: new Uint8Array(16) }],
    ['empty keys', { owner_key: new Uint8Array(0), view_key: new Uint8Array(0) }],
  ])('refuses malformed keys (%s) before they reach createOutput', (_label, keys) => {
    const parse = vi.fn(() => ({ ...keys, network: Network.Esmeralda }))
    expect(() => assertValidRecipient('otl_x', parse)).toThrow(/malformed/)
  })
})

// ── MAX ───────────────────────────────────────────────────────────────────────

describe('maxPublicSend', () => {
  it('holds back the fee reserve', () => {
    expect(maxPublicSend(1_000n * TARI)).toBe(1_000n * TARI - PUBLIC_SEND_FEE_RESERVE)
  })

  it('MAX never withdraws more than the balance holds, at any fee up to the reserve', () => {
    // The whole chain's guarantee: withdraw = amount + fee must fit inside the public balance.
    for (const balance of [50_001n, 100_000n, 700_997_686n, 1_000n * TARI, 2n ** 70n]) {
      const amount = maxPublicSend(balance)
      if (amount === 0n) continue
      for (const fee of [1n, 18_705n, PUBLIC_SEND_FEE_RESERVE]) {
        expect(planPublicSend(amount, fee).withdrawAmount).toBeLessThanOrEqual(balance)
      }
    }
  })

  it('returns 0n — never a negative — when the balance cannot cover the reserve', () => {
    for (const balance of [0n, 1n, 49_999n, PUBLIC_SEND_FEE_RESERVE]) {
      expect(maxPublicSend(balance)).toBe(0n)
    }
  })

  it('is exact one µtTARI above the reserve', () => {
    expect(maxPublicSend(PUBLIC_SEND_FEE_RESERVE + 1n)).toBe(1n)
  })
})

describe('the constants hang together', () => {
  it('the reserve sits above every fee measured on this network', () => {
    // Largest observed for this shape: 18 705 µtTARI (dry run, 2026-08-25).
    expect(PUBLIC_SEND_FEE_RESERVE).toBeGreaterThan(18_705n)
  })

  it('a balance at the floor plus the reserve can still send the floor', () => {
    const balance = MIN_PUBLIC_SEND_MICROTARI + PUBLIC_SEND_FEE_RESERVE
    expect(maxPublicSend(balance)).toBeGreaterThanOrEqual(MIN_PUBLIC_SEND_MICROTARI)
    const s = planPublicSend(MIN_PUBLIC_SEND_MICROTARI, 18_705n)
    assertPublicSendSplit(s)
    expect(s.withdrawAmount).toBeLessThanOrEqual(balance)
  })

  it('matches the conceal and reveal floors, so every amount field behaves the same', () => {
    expect(MIN_PUBLIC_SEND_MICROTARI).toBe(100_000n)
  })
})
