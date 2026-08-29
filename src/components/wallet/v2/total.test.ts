// Tests for the combined-balance rules (M7).
//
// The arithmetic here is trivial — one addition. Everything worth testing is the REFUSAL to do that
// addition: the two ways a balance can be untrustworthy without the sum knowing, and the difference
// between "a number is coming" and "we can't read this".

import { describe, expect, it } from 'vitest'
import { computeTotal, incompleteAvailableNote, unreadableReasonText, type BalanceStatus, type TotalInputs } from './total'

const ready = (v: bigint): BalanceStatus => ({ status: 'ready', microtari: v })
const LOADING: BalanceStatus = { status: 'loading' }
const OUT: BalanceStatus = { status: 'unavailable' }

const inputs = (over: Partial<TotalInputs> = {}): TotalInputs => ({
  privateBalance: ready(348_862_232n),
  privateIncomplete: false,
  publicBalance: ready(700_997_686n),
  settling: false,
  settleLagged: false,
  // The default pair is from ONE refresh, so every case written before the freshness rule keeps
  // testing exactly what it did. The mismatch cases set these explicitly.
  privateGeneration: 1,
  publicGeneration: 1,
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
  // ── THIS PAIR USED TO ASSERT THE BUG ────────────────────────────────────────
  //
  // The first once read "settling with both sides readable KEEPS the number, marked in flight",
  // and passed, and was wrong: a settle is precisely when the two sides are mid-transition, so the
  // number it kept was a sum across two different moments. The second was built on the same
  // mistaken premise — that a settle leaves both reads loading, so the case would rarely arise.
  // The private scan completes instead, on a stale listing, and the sum was computable throughout.
  //
  // Both now assert the corrected rule, which has no exceptions: a settling total has no number.
  it('settling with both sides readable STILL has no number', () => {
    expect(computeTotal(inputs({ settling: true }))).toEqual({ status: 'settling' })
  })

  it('settling mid-rescan has no number either — the two cases are one case', () => {
    expect(computeTotal(inputs({ settling: true, privateBalance: LOADING, publicBalance: LOADING })))
      .toEqual({ status: 'settling' })
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
    // Distinct matchers, and now genuinely distinct: the old pair leaned on "unshielded"
    // containing "shielded", so the private matcher would have passed on the public string.
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

// ── MAX and the total must not contradict each other (M9 C8) ─────────────────
//
// The cold read found the modal making two incompatible claims about one truncated scan at the
// same moment: the hero refused a total because "a total would be too low", while MAX — computed
// from that identical partial set — offered a confident figure and said nothing. These pin the
// agreement, because the two strings live in different functions and nothing but a test stops them
// drifting apart again.

describe('incompleteAvailableNote', () => {
  it('says the same thing the total says about the same condition', () => {
    const note = incompleteAvailableNote()
    const total = unreadableReasonText('private-incomplete')
    // Both must name the cause — a private balance that could not be read in full — and must name
    // it in the SAME WORDS. The vocabulary is part of the invariant, not incidental to it: two
    // strings agreeing on the fact while calling the balance different things is how a user ends
    // up believing there are two balances.
    for (const s of [note, total]) expect(s).toMatch(/couldn’t read all of your private balance/i)
  })

  it('does NOT withdraw the figure the way the total does', () => {
    // The asymmetry is deliberate and is the reason these are two strings and not one. A lower-
    // bound TOTAL is wrong. A lower-bound MAXIMUM is still spendable — every output it counted is
    // one we really hold — so the note qualifies it instead of refusing it.
    expect(incompleteAvailableNote()).toMatch(/safe to send/i)
    expect(unreadableReasonText('private-incomplete')).toMatch(/too low/i)
  })

  it('carries no jargon, like every other string on this screen', () => {
    expect(incompleteAvailableNote()).not.toMatch(/µtTARI|UTXO|output|indexer|substate|scan/i)
  })

  it('is about the MAXIMUM, not about a balance being wrong', () => {
    expect(incompleteAvailableNote()).toMatch(/maximum/i)
  })
})

// ── FRESHNESS: two ready balances are not necessarily two current balances ────
//
// `ready` says a read SUCCEEDED. It says nothing about WHEN. The public balance is two keyed
// substate lookups and comes back in milliseconds; the private balance is a global /utxos listing
// that trails consensus by 60–90 seconds and is then trial-decrypted row by row. On unlock they do
// not even start together.
//
// So there is always a window where one figure has moved on and the other has not, and adding them
// is arithmetic across two different moments. After a reveal it produces a total that counts the
// moved amount on BOTH sides: specific, plausible, too large, and rendered as fact.
//
// Waiting for both sides of a move closes that window for a move. It cannot close it for a
// background refresh, a reopened modal or an unlock — no transaction is pending in any of those.
// The generation stamp closes all of them, structurally.

describe('mismatched generations are never summed', () => {
  it('THE RESIDUAL FLASH: private at gen N, public already at gen N+1 → updating, not 1100', () => {
    // The exact pair seen in the browser after a reveal: the public read has landed and the scan
    // has not caught up. 900 + 199 = 1099 is arithmetic on two different moments.
    const t = computeTotal(inputs({
      privateBalance: ready(900_000_000n), privateGeneration: 1,
      publicBalance: ready(199_000_000n), publicGeneration: 2,
    }))
    expect(t).toEqual({ status: 'settling' })
    // The wrong figure must not appear anywhere in the result, not even as a caveated number.
    expect(JSON.stringify(t)).not.toContain('1099')
  })

  it('offers NO number at all while the stamps disagree', () => {
    const t = computeTotal(inputs({ privateGeneration: 3, publicGeneration: 4 }))
    expect(t.status).toBe('settling')
    // Not "null microtari" any more — there is no such field. See the settling variant.
    expect(t).not.toHaveProperty('microtari')
  })

  it('mismatch in the other direction is equally disqualifying', () => {
    // Private can be the newer one too — a scan that finishes while a revealed read is retrying.
    expect(computeTotal(inputs({ privateGeneration: 5, publicGeneration: 4 })).status).toBe('settling')
  })

  it('reports SETTLING rather than unreadable — a correct number really is coming', () => {
    // "—" says nothing is pending and no amount of waiting fixes it. That would be a lie here:
    // the newer read is in flight and will resolve on its own.
    const t = computeTotal(inputs({ privateGeneration: 1, publicGeneration: 2 }))
    expect(t.status).not.toBe('unreadable')
    expect(t.status).toBe('settling')
  })

  it('MATCHED generations give the real total', () => {
    expect(computeTotal(inputs({
      privateBalance: ready(900_000_000n), publicBalance: ready(199_000_000n),
      privateGeneration: 2, publicGeneration: 2,
    }))).toEqual({ status: 'ready', microtari: 1_099_000_000n })
  })

  it('the same pair one generation later is still a real total — the guard is about equality, not size', () => {
    expect(computeTotal(inputs({ privateGeneration: 99, publicGeneration: 99 })).status).toBe('ready')
  })

  it('generation 0 on both sides is matched, not a special case', () => {
    // Both untouched since init. Nothing has refreshed, so nothing disagrees.
    expect(computeTotal(inputs({ privateGeneration: 0, publicGeneration: 0 })).status).toBe('ready')
  })

  it('UNREADABLE still outranks a stale pair', () => {
    // A definite failure beats work in progress, whatever the stamps say. "updating…" over a side
    // that cannot be read promises a number that is not coming.
    expect(computeTotal(inputs({
      publicBalance: OUT, privateGeneration: 1, publicGeneration: 2,
    }))).toEqual({ status: 'unreadable', reason: 'public-unavailable' })
  })

  it('an incomplete scan still outranks a stale pair', () => {
    expect(computeTotal(inputs({
      privateIncomplete: true, privateGeneration: 1, publicGeneration: 2,
    })).status).toBe('unreadable')
  })

  it('a stale pair reads as settling even with no transaction pending', () => {
    // The background-refresh case, which the settle watches cannot reach at all.
    expect(computeTotal(inputs({ settling: false, privateGeneration: 7, publicGeneration: 8 })).status)
      .toBe('settling')
  })

  it('a loading side with a stale stamp still yields no number', () => {
    expect(computeTotal(inputs({
      privateBalance: LOADING, privateGeneration: 1, publicGeneration: 2,
    }))).toEqual({ status: 'settling' })
  })

  it('every existing rule is unchanged when the pair is fresh', () => {
    // The regression guard for the whole file: same generation → the pre-freshness behaviour.
    expect(computeTotal(inputs()).status).toBe('ready')
    expect(computeTotal(inputs({ settling: true })).status).toBe('settling')
    expect(computeTotal(inputs({ privateBalance: LOADING })).status).toBe('loading')
    expect(computeTotal(inputs({ privateBalance: OUT })).status).toBe('unreadable')
  })
})

// ── THE TEST THAT SHOULD HAVE BEEN WRITTEN FIRST ─────────────────────────────
//
// The freshness stamp shipped with tests that all passed and a bug that survived, because they
// tested the rule that was built (different generations → no number) rather than the scenario that
// produced the failure (SAME generation, inconsistent data). The scenario is the thing.
//
// After a reveal, both figures come from the same rescan. The public read reflects consensus now;
// the private scan COMPLETES — `done`, not `incomplete`, indistinguishable from any good read —
// against a listing that still contains the outputs the transaction spent. Same generation, both
// ready, and a computable sum that counts the moved amount twice.

describe('a settle window offers NO NUMBER, whatever the generations say', () => {
  // 850.25 private (stale — still listing the spent outputs) + 249.95 public (already updated).
  // The pair that rendered 1100.207422 above the words "updating after your last move…".
  const STALE_PRIVATE = 850_250_000n
  const FRESH_PUBLIC = 249_957_422n

  const midSettle = (over: Partial<TotalInputs> = {}) => inputs({
    privateBalance: ready(STALE_PRIVATE), publicBalance: ready(FRESH_PUBLIC),
    privateGeneration: 4, publicGeneration: 4,      // SAME refresh — the stamp cannot help here
    settling: true,
    ...over,
  })

  it('THE BUG: stale-but-done private + fresh public, same generation, settle pending → no number', () => {
    expect(computeTotal(midSettle())).toEqual({ status: 'settling' })
  })

  it('the wrong figure is not merely hidden — it is never computed', () => {
    // `settling` is returned BEFORE the sum, so 1100.207422 does not exist at any point.
    expect(JSON.stringify(computeTotal(midSettle()))).not.toContain('1100')
    expect(JSON.stringify(computeTotal(midSettle()))).not.toContain('microtari')
  })

  it('carries no number even when both sides are perfectly readable', () => {
    // There is nothing WRONG with either figure. They are simply from two different moments, and
    // that is enough — a settling total has no honest value to report.
    expect(computeTotal(midSettle({ privateBalance: ready(1n), publicBalance: ready(2n) })))
      .toEqual({ status: 'settling' })
  })

  it('the settling variant has no microtari field at all', () => {
    // The type makes it unrepresentable; this pins the runtime shape so a render site cannot read
    // a stray property back out.
    expect(Object.keys(computeTotal(midSettle()))).toEqual(['status'])
  })
})

// ── LAGGED: after the deadline, still no confident number ───────────────────
//
// Before this, a passed deadline flipped `settling` off and the total went straight to `ready`
// over the same inconsistent pair it had spent 150 seconds refusing to add — the wrong figure,
// now with no spinner and no caption. Strictly worse than the bug during the window.

describe('a lagged settle is unreadable, not ready', () => {
  const lagged = (over: Partial<TotalInputs> = {}) => inputs({
    privateBalance: ready(850_250_000n), publicBalance: ready(249_957_422n),
    settling: false, settleLagged: true,
    ...over,
  })

  it('deadline passed, pair still inconsistent → unreadable with a reason, NOT the wrong sum', () => {
    expect(computeTotal(lagged())).toEqual({ status: 'unreadable', reason: 'settle-lagged' })
  })

  it('is NOT reported as settling — nothing is polling, so no number is coming on its own', () => {
    expect(computeTotal(lagged()).status).not.toBe('settling')
  })

  it('the reason says the money moved, and names the one action that fixes it', () => {
    const text = unreadableReasonText('settle-lagged')
    expect(text).toMatch(/went through/i)          // never "something went wrong" — nothing did
    expect(text).toMatch(/Refresh/)
    expect(text).not.toMatch(/failed|error|lost/i)
  })

  it('carries no jargon, like every other reason', () => {
    expect(unreadableReasonText('settle-lagged')).not.toMatch(/µtTARI|UTXO|output|indexer|substate|settle/i)
  })

  it('outranks a settling window, because it is a definite failure to observe', () => {
    expect(computeTotal(lagged({ settling: true })).status).toBe('unreadable')
  })

  it('an unavailable side still wins — that reason is more specific and more actionable', () => {
    expect(computeTotal(lagged({ privateBalance: OUT })).status).toBe('unreadable')
  })

  it('clears to a real total once the flag drops — a Refresh resolves it', () => {
    // settleLagged is measured against the BALANCES, not the status: when a read finally shows both
    // sides moved, the entry is accounted for and the total unblocks on its own.
    expect(computeTotal(lagged({ settleLagged: false })))
      .toEqual({ status: 'ready', microtari: 1_100_207_422n })
  })
})

describe('the normal case still works (regression)', () => {
  it('matched generations, consistent pair, nothing outstanding → the real total', () => {
    expect(computeTotal(inputs({
      privateBalance: ready(800_250_000n), publicBalance: ready(249_957_422n),
      privateGeneration: 9, publicGeneration: 9, settling: false, settleLagged: false,
    }))).toEqual({ status: 'ready', microtari: 1_050_207_422n })
  })

  it('the held-value window the stamp genuinely closes still fires', () => {
    // The public row is showing a figure read at generation 3 while the scan has completed at 4.
    // No transaction is pending, so the settle watches never see this — the stamp is what catches
    // it, and it is the one window that is really its own.
    expect(computeTotal(inputs({
      privateGeneration: 4, publicGeneration: 3, settling: false, settleLagged: false,
    }))).toEqual({ status: 'settling' })
  })

  it('loading and unreadable are untouched by either new rule', () => {
    expect(computeTotal(inputs({ privateBalance: LOADING })).status).toBe('loading')
    expect(computeTotal(inputs({ privateBalance: OUT })).status).toBe('unreadable')
    expect(computeTotal(inputs({ privateIncomplete: true })).status).toBe('unreadable')
  })
})
