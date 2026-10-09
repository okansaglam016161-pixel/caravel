// "Burn forever" runs once, however fast it is clicked.

import { describe, expect, it, vi } from 'vitest'
import type { BurnResult, PreparedBurn } from '../../crypto/burn'
import { QuoteChanged } from '../../crypto/quote'
import { createBurnConfirm, type BurnConfirmDeps, type BurnProgress } from './burnConfirm'

const tick = () => new Promise(r => setTimeout(r, 0))

function fakePrepared(over: Partial<PreparedBurn> = {}): PreparedBurn & { submit: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> } {
  const result: BurnResult = {
    txId: 'tx_burn', outcome: 'Commit', amountMicrotari: 100_000n, feeMicrotari: 10_151n,
    selfOutputIds: ['utxo_change'], spentInputIds: ['utxo_in'],
  }
  return {
    source: 'private',
    amountMicrotari: 100_000n,
    feeMicrotari: 10_151n,
    simulate: vi.fn(),
    preparedAt: 0,
    release: vi.fn(),
    // Both take a turn of the event loop, like the real network round trips.
    confirm: vi.fn(async () => { await tick() }),
    submit: vi.fn(async () => { await tick(); return result }),
    ...over,
  } as never
}

function harness() {
  const shown: BurnProgress[] = []
  const deps = {
    address: 'otl_esm_test',
    beginEntry: vi.fn(() => ({ entry: { id: 'j1' } })),
    settleEntry: vi.fn(),
    beginSettle: vi.fn(),
    rescan: vi.fn(),
    balancesBefore: () => ({ private: 5_000_000n, public: 1_000_000n }),
    show: (v: BurnProgress) => { shown.push(v) },
    reprice: vi.fn(),
    onBurned: vi.fn(),
    now: () => 0,
  } satisfies BurnConfirmDeps
  return { deps, shown, gate: createBurnConfirm(deps) }
}

describe('the double-click guard', () => {
  it('rapid repeated clicks → exactly one confirm, one journal row, one submit, one settle', async () => {
    const { deps, shown, gate } = harness()
    const prepared = fakePrepared()

    // Five clicks in the same tick — before React could re-render the button away.
    const clicks = Array.from({ length: 5 }, () => gate.confirm(prepared))
    expect(gate.inFlight()).toBe(true)
    // And more while the first is still checking the quote.
    await tick()
    clicks.push(gate.confirm(prepared), gate.confirm(prepared))
    await Promise.all(clicks)

    expect(prepared.confirm).toHaveBeenCalledTimes(1)
    expect(deps.beginEntry).toHaveBeenCalledTimes(1)
    expect(prepared.submit).toHaveBeenCalledTimes(1)
    expect(deps.settleEntry).toHaveBeenCalledTimes(1)
    expect(deps.beginSettle).toHaveBeenCalledTimes(1)
    expect(deps.onBurned).toHaveBeenCalledTimes(1)
    expect(shown.at(-1)).toEqual({ step: 'success', amount: 100_000n, fee: 10_151n, txId: 'tx_burn' })
  })

  it('a finished burn stays locked: clicking again does nothing', async () => {
    const { gate } = harness()
    const prepared = fakePrepared()
    await gate.confirm(prepared)
    await gate.confirm(prepared)
    expect(prepared.submit).toHaveBeenCalledTimes(1)
    expect(gate.inFlight()).toBe(true)
  })

  it('a re-priced quote releases the lock — the new quote may be confirmed, once', async () => {
    const { deps, gate } = harness()
    const stale = fakePrepared({ confirm: vi.fn(async () => { throw new QuoteChanged('fee-risen') }) as never })
    await Promise.all([gate.confirm(stale), gate.confirm(stale)])
    expect(stale.confirm).toHaveBeenCalledTimes(1)
    expect(deps.reprice).toHaveBeenCalledTimes(1)
    expect(deps.beginEntry).not.toHaveBeenCalled()
    expect(gate.inFlight()).toBe(false)

    const fresh = fakePrepared()
    await Promise.all([gate.confirm(fresh), gate.confirm(fresh)])
    expect(fresh.submit).toHaveBeenCalledTimes(1)
  })

  it('an error keeps the lock until Try again resets it', async () => {
    const { gate, shown } = harness()
    const failing = fakePrepared({ submit: vi.fn(async () => { throw new Error('boom') }) as never })
    await gate.confirm(failing)
    expect(shown.at(-1)).toMatchObject({ step: 'error' })
    await gate.confirm(failing)
    expect(failing.submit).toHaveBeenCalledTimes(1)
    gate.reset()
    await gate.confirm(failing)
    expect(failing.submit).toHaveBeenCalledTimes(2)
  })

  it('the journal row is written before the submit, and closed with the receipt', async () => {
    const { deps, gate } = harness()
    const order: string[] = []
    deps.beginEntry.mockImplementation(() => { order.push('journal'); return { entry: { id: 'j1' } } })
    const prepared = fakePrepared({ submit: vi.fn(async () => {
      order.push('submit')
      return { txId: 't', outcome: 'Commit', amountMicrotari: 100_000n, feeMicrotari: 1n, selfOutputIds: [], spentInputIds: [] }
    }) as never })
    await gate.confirm(prepared)
    expect(order).toEqual(['journal', 'submit'])
    expect(deps.settleEntry).toHaveBeenCalledWith('otl_esm_test', 'j1', expect.objectContaining({ outcome: 'committed', txId: 't' }))
  })
})
