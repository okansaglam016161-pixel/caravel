// Tests for the settle decisions (M2, extended in the settle-lifecycle milestone).
//
// The loop itself is effect wiring and this project has no DOM renderer in its unit suite, so the
// rules it applies live in pure functions and are tested directly. Those rules are what decide
// whether a user is told their transaction worked — the interval plumbing around them is not where
// the risk is.
//
// The single-balance cases below are unchanged from when they tested the hook; only the import
// moved. That is the point of the CP1 hoist: the DECISIONS did not change, their owner did.
//
// The rescan-lease cases that used to sit here are GONE, and their absence is the fix rather than
// a gap. The lease existed to arbitrate between three loops that each fired the global rescan on
// its own timer; the entries now share one list polled by one interval, so there is nothing left
// to arbitrate. See settle.ts.

import { describe, expect, it } from 'vitest'
import {
  advanceAll, advanceSettle, acknowledged, anySettling, balanceFor, settleAction, settleAllAction,
  isAccountedFor, watchDelta, withSettle, type PendingSettle, type SideBalances, type SettleWatch,
} from './settle'

const NOW = 1_700_000_000_000
const LATER = NOW + 150_000     // inside the window
const PASSED = NOW - 1          // deadline already gone

describe('settleAction', () => {
  it('reports a rise', () => {
    expect(settleAction(985_544n, 0n, NOW, LATER)).toBe('settled')
  })

  it('keeps waiting while the balance is unchanged and the window is open', () => {
    expect(settleAction(0n, 0n, NOW, LATER)).toBe('wait')
  })

  it('reports the deadline once the window closes without movement', () => {
    expect(settleAction(0n, 0n, NOW, PASSED)).toBe('deadline')
  })

  it('A RISE BEATS AN EXPIRED DEADLINE', () => {
    // The ordering that matters: an output appearing in the same instant the deadline passes is a
    // success, and must not be reported as a lag.
    expect(settleAction(985_544n, 0n, NOW, PASSED)).toBe('settled')
  })

  it('treats an unknown balance as no movement, never as zero', () => {
    // null means a scan is in flight or failed. Reading it as 0 would let a failed scan masquerade
    // as a balance that never moved — and, against a non-zero `before`, as a balance that fell.
    expect(settleAction(null, 0n, NOW, LATER)).toBe('wait')
    expect(settleAction(null, 500n, NOW, LATER)).toBe('wait')
    expect(settleAction(null, 0n, NOW, PASSED)).toBe('deadline')
  })

  it('requires a STRICT rise — an unchanged balance is not settlement', () => {
    expect(settleAction(500n, 500n, NOW, LATER)).toBe('wait')
    expect(settleAction(499n, 500n, NOW, LATER)).toBe('wait')   // a fall is not a rise either
  })

  it('detects a rise from a non-zero starting balance', () => {
    // The conceal case on a wallet that already held private funds.
    expect(settleAction(1_985_544n, 1_000_000n, NOW, LATER)).toBe('settled')
  })

  it('detects a one-microtari rise', () => {
    expect(settleAction(1n, 0n, NOW, LATER)).toBe('settled')
  })

  it('is exact past Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n
    expect(settleAction(big + 1n, big, NOW, LATER)).toBe('settled')
    expect(settleAction(big, big, NOW, LATER)).toBe('wait')
  })
})

// ── Watching a FALL — the send case ──────────────────────────────────────────
//
// A send has no rise to watch: the money leaves. The only local evidence it landed is the
// spent-from balance dropping, so the same loop runs with the comparison flipped.

describe('settleAction — direction: fall', () => {
  it('settles when the balance drops', () => {
    expect(settleAction(4_000_000n, 5_000_000n, NOW, LATER, 'fall')).toBe('settled')
  })

  it('waits while the balance is unchanged', () => {
    expect(settleAction(5_000_000n, 5_000_000n, NOW, LATER, 'fall')).toBe('wait')
  })

  it('waits if the balance ROSE — that is not this transaction landing', () => {
    expect(settleAction(6_000_000n, 5_000_000n, NOW, LATER, 'fall')).toBe('wait')
  })

  it('a drop still wins over an expired deadline', () => {
    expect(settleAction(4_000_000n, 5_000_000n, NOW, PASSED, 'fall')).toBe('settled')
  })

  it('AN UNKNOWN BALANCE NEVER COUNTS AS A SPEND', () => {
    // The trap this direction introduces: `null` must not be read as zero, because zero is BELOW
    // any positive `before` and a failed scan would look exactly like a completed send.
    expect(settleAction(null, 5_000_000n, NOW, LATER, 'fall')).toBe('wait')
    expect(settleAction(null, 5_000_000n, NOW, PASSED, 'fall')).toBe('deadline')
  })

  it('detects a one-microtari drop', () => {
    expect(settleAction(4_999_999n, 5_000_000n, NOW, LATER, 'fall')).toBe('settled')
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n
    expect(settleAction(big - 1n, big, NOW, LATER, 'fall')).toBe('settled')
    expect(settleAction(big, big, NOW, LATER, 'fall')).toBe('wait')
  })

  it('defaults to rise when no direction is given — every existing caller is unchanged', () => {
    expect(settleAction(6n, 5n, NOW, LATER)).toBe('settled')
    expect(settleAction(4n, 5n, NOW, LATER)).toBe('wait')
  })
})

// ── F3: an unknown baseline is not zero ──────────────────────────────────────
//
// Found by the M9 integration pass. The baseline used to default to 0n when the watched read had
// not settled, which breaks BOTH directions in opposite ways — and both silently.

describe('settleAction — a null baseline', () => {
  it('RISE: never reports a success it has not seen', () => {
    // With before = 0n this returned 'settled' on the first poll, because any real balance is
    // above zero — a false success for a transaction whose effect had not landed.
    expect(settleAction(700_000_000n, null, NOW, LATER, 'rise')).toBe('wait')
    expect(settleAction(0n, null, NOW, LATER, 'rise')).toBe('wait')
  })

  it('FALL: waits rather than settling on a phantom drop', () => {
    expect(settleAction(4_000_000n, null, NOW, LATER, 'fall')).toBe('wait')
  })

  it('still reports the lag once the deadline passes, in both directions', () => {
    // The honest outcome: the transaction committed, we could not verify it locally.
    expect(settleAction(700_000_000n, null, NOW, PASSED, 'rise')).toBe('deadline')
    expect(settleAction(4_000_000n, null, NOW, PASSED, 'fall')).toBe('deadline')
  })

  it('both unknown is still just a wait', () => {
    expect(settleAction(null, null, NOW, LATER)).toBe('wait')
    expect(settleAction(null, null, NOW, PASSED)).toBe('deadline')
  })

  it('a known baseline of zero still works — zero is a real balance', () => {
    // The fix must not confuse "no baseline" with "a baseline that happens to be zero".
    expect(settleAction(1n, 0n, NOW, LATER, 'rise')).toBe('settled')
    expect(settleAction(0n, 1n, NOW, LATER, 'fall')).toBe('settled')
  })
})

// ── The entry list: what the hoist actually buys ─────────────────────────────
//
// These are the two bugs the hoist exists to fix, expressed as rules rather than as a rendered
// screen. Neither could be stated at all while the loop lived in a component: its lifetime WAS the
// component's, so "does it survive Done" had no answer in code, only in behaviour.

const B = (priv: bigint | null, pub: bigint | null): SideBalances => ({ private: priv, public: pub })
const watch = (side: 'private' | 'public', direction: 'rise' | 'fall', before: bigint | null): SettleWatch =>
  ({ side, direction, before })
const entry = (over: Partial<PendingSettle> = {}): PendingSettle => ({
  txId: 'tx1', kind: 'move', watches: [watch('private', 'rise', 100n)],
  deadlineAt: LATER, status: 'settling', delta: null, ...over,
})

describe('balanceFor', () => {
  it('reads the side a watch names', () => {
    expect(balanceFor('private', B(10n, 20n))).toBe(10n)
    expect(balanceFor('public', B(10n, 20n))).toBe(20n)
  })
  it('passes an unknown reading through as null, never as zero', () => {
    expect(balanceFor('private', B(null, 20n))).toBeNull()
    expect(balanceFor('public', B(10n, null))).toBeNull()
  })
})

describe('advanceSettle', () => {
  it('settles when the watched balance moves, and records the delta', () => {
    const out = advanceSettle(entry(), B(174n, null), NOW)
    expect(out.status).toBe('settled')
    expect(out.delta).toBe(74n)
  })

  it('waits while the balance has not moved', () => {
    expect(advanceSettle(entry(), B(100n, null), NOW).status).toBe('settling')
  })

  it('a passed deadline is LAGGED, which is a success — and carries no delta', () => {
    const out = advanceSettle(entry({ deadlineAt: NOW - 1 }), B(100n, null), NOW)
    expect(out.status).toBe('lagged')
    // Nothing was observed to move, so there is no measurement to report. Inventing one here is
    // how a screen ends up claiming a specific amount it never saw arrive.
    expect(out.delta).toBeNull()
  })

  it('returns the SAME OBJECT when nothing changed, so a no-op cannot cause a re-render', () => {
    const e = entry()
    expect(advanceSettle(e, B(100n, null), NOW)).toBe(e)
  })

  it('NEVER re-opens a resolved entry', () => {
    // A later scan can read lower than the one that settled — a truncated listing, a competing
    // spend. Walking a landed transaction back to "still settling" would restart the poll and
    // un-tell the user something that was true.
    const settled = entry({ status: 'settled', delta: 74n })
    expect(advanceSettle(settled, B(0n, null), NOW + 10_000_000)).toBe(settled)
  })

  it('an unknown balance never settles anything', () => {
    expect(advanceSettle(entry(), B(null, null), NOW).status).toBe('settling')
  })

  it('an unknown BASELINE waits out the deadline rather than inventing a verdict', () => {
    const e = entry({ watches: [watch('private', 'rise', null)] })
    expect(advanceSettle(e, B(999n, null), NOW).status).toBe('settling')
    expect(advanceSettle(e, B(999n, null), LATER + 1).status).toBe('lagged')
  })
})

describe('advanceAll', () => {
  it('advances every entry independently', () => {
    const out = advanceAll(
      [entry({ txId: 'a' }), entry({ txId: 'b', watches: [watch('public', 'fall', 200n)] })],
      B(174n, 150n), NOW,
    )
    expect(out.map(e => e.status)).toEqual(['settled', 'settled'])
  })

  it('returns the SAME ARRAY when nothing moved', () => {
    const list = [entry()]
    expect(advanceAll(list, B(100n, null), NOW)).toBe(list)
  })

  it('one settling entry does not resolve another', () => {
    const out = advanceAll([entry({ txId: 'a' }), entry({ txId: 'b', watches: [watch('public', 'rise', 50n)] })], B(174n, 50n), NOW)
    expect(out.map(e => e.status)).toEqual(['settled', 'settling'])
  })
})

describe('anySettling — what keeps the poll alive', () => {
  it('is true while one entry waits', () => {
    expect(anySettling([entry({ status: 'settled' }), entry({ txId: 'b' })])).toBe(true)
  })
  it('is false once everything has resolved, so the interval stops', () => {
    expect(anySettling([entry({ status: 'settled' }), entry({ txId: 'b', status: 'lagged' })])).toBe(false)
  })
  it('is false with nothing pending', () => {
    expect(anySettling([])).toBe(false)
  })
})

describe('withSettle', () => {
  it('adds an entry', () => {
    expect(withSettle([], entry()).map(e => e.txId)).toEqual(['tx1'])
  })
  it('REPLACES an entry for the same transaction rather than stacking a second', () => {
    // On a retry the same txId must not leave a first attempt polling forever against a baseline
    // that no longer means anything.
    const out = withSettle([entry({ deadlineAt: 1 })], entry({ deadlineAt: 999 }))
    expect(out).toHaveLength(1)
    expect(out[0].deadlineAt).toBe(999)
  })
  it('leaves other transactions alone — a move and a send can settle at once', () => {
    expect(withSettle([entry({ txId: 'move1' })], entry({ txId: 'send1', kind: 'send' })).map(e => e.txId))
      .toEqual(['move1', 'send1'])
  })
})

describe('acknowledged — the Done-mid-settle rule', () => {
  it('drops a SETTLED entry the user has seen', () => {
    expect(acknowledged([entry({ status: 'settled' })], 'tx1')).toEqual([])
  })

  it('REFUSES to drop one that is still settling', () => {
    // THE BUG THIS FIXES. Pressing Done used to switch the loop off, and the overview it returned
    // to kept a stale balance with nothing polling to correct it. Done finishes the SCREEN; the
    // transaction is not finished, so the entry stays and the poll carries on.
    const list = [entry()]
    expect(acknowledged(list, 'tx1')).toEqual(list)
  })

  it('keeps the poll alive after Done — the self-correcting overview, in one assertion', () => {
    const after = acknowledged([entry()], 'tx1')
    expect(anySettling(after)).toBe(true)
  })

  it('only drops the transaction named', () => {
    const out = acknowledged([entry({ txId: 'a', status: 'settled' }), entry({ txId: 'b', status: 'settled' })], 'a')
    expect(out.map(e => e.txId)).toEqual(['b'])
  })

  it('an entry survives being acknowledged early and still resolves later', () => {
    // Done pressed at t+5s, the balance lands at t+40s. The entry must still be there to see it.
    const afterDone = acknowledged([entry()], 'tx1')
    expect(advanceAll(afterDone, B(174n, null), NOW)[0].status).toBe('settled')
  })
})

describe('watchDelta', () => {
  it('is absolute in both directions, so a caller need not know which way it watched', () => {
    expect(watchDelta(watch('private', 'rise', 100n), B(174n, null))).toBe(74n)
    expect(watchDelta(watch('private', 'fall', 174n), B(100n, null))).toBe(74n)
  })
  it('is null when either end is unknown', () => {
    expect(watchDelta(watch('private', 'rise', null), B(174n, null))).toBeNull()
    expect(watchDelta(watch('private', 'rise', 100n), B(null, null))).toBeNull()
  })
})

describe('settleAllAction with a single watch matches the old single-balance rule', () => {
  it.each([
    ['moved', 174n, 'settled'],
    ['unmoved', 100n, 'wait'],
  ])('%s', (_l, now, expected) => {
    expect(settleAllAction([watch('private', 'rise', 100n)], B(now as bigint, null), NOW, LATER)).toBe(expected)
  })

  it('an EMPTY watch list can never settle — it waits, then reports the lag', () => {
    // A settle with nothing to watch is a programming error. The safe reading of it is "cannot
    // confirm", never "confirmed".
    expect(settleAllAction([], B(1n, 1n), NOW, LATER)).toBe('wait')
    expect(settleAllAction([], B(1n, 1n), LATER + 1, LATER)).toBe('deadline')
  })
})

// ── TWO-SIDED MOVES ──────────────────────────────────────────────────────────
//
// A move is one transaction with two visible effects that do not arrive together: the public
// balance is two keyed substate lookups and is consensus-fresh, the private balance is a global
// /utxos listing that trails by 60–90 seconds. There is therefore a window in which one side has
// updated and the other has not, and during it the pair is genuinely inconsistent.
//
// Settling on whichever side arrives first ends the settle INSIDE that window. On a reveal — which
// watched the fast side — the public rise ended the settle, the total dropped out of "updating…",
// and the private side was still counting the amount it had just spent. The hero showed 974 + 149
// = 1123 for a wallet holding 1050, as fact, and never corrected itself because ending the settle
// also stopped the poll.
//
// These are that bug, as rules.

const REVEAL_WATCHES: SettleWatch[] = [
  { side: 'public', direction: 'rise', before: 75n },
  { side: 'private', direction: 'fall', before: 974n },
]
const CONCEAL_WATCHES: SettleWatch[] = [
  { side: 'private', direction: 'rise', before: 900n },
  { side: 'public', direction: 'fall', before: 149n },
]

describe('a reveal settles only when BOTH sides have moved', () => {
  const reveal = (over: Partial<PendingSettle> = {}) => entry({ watches: REVEAL_WATCHES, ...over })

  it('THE BUG: public rose, private still stale → NOT settled', () => {
    // 974 private (pre-reveal, still listing the spent outputs) + 149 public (already updated).
    // This is the exact reading that produced the confident 1123.
    expect(advanceSettle(reveal(), B(974n, 149n), NOW).status).toBe('settling')
  })

  it('settles once private catches up too', () => {
    expect(advanceSettle(reveal(), B(900n, 149n), NOW).status).toBe('settled')
  })

  it('private falling first is not enough either — the rule is symmetric', () => {
    expect(advanceSettle(reveal(), B(900n, 75n), NOW).status).toBe('settling')
  })

  it('neither side moved → still settling', () => {
    expect(advanceSettle(reveal(), B(974n, 75n), NOW).status).toBe('settling')
  })

  it('a one-sided move stays settling right up to the deadline, then reports the lag', () => {
    // It never claims success on half the evidence, and it never claims failure either.
    expect(advanceSettle(reveal(), B(974n, 149n), LATER - 1).status).toBe('settling')
    expect(advanceSettle(reveal(), B(974n, 149n), LATER + 1).status).toBe('lagged')
  })

  it('keeps the poll alive through the whole one-sided window — so it self-corrects', () => {
    // THE OTHER HALF OF THE FIX. The wrong total froze because ending the settle stopped the
    // rescans. While this stays true the loop keeps scanning until private catches up.
    const half = advanceAll([reveal()], B(974n, 149n), NOW)
    expect(anySettling(half)).toBe(true)
    expect(anySettling(advanceAll(half, B(900n, 149n), NOW))).toBe(false)
  })

  it('reports the delta from the side that ROSE, not the side that fell', () => {
    // The private side falls by amount + fee; the public side rises by the amount. "74 is now
    // public" is the true statement, so the rising watch is listed first.
    expect(advanceSettle(reveal(), B(900n, 149n), NOW).delta).toBe(74n)
  })
})

describe('a conceal settles only when BOTH sides have moved', () => {
  const conceal = (over: Partial<PendingSettle> = {}) => entry({ watches: CONCEAL_WATCHES, ...over })

  it('public fell but private has not risen → NOT settled', () => {
    // Conceal never SHOWED the bug because it happened to watch the slow side and was still
    // waiting through this window. It was protected by luck; now it is protected on purpose.
    expect(advanceSettle(conceal(), B(900n, 75n), NOW).status).toBe('settling')
  })

  it('settles when private rises and public falls', () => {
    expect(advanceSettle(conceal(), B(974n, 75n), NOW).status).toBe('settled')
  })

  it('private rose but public has not fallen → NOT settled', () => {
    expect(advanceSettle(conceal(), B(974n, 149n), NOW).status).toBe('settling')
  })

  it('reports the delta from the rising private side', () => {
    expect(advanceSettle(conceal(), B(974n, 75n), NOW).delta).toBe(74n)
  })
})

describe('an unknown reading blocks a two-sided settle', () => {
  it('a settled public side cannot carry an unknown private side', () => {
    // A failed or in-flight scan is "we do not know", and half a verdict is not a verdict.
    expect(advanceSettle(entry({ watches: REVEAL_WATCHES }), B(null, 149n), NOW).status).toBe('settling')
  })

  it('an unknown public side blocks it from the other direction', () => {
    expect(advanceSettle(entry({ watches: REVEAL_WATCHES }), B(900n, null), NOW).status).toBe('settling')
  })
})

describe('sends and faucet claims stay SINGLE-sided', () => {
  it('a send moves one balance, so one watch settles it', () => {
    // The recipient's output is theirs, not ours — there is no second side of ours to wait for,
    // and adding one would make every send wait out the full deadline.
    const send = entry({ kind: 'send', watches: [{ side: 'private', direction: 'fall', before: 500n }] })
    expect(advanceSettle(send, B(400n, 149n), NOW).status).toBe('settled')
  })

  it('a public send watches the vault fall, and ignores the private side entirely', () => {
    const send = entry({ kind: 'send', watches: [{ side: 'public', direction: 'fall', before: 149n }] })
    expect(advanceSettle(send, B(974n, 100n), NOW).status).toBe('settled')
  })

  it('a faucet claim settles on the private rise alone', () => {
    const claim = entry({ kind: 'faucet', watches: [{ side: 'private', direction: 'rise', before: 0n }] })
    expect(advanceSettle(claim, B(1_000n, null), NOW).status).toBe('settled')
    expect(advanceSettle(claim, B(1_000n, null), NOW).delta).toBe(1_000n)
  })
})

describe('a move and a send can settle at once without interfering', () => {
  it('the move waits for both its sides while the send resolves on one', () => {
    const list = [
      entry({ txId: 'move1', watches: REVEAL_WATCHES }),
      entry({ txId: 'send1', kind: 'send', watches: [{ side: 'private', direction: 'fall', before: 974n }] }),
    ]
    // Private fell (the send landed) but public has not risen, so the move is not done.
    const out = advanceAll(list, B(900n, 75n), NOW)
    expect(out.map(e => e.status)).toEqual(['settling', 'settled'])
    expect(anySettling(out)).toBe(true)
  })
})

// ── LAGGED IS AN ADMISSION, NOT A VERDICT ────────────────────────────────────
//
// "Committed, and we could not confirm it in the time we allowed." Two things follow, and both are
// what stops the total going confidently wrong after the deadline: the entry is not dropped when
// the user dismisses the message, and it completes on its own the moment a read finally shows the
// balances moved.

describe('a lagged entry completes when the data catches up', () => {
  const laggedReveal = () => entry({ status: 'lagged', watches: REVEAL_WATCHES })

  it('stays lagged while the pair is still inconsistent', () => {
    expect(advanceSettle(laggedReveal(), B(974n, 149n), NOW).status).toBe('lagged')
  })

  it('becomes SETTLED once both sides have moved — a Refresh resolves it', () => {
    // The user is not told to fix a settle; they are told to tap Refresh, and this is what that
    // does. No second deadline, no manual clearing.
    const out = advanceSettle(laggedReveal(), B(900n, 149n), NOW)
    expect(out.status).toBe('settled')
    expect(out.delta).toBe(74n)
  })

  it('is not re-opened into settling — it completes forward only', () => {
    expect(advanceSettle(laggedReveal(), B(974n, 149n), NOW).status).not.toBe('settling')
  })

  it('a SETTLED entry is still never re-opened by a later lower read', () => {
    const settled = entry({ status: 'settled', delta: 74n })
    expect(advanceSettle(settled, B(0n, 0n), NOW + 10_000_000)).toBe(settled)
  })
})

describe('acknowledging a lagged entry does not clear it', () => {
  it('REFUSES to drop a lagged entry — dismissing a message must not change what we know', () => {
    // Dropping it would remove the only record that the balances are incomplete, and the total
    // would go straight to a confident sum of a stale figure and a fresh one. Worse than never
    // having tracked it.
    const list = [entry({ status: 'lagged' })]
    expect(acknowledged(list, 'tx1')).toEqual(list)
  })

  it('still drops a settled one, so a finished transaction does not linger', () => {
    expect(acknowledged([entry({ status: 'settled' })], 'tx1')).toEqual([])
  })

  it('a lagged entry acknowledged and then resolved can finally be dropped', () => {
    const kept = acknowledged([entry({ status: 'lagged', watches: REVEAL_WATCHES })], 'tx1')
    const resolved = advanceAll(kept, B(900n, 149n), NOW)
    expect(acknowledged(resolved, 'tx1')).toEqual([])
  })
})

describe('isAccountedFor — what the total actually needs to know', () => {
  it('ignores the deadline: true on moved balances however long ago it passed', () => {
    expect(isAccountedFor(entry({ watches: REVEAL_WATCHES, deadlineAt: 1 }), B(900n, 149n))).toBe(true)
  })
  it('is false on unmoved balances however much time remains', () => {
    expect(isAccountedFor(entry({ watches: REVEAL_WATCHES, deadlineAt: LATER }), B(974n, 149n))).toBe(false)
  })

  it('an unknown reading is NOT agreement', () => {
    // A scan in flight or a failed one says nothing about whether the transaction landed, and a
    // total must not be released on the strength of a missing number.
    expect(isAccountedFor(entry({ watches: REVEAL_WATCHES }), B(null, 149n))).toBe(false)
  })

  it('is the same answer whether the entry is settling or lagged', () => {
    // For the purpose of adding two balances the two statuses mean one thing: something of ours is
    // missing from the figures.
    for (const status of ['settling', 'lagged'] as const) {
      expect(isAccountedFor(entry({ status, watches: REVEAL_WATCHES }), B(974n, 149n))).toBe(false)
      expect(isAccountedFor(entry({ status, watches: REVEAL_WATCHES }), B(900n, 149n))).toBe(true)
    }
  })
})
