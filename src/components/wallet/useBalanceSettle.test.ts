// Tests for the balance-settle decision (M2).
//
// The hook itself is effect wiring and this project has no DOM renderer in its unit suite, so the
// rules it applies are extracted into settleAction and tested directly. Those rules are what decide
// whether a user is told their transaction worked — the interval plumbing around them is not where
// the risk is.

import { describe, expect, it } from 'vitest'
import { settleAction } from './useBalanceSettle'

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
