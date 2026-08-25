// Tests for the reveal split and its input selection (M3 C1).
//
// This is the fund-critical arithmetic of the milestone, and there is more of it than conceal had,
// because reveal has TWO invariants rather than one and they fail in different ways:
//
//   amount + fee === revealedOutput        — checked by the ENGINE, through the bucket. Drift here
//                                            means the leftover after TakeFromBucket is not the fee.
//   revealedOutput + change === inputTotal — checked by the BALANCE PROOF and by NOTHING ELSE. The
//                                            engine cannot see input values; they are hidden in
//                                            commitments. A change amount that is one µtTARI wrong
//                                            produces a proof over a different equation, and the
//                                            rejection says nothing about the value that vanished.
//
// planReveal exists so both are computed ONCE. These tests pin that, pin the asymmetry with
// planConceal (fee ON TOP, not carved out — because a reveal publishes the amount permanently), and
// pin the refusals that keep a degenerate split from ever reaching a transaction builder.

import { describe, expect, it } from 'vitest'
import {
  MAX_STEALTH_INPUTS,
  MIN_REVEAL_MICROTARI,
  MIN_STEALTH_CHANGE,
  REVEAL_FEE_RESERVE,
  assertRevealSplit,
  maxRevealable,
  planReveal,
  selectStealthInputs,
} from './reveal'
import { planConceal } from './conceal'

const TARI = 1_000_000n

/** A candidate stealth output. Only `value` matters to selection, which is why it is all it needs. */
const utxo = (value: bigint) => ({ value })

describe('planReveal — the amount is what LANDS, and the fee sits on top', () => {
  it('publishes exactly the amount asked for', () => {
    // The whole reason reveal's arithmetic is the mirror of conceal's. Whatever else changes, the
    // number the user chose is the number deposited.
    const split = planReveal(100n * TARI, 15_000n, 200n * TARI)
    expect(split.amount).toBe(100n * TARI)
  })

  it('adds the fee ON TOP to form the revealed output', () => {
    const split = planReveal(100n * TARI, 15_000n, 200n * TARI)
    expect(split.revealedOutput).toBe(100n * TARI + 15_000n)
    expect(split.feeMicrotari).toBe(15_000n)
  })

  it('THE ASYMMETRY WITH CONCEAL: reveal adds the fee, conceal carves it out', () => {
    // Getting these the same way round would publish a number the user never chose. Conceal moves
    // `amount` out of the vault and `amount - fee` lands private; reveal deposits `amount` and
    // spends `amount + fee`. Same inputs, deliberately opposite results.
    const amount = 100n * TARI
    const fee = 16_138n
    const revealed = planReveal(amount, fee, 500n * TARI)
    const concealed = planConceal(amount, fee)

    expect(revealed.amount).toBe(amount)                    // reveal: the user's number, untouched
    expect(concealed.stealthAmount).toBe(amount - fee)      // conceal: the fee came out of it
    expect(revealed.revealedOutput - concealed.withdrawAmount).toBe(fee)
  })

  it('returns the change as everything the inputs are worth beyond amount + fee', () => {
    const split = planReveal(10n * TARI, 20_000n, 15n * TARI)
    expect(split.changeAmount).toBe(15n * TARI - 10n * TARI - 20_000n)
  })

  it('BALANCES: revealed + change === inputs, at every scale', () => {
    for (const amount of [MIN_REVEAL_MICROTARI, 1n * TARI, 999_595_988n, 1_000n * TARI, 2n ** 63n]) {
      for (const fee of [1n, 13_211n, 16_138n, 50_000n]) {
        for (const surplus of [0n, 1n, 7n, 123_456n, 10n * TARI]) {
          const inputTotal = amount + fee + surplus
          const s = planReveal(amount, fee, inputTotal)
          expect(s.amount + s.feeMicrotari).toBe(s.revealedOutput)
          expect(s.revealedOutput + s.changeAmount).toBe(s.inputTotal)
          expect(s.changeAmount).toBe(surplus)
        }
      }
    }
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    // Amounts are 128-bit; a split that went through Number would drift here — and the drift would
    // be published.
    const amount = 18_446_744_073_709_551_615n
    const s = planReveal(amount, 16_138n, amount + 16_138n + 999n)
    expect(s.revealedOutput).toBe(18_446_744_073_709_567_753n)
    expect(s.changeAmount).toBe(999n)
    expect(s.revealedOutput + s.changeAmount).toBe(s.inputTotal)
  })

  it('allows exact cover — inputs equal to amount + fee, no change', () => {
    const s = planReveal(1n * TARI, 20_000n, 1n * TARI + 20_000n)
    expect(s.changeAmount).toBe(0n)
    expect(() => assertRevealSplit(s)).not.toThrow()
  })

  it('allows a single µtTARI of change — the tightest non-exact split', () => {
    const s = planReveal(1n * TARI, 20_000n, 1n * TARI + 20_001n)
    expect(s.changeAmount).toBe(1n)
    assertRevealSplit(s)
  })
})

describe('planReveal — refusals', () => {
  it('refuses inputs that do not cover the amount plus the fee', () => {
    expect(() => planReveal(1n * TARI, 20_000n, 1n * TARI)).toThrow(/do not cover the amount plus the network fee/)
  })

  it('refuses inputs one µtTARI short', () => {
    // The off-by-one that would otherwise become a negative change and an unprovable equation.
    expect(() => planReveal(1n * TARI, 20_000n, 1n * TARI + 19_999n)).toThrow(/do not cover/)
  })

  it.each([0n, -1n, -1_000_000n])('refuses a non-positive amount (%s)', (amount) => {
    expect(() => planReveal(amount, 1_000n, 100n * TARI)).toThrow(/Amount must be greater than zero/)
  })

  it.each([0n, -1n])('refuses a non-positive fee (%s)', (fee) => {
    expect(() => planReveal(100n * TARI, fee, 1_000n * TARI)).toThrow(/Fee must be greater than zero/)
  })
})

describe('assertRevealSplit — the tripwire for a future second derivation', () => {
  const good = () => planReveal(100n * TARI, 16_138n, 150n * TARI)

  it('passes every split planReveal produces', () => {
    expect(() => assertRevealSplit(good())).not.toThrow()
  })

  it('catches a revealed output that drifted from amount + fee (INVARIANT 1)', () => {
    // The engine-checked one: TakeFromBucket would leave something that is not the fee.
    const drifted = { ...good(), revealedOutput: good().revealedOutput + 1n }
    expect(() => assertRevealSplit(drifted)).toThrow(/revealed output does not balance/)
  })

  it('catches a change amount that drifted (INVARIANT 2 — the silent one)', () => {
    // The balance-proof-checked one. This is the bug that loses value: nothing else would catch it.
    const drifted = { ...good(), changeAmount: good().changeAmount - 1n }
    expect(() => assertRevealSplit(drifted)).toThrow(/value would be lost/)
  })

  it('catches an input total that drifted', () => {
    const drifted = { ...good(), inputTotal: good().inputTotal + 5n }
    expect(() => assertRevealSplit(drifted)).toThrow(/value would be lost/)
  })

  it('refuses negative change', () => {
    const bad = { amount: 100n, feeMicrotari: 50n, revealedOutput: 150n, inputTotal: 149n, changeAmount: -1n }
    expect(() => assertRevealSplit(bad)).toThrow(/negative change/)
  })

  it.each([
    ['zero amount', { amount: 0n, feeMicrotari: 100n, revealedOutput: 100n, inputTotal: 100n, changeAmount: 0n }],
    ['zero fee', { amount: 100n, feeMicrotari: 0n, revealedOutput: 100n, inputTotal: 100n, changeAmount: 0n }],
  ])('refuses a non-positive component (%s)', (_label, split) => {
    expect(() => assertRevealSplit(split)).toThrow(/non-positive component/)
  })

  it('accepts zero change but not zero amount — the two are not the same kind of zero', () => {
    expect(() => assertRevealSplit({ amount: 100n, feeMicrotari: 50n, revealedOutput: 150n, inputTotal: 150n, changeAmount: 0n })).not.toThrow()
  })
})

// ── Input selection — where value disappears if it goes wrong ─────────────────

describe('selectStealthInputs — preference order', () => {
  it('prefers an EXACT single match, leaving no change to compute', () => {
    const target = 1_020_000n
    const sel = selectStealthInputs([utxo(5n * TARI), utxo(target), utxo(2n * TARI)], target)
    expect(sel.inputs).toHaveLength(1)
    expect(sel.total).toBe(target)
    expect(planReveal(1n * TARI, 20_000n, sel.total).changeAmount).toBe(0n)
  })

  it('otherwise takes the SMALLEST single output that covers the target', () => {
    // Locks the least value and leaves the wallet's larger outputs intact — what the send path does.
    const sel = selectStealthInputs([utxo(50n * TARI), utxo(3n * TARI), utxo(10n * TARI)], 2n * TARI)
    expect(sel.inputs).toHaveLength(1)
    expect(sel.total).toBe(3n * TARI)
  })

  it('accumulates LARGEST-FIRST when no single output covers the target', () => {
    // Largest-first minimises the input count, which is what the fee and the input cap care about.
    const sel = selectStealthInputs([utxo(1n * TARI), utxo(4n * TARI), utxo(3n * TARI), utxo(2n * TARI)], 6n * TARI)
    expect(sel.inputs.map(u => u.value)).toEqual([4n * TARI, 3n * TARI])
    expect(sel.total).toBe(7n * TARI)
  })

  it('stops as soon as the target is covered, not after consuming everything', () => {
    const sel = selectStealthInputs([utxo(4n * TARI), utxo(3n * TARI), utxo(2n * TARI), utxo(1n * TARI)], 5n * TARI)
    expect(sel.inputs).toHaveLength(2)
    expect(sel.total).toBe(7n * TARI)
  })

  it('spends everything when the target needs it all (the MAX shape)', () => {
    const all = [utxo(1n * TARI), utxo(2n * TARI), utxo(3n * TARI)]
    const sel = selectStealthInputs(all, 6n * TARI)
    expect(sel.inputs).toHaveLength(3)
    expect(sel.total).toBe(6n * TARI)
  })

  it('ignores zero-value outputs, which can only inflate the input count', () => {
    const sel = selectStealthInputs([utxo(0n), utxo(5n * TARI), utxo(0n)], 1n * TARI)
    expect(sel.inputs.map(u => u.value)).toEqual([5n * TARI])
  })

  it('is DETERMINISTIC — the priced transaction and the sent one select the same inputs', () => {
    const set = [utxo(3n * TARI), utxo(1n * TARI), utxo(3n * TARI), utxo(2n * TARI)]
    const a = selectStealthInputs(set, 5n * TARI)
    const b = selectStealthInputs(set, 5n * TARI)
    expect(a.inputs.map(u => u.value)).toEqual(b.inputs.map(u => u.value))
    expect(a.total).toBe(b.total)
  })
})

describe('selectStealthInputs — refusals', () => {
  it('refuses when the wallet holds nothing spendable', () => {
    expect(() => selectStealthInputs([], 1n * TARI)).toThrow(/holds no spendable stealth outputs/)
    expect(() => selectStealthInputs([utxo(0n)], 1n * TARI)).toThrow(/holds no spendable stealth outputs/)
  })

  it('refuses with the real numbers when the balance cannot cover the target', () => {
    expect(() => selectStealthInputs([utxo(1n * TARI), utxo(2n * TARI)], 5n * TARI))
      .toThrow(/needs 5000000 µtTARI \(amount \+ network fee\), and the wallet holds 3000000 µtTARI across 2 output\(s\)/)
  })

  it('refuses when the balance is one µtTARI short', () => {
    expect(() => selectStealthInputs([utxo(1_000_000n)], 1_000_001n)).toThrow(/Not enough private funds/)
  })

  it('refuses a target that needs more than MAX_STEALTH_INPUTS outputs', () => {
    // Priced fine in simulation, then refused for size AFTER an irreversible confirm — so it is
    // turned into an honest refusal beforehand.
    const many = Array.from({ length: MAX_STEALTH_INPUTS + 2 }, () => utxo(1n * TARI))
    expect(() => selectStealthInputs(many, BigInt(MAX_STEALTH_INPUTS + 1) * TARI))
      .toThrow(/spread across too many small outputs/)
  })

  it('allows exactly MAX_STEALTH_INPUTS outputs', () => {
    const many = Array.from({ length: MAX_STEALTH_INPUTS }, () => utxo(1n * TARI))
    const sel = selectStealthInputs(many, BigInt(MAX_STEALTH_INPUTS) * TARI)
    expect(sel.inputs).toHaveLength(MAX_STEALTH_INPUTS)
  })

  it.each([0n, -1n])('refuses a non-positive target (%s)', (t) => {
    expect(() => selectStealthInputs([utxo(1n * TARI)], t)).toThrow(/target must be greater than zero/)
  })
})

// ── Selection + split together: the balance equation on real-shaped sets ──────

describe('the balance equation holds end to end', () => {
  it('inputs − revealed − change === 0 for every selection the planner accepts', () => {
    const wallets = [
      [utxo(1_000n * TARI)],
      [utxo(1n * TARI), utxo(2n * TARI), utxo(3n * TARI)],
      [utxo(999_595_988n), utxo(400_404_012n)],
      [utxo(150_000n), utxo(150_000n), utxo(150_000n), utxo(150_000n)],
    ]
    for (const w of wallets) {
      const balance = w.reduce((s, u) => s + u.value, 0n)
      for (const amount of [MIN_REVEAL_MICROTARI, 200_000n, balance / 2n]) {
        if (amount < MIN_REVEAL_MICROTARI) continue
        const target = amount + REVEAL_FEE_RESERVE
        if (balance < target) continue

        const sel = selectStealthInputs(w, target)
        for (const fee of [13_211n, 16_138n, REVEAL_FEE_RESERVE]) {
          const split = planReveal(amount, fee, sel.total)
          assertRevealSplit(split)
          // Nothing created, nothing destroyed.
          expect(split.inputTotal - split.revealedOutput - split.changeAmount).toBe(0n)
          // And the published number is untouched by any of it.
          expect(split.amount).toBe(amount)
        }
      }
    }
  })

  it('a measured fee below the reserve only grows the change — it never breaks the equation', () => {
    // Why the selection can be pinned at the reserve and reused at the real fee.
    const wallet = [utxo(500n * TARI)]
    const amount = 100n * TARI
    const sel = selectStealthInputs(wallet, amount + REVEAL_FEE_RESERVE)

    const priced = planReveal(amount, REVEAL_FEE_RESERVE, sel.total)
    const real = planReveal(amount, 16_138n, sel.total)

    expect(real.amount).toBe(priced.amount)                                   // published number: unchanged
    expect(real.changeAmount - priced.changeAmount).toBe(REVEAL_FEE_RESERVE - 16_138n)
    assertRevealSplit(real)
  })
})

// ── MAX ───────────────────────────────────────────────────────────────────────

describe('maxRevealable', () => {
  it('holds back the fee reserve AND a stealth crumb', () => {
    expect(maxRevealable(1_000n * TARI)).toBe(1_000n * TARI - REVEAL_FEE_RESERVE - MIN_STEALTH_CHANGE)
  })

  it('KEEPS EVERY BUILD OFF THE ZERO-OUTPUT PATH — the reason the crumb exists', () => {
    // MAX selects every output, so the PRICING build (which reserves the full probe) would have
    // zero change and therefore no stealth output at all. The crumb guarantees one in both builds.
    const balance = 999_597_686n
    const amount = maxRevealable(balance)
    const sel = selectStealthInputs([utxo(balance)], amount + REVEAL_FEE_RESERVE)

    const priced = planReveal(amount, REVEAL_FEE_RESERVE, sel.total)
    expect(priced.changeAmount).toBe(MIN_STEALTH_CHANGE)
    expect(priced.changeAmount).toBeGreaterThan(0n)

    const real = planReveal(amount, 16_138n, sel.total)
    expect(real.changeAmount).toBeGreaterThan(0n)
    assertRevealSplit(real)
  })

  it('MAX never asks for more than the wallet holds', () => {
    for (const balance of [51_001n, 100_000n, 999_997_686n, 1_000n * TARI, 2n ** 70n]) {
      const amount = maxRevealable(balance)
      expect(amount + REVEAL_FEE_RESERVE).toBeLessThanOrEqual(balance)
    }
  })

  it('returns 0n — never a negative — when the balance cannot cover the reserve', () => {
    for (const balance of [0n, 1n, 50_000n, REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE]) {
      expect(maxRevealable(balance)).toBe(0n)
    }
  })

  it('is exact one µtTARI above the reserve', () => {
    expect(maxRevealable(REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE + 1n)).toBe(1n)
  })
})

// ── MAX amount entry — the M2 lesson, which bites harder here ────────────────
//
// M2 found MAX filling the amount field by running the balance through the 2dp DISPLAY formatter,
// which rounds a balance UP past itself. On conceal that produced a withdraw the network refused.
// On reveal the same class of bug is worse in one direction and merely fatal in the other: too
// large and the transaction fails; too small and it SUCCEEDS, publishing a number the user did not
// choose, permanently. So MAX carries the exact bigint, and these pin it.

/** Mirrors microtariToInput in WalletModal.tsx — full precision, no grouping, no rounding. */
const microtariToInput = (µt: bigint): string => {
  const whole = µt / 1_000_000n
  const frac = (µt % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}
/** Mirrors fmtMicrotariExact — the 2dp DISPLAY formatter that must NOT be used for amount entry. */
const fmtDisplay2dp = (µt: bigint): string => {
  const h = (µt + 5_000n) / 10_000n
  return `${(h / 100n).toLocaleString('en-US')}.${(h % 100n).toString().padStart(2, '0')}`
}
const parseTari = (s: string): bigint => BigInt(Math.round(parseFloat(s) * 1_000_000))

describe('MAX must publish the exact number, not a rounded one', () => {
  const PRIVATE = 979_452_310n   // a plausible private balance after a conceal

  it('THE BUG: the 2dp display formatter does not round-trip', () => {
    expect(parseTari(fmtDisplay2dp(PRIVATE).replace(/,/g, ''))).not.toBe(PRIVATE)
  })

  it('the input formatter round-trips exactly', () => {
    expect(microtariToInput(PRIVATE)).toBe('979.45231')
    expect(parseTari(microtariToInput(PRIVATE))).toBe(PRIVATE)
  })

  it.each([0n, 1n, 100_000n, 1_500_000n, 979_452_310n, 999_997_686n, 123_456_789_012n])(
    'round-trips %s µtTARI without drift', (v) => {
      expect(parseTari(microtariToInput(v))).toBe(v)
    })

  it('a MAX-sized reveal is coverable by the balance it came from', () => {
    const amount = maxRevealable(PRIVATE)
    const sel = selectStealthInputs([utxo(PRIVATE)], amount + REVEAL_FEE_RESERVE)
    const split = planReveal(amount, 16_138n, sel.total)
    assertRevealSplit(split)
    expect(split.amount).toBe(amount)
    expect(split.revealedOutput).toBeLessThanOrEqual(PRIVATE)
  })
})

describe('the constants hang together', () => {
  it('the reserve sits above every fee measured on this network', () => {
    // Largest observed real fee to date: 16 138 µtTARI (a send, 2026-08-20).
    expect(REVEAL_FEE_RESERVE).toBeGreaterThan(16_138n)
  })

  it('a wallet at exactly the reveal floor plus the reserve can still reveal the floor', () => {
    const balance = MIN_REVEAL_MICROTARI + REVEAL_FEE_RESERVE
    const sel = selectStealthInputs([utxo(balance)], MIN_REVEAL_MICROTARI + REVEAL_FEE_RESERVE)
    const split = planReveal(MIN_REVEAL_MICROTARI, 16_138n, sel.total)
    assertRevealSplit(split)
    expect(split.amount).toBe(MIN_REVEAL_MICROTARI)
  })
})

// ── What the FORM depends on (M3 C2) ─────────────────────────────────────────
//
// The reveal form's MAX, its ceiling check and its "leaves this much private" note are all one
// number — maxRevealable(privateBalance) — read three ways. These pin the relationships between
// them, so a change to the reserve cannot make the button offer an amount the form then rejects,
// or the note quote a figure that is not what is actually left behind.

describe('the reveal form’s ceiling, MAX and crumb note agree', () => {
  const BALANCES = [980_000_000n, 999_997_686n, 1n * TARI, 51_001n, 2n ** 70n]

  it('MAX always passes the form’s own validation', () => {
    // The form disables Review when `entered > spendCeiling || entered < minAmount`, and MAX sets
    // `entered = spendCeiling`. If those ever disagreed, pressing MAX would grey out the button —
    // the M2 failure in a new place. Checked through the same predicate the form uses.
    const reviewBlocked = (entered: bigint, ceiling: bigint) => entered > ceiling || entered < MIN_REVEAL_MICROTARI
    for (const b of BALANCES) {
      const ceiling = maxRevealable(b)
      if (ceiling < MIN_REVEAL_MICROTARI) continue      // the direction is not offered at all
      expect(reviewBlocked(ceiling, ceiling)).toBe(false)
    }
  })

  it('the crumb the note quotes IS the reserve, exactly', () => {
    // The note renders `privateAmount - spendCeiling`. It must equal what CP1 holds back, or the
    // user is told a number that does not match the balance they are left with.
    for (const b of BALANCES) {
      if (maxRevealable(b) === 0n) continue
      expect(b - maxRevealable(b)).toBe(REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE)
    }
  })

  it('a MAX reveal is buildable end to end at a realistic fee', () => {
    for (const b of BALANCES) {
      const amount = maxRevealable(b)
      if (amount < MIN_REVEAL_MICROTARI) continue
      const sel = selectStealthInputs([utxo(b)], amount + REVEAL_FEE_RESERVE)
      const split = planReveal(amount, 16_138n, sel.total)
      assertRevealSplit(split)
      expect(split.amount).toBe(amount)                       // published: exactly what MAX offered
      expect(split.changeAmount).toBeGreaterThan(0n)          // never the zero-output path
    }
  })

  it('the entry point only offers reveal when MAX clears the floor', () => {
    // `canReveal = maxRevealable(private) >= MIN_REVEAL_MICROTARI`. Below that the card must not
    // offer the direction at all, rather than offering it and refusing at the first step.
    const justBelow = MIN_REVEAL_MICROTARI + REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE - 1n
    const justAt = MIN_REVEAL_MICROTARI + REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE
    expect(maxRevealable(justBelow) >= MIN_REVEAL_MICROTARI).toBe(false)
    expect(maxRevealable(justAt) >= MIN_REVEAL_MICROTARI).toBe(true)
  })

  it('the input formatter round-trips MAX exactly at every realistic balance', () => {
    // MEASURED, not assumed: the float path round-trips exactly well below ~1e16 µtTARI (about
    // 10 million TARI), and starts drifting value-by-value as it approaches Number.MAX_SAFE_INTEGER
    // rather than at a clean threshold. Every balance a wallet can plausibly hold sits orders of
    // magnitude under that; the case that does not is pinned separately below.
    for (const b of [51_001n, 1n * TARI, 980_000_000n, 999_997_686n, 123_456_789_012n, 100_000_000_000_000n]) {
      const ceiling = maxRevealable(b)
      if (ceiling === 0n) continue
      expect(parseTari(microtariToInput(ceiling))).toBe(ceiling)
    }
  })

  it('WHY MAX CARRIES THE BIGINT: the float re-parse drifts at extreme scale', () => {
    // microtariToInput itself is exact bigint arithmetic and never drifts. parseFloat does — past
    // roughly 2^53 hundredths of a TARI the decimal string cannot be recovered as a double.
    //
    // The UI never takes that round-trip for MAX: `moveExact` holds the exact bigint and
    // handlePrepareMove reads `moveExact ?? tariToMicrotari(parseFloat(moveAmount))`, so the string
    // is only ever what the user SEES. This test exists to keep that rail honest — if someone
    // "simplifies" the form to re-parse its own field, the number below is what would be published.
    // u64 max — above any plausible balance, but the whole TARI supply is the same order of
    // magnitude (~1.8e19 µtTARI), so this is the boundary the rail actually has to survive.
    const ceiling = maxRevealable(18_446_744_073_709_551_615n)
    const roundTripped = parseTari(microtariToInput(ceiling))
    expect(roundTripped).not.toBe(ceiling)
    expect(roundTripped).toBeLessThan(ceiling)   // silently reveals LESS than MAX offered
  })
})
