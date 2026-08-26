// Tests for the cancellation guard (M9 F4).
//
// The scenario that matters: a user backs out while a transaction is being priced, and the probe
// resolves afterwards. Its result must be DROPPED, not applied — otherwise a dismissed review card
// reappears holding a signed envelope, and on the reveal path that is a cancelled irreversible
// action coming back armed.

import { describe, expect, it } from 'vitest'
import { GenerationGuard } from './generation'

describe('GenerationGuard', () => {
  it('a token is current while nothing else has happened', () => {
    const g = new GenerationGuard()
    const t = g.begin()
    expect(g.isStale(t)).toBe(false)
  })

  it('BACKING OUT DISCARDS AN IN-FLIGHT RESULT', () => {
    const g = new GenerationGuard()
    const pricing = g.begin()
    g.cancel()                       // the user pressed Back
    expect(g.isStale(pricing)).toBe(true)
  })

  it('a superseding attempt discards the earlier one', () => {
    // Back out, change the amount, price again: two probes in flight, the slower must not win.
    const g = new GenerationGuard()
    const first = g.begin()
    const second = g.begin()
    expect(g.isStale(first)).toBe(true)
    expect(g.isStale(second)).toBe(false)
  })

  it('THE SLOW-FIRST RACE: an older probe resolving last is still discarded', () => {
    const g = new GenerationGuard()
    const slow = g.begin()
    const fast = g.begin()
    // fast resolves and is applied…
    expect(g.isStale(fast)).toBe(false)
    // …then slow finally returns, and must not overwrite it.
    expect(g.isStale(slow)).toBe(true)
  })

  it('cancel starts nothing — the next begin is still fresh', () => {
    const g = new GenerationGuard()
    g.begin(); g.cancel()
    const next = g.begin()
    expect(g.isStale(next)).toBe(false)
  })

  it('repeated cancels stay safe', () => {
    const g = new GenerationGuard()
    const t = g.begin()
    g.cancel(); g.cancel(); g.cancel()
    expect(g.isStale(t)).toBe(true)
  })

  it('an unissued token is always stale', () => {
    // Defence against a caller that forgot to call begin().
    expect(new GenerationGuard().isStale(0)).toBe(true)
    expect(new GenerationGuard().isStale(99)).toBe(true)
  })

  it('survives a long run of attempts', () => {
    const g = new GenerationGuard()
    const tokens = Array.from({ length: 500 }, () => g.begin())
    expect(tokens.slice(0, -1).every(t => g.isStale(t))).toBe(true)
    expect(g.isStale(tokens.at(-1)!)).toBe(false)
  })
})
