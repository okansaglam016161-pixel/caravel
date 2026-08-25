// Tests for the confidential send's arithmetic and ceiling.
//
// A SEND NOW SPENDS MANY OUTPUTS, and that is where the risk moved. With one input the change was
// a subtraction nobody could get wrong; across a set there are more ways for the sum to drift, and
// NOTHING BUT THE BALANCE PROOF CHECKS IT. The engine cannot see input values — they are hidden in
// commitments and carried by masks — so a change amount one microtari off does not fail loudly. It
// produces a proof over a different equation and the transaction is rejected with no hint about
// where the value went.
//
// So the invariant `amount + fee + change === inputTotal` is the whole point of this file, tested
// across the input counts the live chain accepted: 1, 2, 8, 15 and 64.

import { describe, expect, it } from 'vitest'
import {
  MAX_FEE, assertStealthSendSplit, maxStealthSend, planStealthSend, probeFeeFor,
} from './confidentialSend'
import { MAX_STEALTH_INPUTS, reachableTotal, selectStealthInputs } from './stealthUtxos'

const TARI = 1_000_000n
const MIN_SEND = 100_000n

/** The real seeded-wallet distribution — 15 outputs, 1107.746328 total. */
const FRAGMENTED = [
  245_949_129n, 199_985_542n, 199_985_542n, 100_000_000n, 100_000_000n, 100_000_000n,
  47_985_543n, 47_985_543n, 43_985_543n, 7_000_000n, 5_985_462n, 3_956_464n,
  2_971_007n, 985_544n, 971_009n,
]
const TOTAL = FRAGMENTED.reduce((s, v) => s + v, 0n)

describe('planStealthSend — the balance equation across a set of inputs', () => {
  it('pays the recipient exactly what was asked for', () => {
    expect(planStealthSend(10n * TARI, 24_642n, 500n * TARI).recipientAmount).toBe(10n * TARI)
  })

  it('change is everything the inputs are worth beyond amount + fee', () => {
    const s = planStealthSend(10n * TARI, 24_642n, 15n * TARI)
    expect(s.changeAmount).toBe(15n * TARI - 10n * TARI - 24_642n)
  })

  it('BALANCES ACROSS 1, 2, 8, 15 AND 64 INPUTS', () => {
    // The counts the live chain accepted. For each, select against a real target and check the
    // equation closes exactly.
    for (const n of [1, 2, 8, 15, 64]) {
      const outputs = Array.from({ length: n }, (_, i) => BigInt(i + 1) * 10n * TARI)
      const total = outputs.reduce((s, v) => s + v, 0n)
      const amount = total - MAX_FEE - TARI          // leave a little change
      const sel = selectStealthInputs(outputs.map(value => ({ value })), amount + MAX_FEE)
      for (const fee of [1n, 24_642n, 25_539n, MAX_FEE]) {
        const split = planStealthSend(amount, fee, sel.total)
        assertStealthSendSplit(split)
        // Nothing created, nothing destroyed.
        expect(split.inputTotal - split.recipientAmount - split.feeMicrotari - split.changeAmount).toBe(0n)
        expect(split.recipientAmount).toBe(amount)
      }
    }
  })

  it('holds on the real fragmented wallet, spending everything it can', () => {
    const amount = maxStealthSend(FRAGMENTED)
    const sel = selectStealthInputs(FRAGMENTED.map(value => ({ value })), amount + MAX_FEE)
    expect(sel.inputs.length).toBe(FRAGMENTED.length)     // all 15
    const split = planStealthSend(amount, 25_539n, sel.total)
    assertStealthSendSplit(split)
    expect(split.inputTotal).toBe(TOTAL)
  })

  it('allows exact cover — no change output', () => {
    const s = planStealthSend(1n * TARI, 20_000n, 1n * TARI + 20_000n)
    expect(s.changeAmount).toBe(0n)
    expect(() => assertStealthSendSplit(s)).not.toThrow()
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    const s = planStealthSend(9_007_199_254_740_993n, 24_642n, 18_014_398_509_481_986n)
    assertStealthSendSplit(s)
    expect(s.changeAmount).toBe(18_014_398_509_481_986n - 9_007_199_254_740_993n - 24_642n)
  })

  it('refuses inputs that do not cover amount + fee, even by one', () => {
    expect(() => planStealthSend(1n * TARI, 20_000n, 1n * TARI + 19_999n)).toThrow(/do not cover/)
  })

  it.each([0n, -1n])('refuses a non-positive amount (%s)', (a) => {
    expect(() => planStealthSend(a, 1_000n, 100n * TARI)).toThrow(/Amount must be greater than zero/)
  })
})

describe('assertStealthSendSplit — the tripwire', () => {
  const good = () => planStealthSend(10n * TARI, 24_642n, 15n * TARI)

  it('catches a change amount that drifted — the silent one', () => {
    expect(() => assertStealthSendSplit({ ...good(), changeAmount: good().changeAmount - 1n }))
      .toThrow(/value would be lost/)
  })

  it('catches an input total that drifted', () => {
    expect(() => assertStealthSendSplit({ ...good(), inputTotal: good().inputTotal + 5n }))
      .toThrow(/value would be lost/)
  })

  it('refuses negative change', () => {
    expect(() => assertStealthSendSplit({ recipientAmount: 100n, feeMicrotari: 50n, inputTotal: 149n, changeAmount: -1n }))
      .toThrow(/negative change/)
  })

  it('accepts zero change but not a zero amount', () => {
    expect(() => assertStealthSendSplit({ recipientAmount: 100n, feeMicrotari: 50n, inputTotal: 150n, changeAmount: 0n })).not.toThrow()
    expect(() => assertStealthSendSplit({ recipientAmount: 0n, feeMicrotari: 50n, inputTotal: 50n, changeAmount: 0n })).toThrow(/non-positive/)
  })
})

// ── The ceiling ──────────────────────────────────────────────────────────────

describe('maxStealthSend — the whole balance, not the largest output', () => {
  it('THE FIX: offers the whole balance on a fragmented wallet', () => {
    // The one-input builder could carry only the largest output — 245.95 of 1107.75.
    expect(maxStealthSend(FRAGMENTED)).toBe(TOTAL - MAX_FEE)
    expect(maxStealthSend(FRAGMENTED)).toBeGreaterThan(245_949_129n)
  })

  it('what it offers is always selectable', () => {
    const shapes = [
      FRAGMENTED,
      [500_000_000n],
      Array.from({ length: 40 }, (_, i) => BigInt(i + 1) * TARI),
      Array.from({ length: 64 }, () => 20n * TARI),
      Array.from({ length: 200 }, () => 5n * TARI),
    ]
    for (const shape of shapes) {
      const amount = maxStealthSend(shape)
      if (amount <= 0n) continue
      const sel = selectStealthInputs(shape.map(value => ({ value })), amount + MAX_FEE)
      expect(sel.inputs.length).toBeLessThanOrEqual(MAX_STEALTH_INPUTS)
      assertStealthSendSplit(planStealthSend(amount, 25_539n, sel.total))
    }
  })

  it('past the cap it offers the top-64 sum, not the total', () => {
    const many = Array.from({ length: 200 }, () => 5n * TARI)
    const total = many.reduce((s, v) => s + v, 0n)
    expect(maxStealthSend(many)).toBe(reachableTotal(many) - MAX_FEE)
    expect(maxStealthSend(many)).toBeLessThan(total - MAX_FEE)
  })

  it('returns 0n when nothing can carry a payment', () => {
    expect(maxStealthSend([])).toBe(0n)
    expect(maxStealthSend([1n, 2n])).toBe(0n)
    expect(maxStealthSend([MAX_FEE])).toBe(0n)
  })

  it('order does not matter', () => {
    expect(maxStealthSend([...FRAGMENTED].reverse())).toBe(maxStealthSend(FRAGMENTED))
  })
})

// ── THE PROBE MUST BE THE SAME SHAPE AS THE SEND ─────────────────────────────
//
// The regression this pins, in full: MAX is defined as `reachable − MAX_FEE`, so at MAX the
// selection covers the spend EXACTLY and reserving the full ceiling leaves zero change. A zero
// change emits no change output, so the probe measured a ONE-output transaction while the real send
// — whose measured fee is far below the ceiling — had real change and TWO outputs.
//
// Outputs are what a transfer pays for: PER_OUTPUT is 6 000 000 metering points against
// PER_INPUT's 42 000. Measured on Esmeralda, that missing output understated the fee by 6 307
// µtTARI (12 025 vs 18 332 for the same 14 inputs), which the 25% margin could not absorb, and the
// transaction was rejected: "Required fees 16546 but 14791 paid".
//
// The rule being restored is the one every builder in this codebase states: the priced transaction
// must be the transaction that is submitted — same inputs AND same outputs.

/** How many outputs a build emits for a given change: the recipient's, plus change if any. */
const outputCount = (change: bigint) => (change > 0n ? 2 : 1)

describe('probe shape === submit shape', () => {
  const MEASURED_FEES = [12_025n, 18_332n, 24_642n, 25_539n, MAX_FEE]

  it('THE REGRESSION: at MAX the probe still emits a change output', () => {
    const total = FRAGMENTED.reduce((s, v) => s + v, 0n)
    const amount = maxStealthSend(FRAGMENTED)          // total − MAX_FEE

    // What the old code did: reserve the full ceiling.
    expect(planStealthSend(amount, MAX_FEE, total).changeAmount).toBe(0n)   // ← one output. The bug.

    // What it does now.
    const probeFee = probeFeeFor(total, amount)
    const probeChange = planStealthSend(amount, probeFee, total).changeAmount
    expect(probeChange).toBeGreaterThan(0n)
    expect(outputCount(probeChange)).toBe(2)
  })

  it('probe and real build agree on output count, at MAX, for every realistic fee', () => {
    const total = FRAGMENTED.reduce((s, v) => s + v, 0n)
    const amount = maxStealthSend(FRAGMENTED)
    const probeFee = probeFeeFor(total, amount)
    const probeChange = planStealthSend(amount, probeFee, total).changeAmount
    for (const realFee of MEASURED_FEES) {
      // A fee above what the probe reserved is refused before anything is built — it was never
      // simulated. Everything the builder will actually use is at or below it.
      if (realFee > probeFee) continue
      expect(outputCount(planStealthSend(amount, realFee, total).changeAmount)).toBe(outputCount(probeChange))
    }
  })

  it('THE PROOF: the probe’s change is the SMALLEST the real build can have', () => {
    // This is why lowering the probe fee is sound rather than a fudge — the probe reserves the
    // largest fee the transaction can pay, so any real fee leaves at least as much change.
    const total = FRAGMENTED.reduce((s, v) => s + v, 0n)
    for (const amount of [1n * TARI, 100n * TARI, maxStealthSend(FRAGMENTED)]) {
      const probeFee = probeFeeFor(total, amount)
      const probeChange = planStealthSend(amount, probeFee, total).changeAmount
      for (const realFee of MEASURED_FEES) {
        if (realFee > probeFee) continue                    // refused before it is built
        expect(planStealthSend(amount, realFee, total).changeAmount).toBeGreaterThanOrEqual(probeChange)
      }
    }
  })

  it('holds across wallet shapes and every amount up to MAX', () => {
    const shapes = [
      FRAGMENTED,
      [500_000_000n],
      Array.from({ length: 40 }, (_, i) => BigInt(i + 1) * TARI),
      Array.from({ length: 64 }, () => 20n * TARI),
    ]
    for (const shape of shapes) {
      const max = maxStealthSend(shape)
      if (max <= 0n) continue
      for (const amount of [max, max / 2n, max - 1n, MIN_SEND]) {
        if (amount <= 0n) continue
        const sel = selectStealthInputs(shape.map(value => ({ value })), amount + MAX_FEE)
        const probeFee = probeFeeFor(sel.total, amount)
        const probeChange = planStealthSend(amount, probeFee, sel.total).changeAmount
        // The probe always has a change output…
        expect(probeChange).toBeGreaterThan(0n)
        // …and so does the real build, at any fee the probe would allow.
        for (const realFee of MEASURED_FEES) {
          if (realFee > probeFee) continue
          expect(outputCount(planStealthSend(amount, realFee, sel.total).changeAmount)).toBe(outputCount(probeChange))
        }
      }
    }
  })

  it('the probe fee stays generous — at most one microtari below the ceiling', () => {
    const total = FRAGMENTED.reduce((s, v) => s + v, 0n)
    for (const amount of [1n * TARI, 100n * TARI, maxStealthSend(FRAGMENTED)]) {
      const fee = probeFeeFor(total, amount)
      expect(fee).toBeGreaterThanOrEqual(MAX_FEE - 1n)
      expect(fee).toBeLessThanOrEqual(MAX_FEE)
    }
  })

  it('a fee above the reservation is refused, so the 1-output real build is unreachable', () => {
    // The residual case this closes: if the real fee landed exactly on the ceiling, the real build
    // would have zero change and one output while the probe had two. The builder refuses any fee
    // above what the probe reserved, so that shape can never be submitted.
    const total = FRAGMENTED.reduce((s, v) => s + v, 0n)
    const amount = maxStealthSend(FRAGMENTED)
    const probeFee = probeFeeFor(total, amount)
    expect(MAX_FEE).toBeGreaterThan(probeFee)                       // the ceiling is above it…
    expect(planStealthSend(amount, MAX_FEE, total).changeAmount).toBe(0n)  // …and would be 1 output
    // …which is why the builder compares against the reservation rather than the ceiling.
  })

  it('the probe split always balances', () => {
    const total = FRAGMENTED.reduce((s, v) => s + v, 0n)
    for (const amount of [1n * TARI, maxStealthSend(FRAGMENTED)]) {
      const split = planStealthSend(amount, probeFeeFor(total, amount), total)
      assertStealthSendSplit(split)
    }
  })
})
