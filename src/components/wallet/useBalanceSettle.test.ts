// Tests for the balance-settle decision (M2).
//
// The hook itself is effect wiring and this project has no DOM renderer in its unit suite, so the
// rules it applies are extracted into settleAction and tested directly. Those rules are what decide
// whether a user is told their transaction worked — the interval plumbing around them is not where
// the risk is.

import { afterEach, describe, expect, it } from 'vitest'
import { rescanLease, settleAction } from './useBalanceSettle'

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

// ── The rescan lease (M9 F7) ─────────────────────────────────────────────────
//
// More than one settle loop can be alive at once — settling runs up to 150s, tabs stay mounted, so
// switching to Move mid-send-settle and starting a move leaves two, and a faucet claim makes three.
// Each still reaches its own verdict; what went wrong was that each also fired the GLOBAL rescan()
// on its own 8-second timer, so the scans overlapped and invalidated one another while the loops
// watched the balances they were thrashing.
//
// The rule is one driver. These pin it without a renderer, which is the point of lifting it out of
// the effect — an invariant that only holds inside useEffect is one nobody checks.

describe('rescanLease', () => {
  const A = Symbol('a'), B = Symbol('b'), C = Symbol('c')
  afterEach(() => { for (const s of [A, B, C]) rescanLease.release(s) })

  it('the first claimant drives', () => {
    expect(rescanLease.claim(A)).toBe(true)
    expect(rescanLease.holds(A)).toBe(true)
  })

  it('a second loop does NOT get it — that is the whole fix', () => {
    rescanLease.claim(A)
    expect(rescanLease.claim(B)).toBe(false)
    expect(rescanLease.holds(B)).toBe(false)
  })

  it('never two drivers, however many loops pile on', () => {
    for (const s of [A, B, C]) rescanLease.claim(s)
    expect([A, B, C].filter(s => rescanLease.holds(s))).toHaveLength(1)
  })

  it('a non-holder cannot free the holder — a loop must not end another loop’s drive', () => {
    rescanLease.claim(A)
    rescanLease.release(B)
    expect(rescanLease.holds(A)).toBe(true)
  })

  it('releasing hands off to the next loop, so the survivor keeps polling', () => {
    rescanLease.claim(A)
    rescanLease.claim(B)          // refused, still ticking
    rescanLease.release(A)        // A settles or unmounts
    expect(rescanLease.claim(B)).toBe(true)
  })

  it('is free again once every loop has gone', () => {
    rescanLease.claim(A)
    rescanLease.release(A)
    expect(rescanLease.free()).toBe(true)
  })

  it('claim is idempotent for the holder — re-running the effect must not drop the lease', () => {
    // The effect re-runs on every balance change, and each run claims again. If a repeat claim
    // reset or stole the lease the driver would flicker while it polls.
    rescanLease.claim(A)
    expect(rescanLease.claim(A)).toBe(true)
    expect(rescanLease.holds(A)).toBe(true)
  })

  it('a released lease is not held by its old owner', () => {
    rescanLease.claim(A)
    rescanLease.release(A)
    expect(rescanLease.holds(A)).toBe(false)
  })
})
