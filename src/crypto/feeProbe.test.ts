// Tests for the dry-run fee probe (M5).
//
// THE KEYSTONE HERE IS `AcceptFeeRejectRest`. The probe's whole job is to refuse to price a
// transaction that will not work — and for the life of M1–M4 it had a hole in exactly the case
// where the network takes the fee and rejects everything else. A transaction in that state priced
// as an ordinary cheap fee, so the user would have been shown a number, confirmed it, and had it
// burned for nothing.
//
// The response bodies below are the REAL wire shapes, captured from Esmeralda on 2026-08-25, not
// invented: the AcceptFeeRejectRest case is a public→public transfer submitted without the
// recipient's vault declared.

import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  compareToShownFee, dryRunFee, priceAtBudget, simulateFee, withFeeMargin, FEE_MARGIN_FLOOR, FEE_MARGIN_PERCENT,
} from './feeProbe'
import { QuoteChanged, confirmQuote } from './quote'
import { NETWORK_BUSY_MESSAGE, retryTiming } from './indexerRetry'

const URL = 'https://indexer.test'

/** Stub one fetch response body. */
function respond(body: unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })))
}

const feeReceipt = {
  total_fee_payment: 200_000,
  total_fees_paid: 14_537,
  total_fee_overcharge: 4_596,
  cost_breakdown: { breakdown: { RuntimeCall: 17, Storage: 842, NativeExecution: 8_142 } },
}

const accept = (receipt: unknown = feeReceipt) => ({
  result: { finalize: { result: { Accept: { up_substates: [], down_substates: [] } }, fee_receipt: receipt } },
})

afterEach(() => { vi.unstubAllGlobals() })

// ── THE FUND-SAFETY KEYSTONE ──────────────────────────────────────────────────

describe('AcceptFeeRejectRest — the fee commits and nothing moves', () => {
  /** The exact body Esmeralda returned for a transfer missing the recipient's vault. */
  const feeIntentOnly = {
    result: {
      finalize: {
        transaction_hash: 'c80f674e…',
        result: {
          AcceptFeeRejectRest: [
            { up_substates: [], down_substates: [] },
            { SubstateNotFound: 'At instruction #3: vault_6a6de7ab8daf29351576627583b0df7d387485cefbfb569072870e93e1271edc not found' },
          ],
        },
        // A perfectly ordinary-looking receipt — this is why the old check sailed past it.
        fee_receipt: { total_fee_payment: 200_000, total_fees_paid: 887, total_fee_overcharge: 0 },
      },
    },
  }

  it('THROWS rather than pricing the burned fee as success', async () => {
    respond(feeIntentOnly)
    // The old code returned 887n here. Anything other than a throw is the bug returning.
    await expect(dryRunFee(URL, {})).rejects.toThrow(/would fail after the fee was taken/)
  })

  it('never returns a value for this shape, at any fee figure', async () => {
    for (const paid of [1, 887, 50_000, 10_000_000]) {
      respond({ ...feeIntentOnly, result: { finalize: { ...feeIntentOnly.result.finalize, fee_receipt: { total_fees_paid: paid, total_fee_overcharge: 0 } } } })
      await expect(dryRunFee(URL, {})).rejects.toThrow()
    }
  })

  it('surfaces the network’s own reason verbatim, not a generic failure', async () => {
    respond(feeIntentOnly)
    await expect(dryRunFee(URL, {})).rejects.toThrow(/SubstateNotFound: At instruction #3: vault_6a6de7ab/)
  })
})

// ── The clean path still works ────────────────────────────────────────────────

describe('a clean Accept still prices', () => {
  it('returns what was consumed — paid minus overcharge', async () => {
    respond(accept())
    expect(await dryRunFee(URL, {})).toBe(14_537n - 4_596n)
  })

  it('accepts string-encoded amounts (0.39 moved several fields to strings)', async () => {
    respond(accept({ total_fees_paid: '14537', total_fee_overcharge: '4596' }))
    expect(await dryRunFee(URL, {})).toBe(9_941n)
  })

  it('falls back to summing the cost breakdown when the totals are missing', async () => {
    respond(accept({ cost_breakdown: { breakdown: { RuntimeCall: 17, Storage: 842, NativeExecution: 8_142 } } }))
    expect(await dryRunFee(URL, {})).toBe(9_001n)
  })

  it('does not care what the Accept diff contains', async () => {
    respond({ result: { finalize: { result: { Accept: { up_substates: [['vault_x', {}]] } }, fee_receipt: feeReceipt } } })
    expect(await dryRunFee(URL, {})).toBe(9_941n)
  })
})

// ── Reject, and every other non-Accept shape ─────────────────────────────────

describe('Reject — unchanged behaviour, better message', () => {
  it.each([
    ['SubstateNotFound', { SubstateNotFound: 'vault_abc not found' }, /SubstateNotFound: vault_abc not found/],
    ['InsufficientFeesPaid', { InsufficientFeesPaid: 'required 16138, paid 12000' }, /InsufficientFeesPaid: required 16138/],
    ['ExecutionFailure', { ExecutionFailure: 'Bucket not found in workspace' }, /ExecutionFailure: Bucket not found/],
    ['a bare-string variant', 'ForeignPledgeInputConflict', /ForeignPledgeInputConflict/],
    ['a structured variant', { Abort: { reason: 'ValidityWindowTooLong' } }, /Abort: /],
  ])('throws with the reason for %s', async (_label, reason, matcher) => {
    respond({ result: { finalize: { result: { Reject: reason }, fee_receipt: feeReceipt } } })
    await expect(dryRunFee(URL, {})).rejects.toThrow(matcher)
  })

  it('refuses even when a usable fee receipt is present', async () => {
    // The receipt is complete and would have priced fine — the result is what disqualifies it.
    respond({ result: { finalize: { result: { Reject: { SubstateNotFound: 'x' } }, fee_receipt: feeReceipt } } })
    await expect(dryRunFee(URL, {})).rejects.toThrow(/rejected this transaction in simulation/)
  })
})

describe('anything that is not a clean Accept fails closed', () => {
  it('refuses an unrecognised result variant rather than guessing', async () => {
    // A shape from a future engine. Failing closed costs a refused estimate; failing open costs
    // the user their fee.
    respond({ result: { finalize: { result: { SomeFutureVariant: {} }, fee_receipt: feeReceipt } } })
    await expect(dryRunFee(URL, {})).rejects.toThrow(/unrecognised result \(SomeFutureVariant\)/)
  })

  it('refuses an empty result object', async () => {
    respond({ result: { finalize: { result: {}, fee_receipt: feeReceipt } } })
    await expect(dryRunFee(URL, {})).rejects.toThrow(/unrecognised result/)
  })

  it('refuses a missing result', async () => {
    respond({ result: { finalize: { fee_receipt: feeReceipt } } })
    await expect(dryRunFee(URL, {})).rejects.toThrow(/no transaction result/)
  })

  it('refuses a missing finalize', async () => {
    respond({ result: {} })
    await expect(dryRunFee(URL, {})).rejects.toThrow(/returned no result/)
  })

  it('refuses an Accept with no fee receipt', async () => {
    respond({ result: { finalize: { result: { Accept: {} } } } })
    await expect(dryRunFee(URL, {})).rejects.toThrow(/carried no fee receipt/)
  })

  it('refuses an Accept whose receipt reports no cost', async () => {
    respond(accept({ total_fees_paid: 0, total_fee_overcharge: 0 }))
    await expect(dryRunFee(URL, {})).rejects.toThrow(/reported no cost/)
  })
})

describe('transport failures', () => {
  it('reports a non-OK HTTP status', async () => {
    respond({ error: 'bad request' }, false, 400)
    await expect(dryRunFee(URL, {})).rejects.toThrow(/indexer HTTP 400/)
  })

  it('reports a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('nope') } })))
    await expect(dryRunFee(URL, {})).rejects.toThrow(/malformed response/)
  })
})

describe('withFeeMargin — 2%, floor 200 µtTARI', () => {
  it('adds 2% once it clears the floor, rounding down in bigint', () => {
    expect(FEE_MARGIN_PERCENT).toBe(2n)
    expect(FEE_MARGIN_FLOOR).toBe(200n)
    expect(withFeeMargin(15_199n)).toBe(15_502n)   // 2% = 303
    expect(withFeeMargin(20_001n)).toBe(20_401n)   // 2% = 400.02 → 400
  })

  it('adds the floor when 2% is smaller', () => {
    expect(withFeeMargin(9_452n)).toBe(9_652n)     // 2% = 189 → 200
    expect(withFeeMargin(1n)).toBe(201n)
    expect(withFeeMargin(10_000n)).toBe(10_200n)   // 2% = 200 exactly — the floor and the percentage agree
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    expect(withFeeMargin(18_446_744_073_709_551_615n)).toBe(18_446_744_073_709_551_615n + 368_934_881_474_191_032n)
  })
})

// ── simulateFee: the dry run does not enforce the fee, so this does ─────────────
//
// Measured 2026-10-05 (harness fee-boundary): a reveal costing 9 452 dry-ran as `Accept` while
// paying 1 000, its receipt reporting the payment as consumed and overcharge 0. Only
// `total_fees_required` told the truth — 9 452 at every payment. These bodies are that shape.

describe('simulateFee — the required fee, and whether a payment covers it', () => {
  const underfunded = (paid: number, required: number) => ({
    result: {
      finalize: {
        result: { Accept: { up_substates: [], down_substates: [] } },
        fee_receipt: { total_fee_payment: paid, total_fees_paid: paid, total_fee_overcharge: 0, exhaust_burn: paid },
        total_fees_required: required,
      },
    },
  })

  it('prefers total_fees_required over paid − overcharge', async () => {
    respond(underfunded(1_000, 9_452))
    expect(await simulateFee(URL, {})).toEqual({ accepted: true, cost: 9_452n })
    expect(await dryRunFee(URL, {})).toBe(9_452n)
  })

  it('an Accept that paid less than required is `underpaid`, not accepted', async () => {
    respond(underfunded(9_451, 9_452))
    const sim = await simulateFee(URL, {}, { fee: 9_451n })
    expect(sim.accepted).toBe(false)
    expect(sim.accepted === false && sim.kind).toBe('underpaid')
    expect(sim.accepted === false && sim.reason).toBe('Required fees 9452 but 9451 paid')
  })

  it('a payment at exactly the requirement is accepted', async () => {
    respond(underfunded(9_452, 9_452))
    expect(await simulateFee(URL, {}, { fee: 9_452n })).toEqual({ accepted: true, cost: 9_452n })
  })

  it('falls back to paid − overcharge on a node that omits the requirement', async () => {
    respond(accept())
    expect(await simulateFee(URL, {})).toEqual({ accepted: true, cost: 9_941n })
  })

  it('returns a Reject as data, with the sentence dryRunFee throws', async () => {
    respond({ result: { finalize: { result: { Reject: { ExecutionFailure: 'boom' } }, fee_receipt: feeReceipt } } })
    const sim = await simulateFee(URL, {})
    expect(sim.accepted === false && sim.kind).toBe('reject')
    await expect(dryRunFee(URL, {})).rejects.toThrow(/rejected this transaction in simulation/)
  })
})

// ── A busy indexer (Ootle 0.43: 429 / 503) ──────────────────────────────────────

describe('a busy indexer is waited out, not reported', () => {
  const saved = { ...retryTiming }
  afterEach(() => { Object.assign(retryTiming, saved) })

  /** Answer from a script of statuses (accept body on 200), recording the URLs asked. */
  function scriptedFetch(statuses: number[]) {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      const status = statuses.shift() ?? 503
      return {
        ok: status === 200, status,
        headers: { get: () => null },
        json: async () => accept(),
        text: async () => '',
      }
    }))
    return urls
  }

  it('retries 503 → 429 → accept, announces each retry, and prices normally', async () => {
    retryTiming.sleep = async () => {}
    scriptedFetch([503, 429, 200])
    const onBusyRetry = vi.fn()
    expect(await dryRunFee(URL, {}, { onBusyRetry })).toBe(14_537n - 4_596n)
    expect(onBusyRetry).toHaveBeenCalledTimes(2)
  })

  it('moves to another indexer on retry — a simulation is the same on any of them', async () => {
    retryTiming.sleep = async () => {}
    const urls = scriptedFetch([503, 200])
    await dryRunFee(URL, {})
    expect(urls[0]).toBe(`${URL}/transactions/dry-run`)
    expect(urls[1]).not.toContain(URL)
  })

  it('stays busy → the one plain message: busy, nothing sent', async () => {
    retryTiming.sleep = async () => {}
    scriptedFetch([503, 503, 503, 503])
    await expect(dryRunFee(URL, {})).rejects.toThrow(NETWORK_BUSY_MESSAGE)
  })
})

// ── Refundable-budget paths: the fee shown is the cost at the REAL budget ─────────────────────────
//
// A model of the live case (2026-10-09, stranger wallet public burn 315d911d…): storage prices the
// account vault's post-fee balance by its CBOR-encoded size, which grows by two bytes at 65,536
// µtTARI. A public balance of 200,000, burning 100,000: the 50,000 probe budget leaves the vault at
// 50,000 (3 bytes) and prices 2,400; the real ~2,600 budget leaves 97,400 (5 bytes) and costs 2,402.

/**
 * The model, calibrated to the two measured figures: 2,400 while the vault's post-fee balance fits
 * a 3-byte CBOR integer (below 65,536 µtTARI), 2,402 once it needs 5.
 */
const costAt = (budget: bigint, balance: bigint, amount = 100_000n) =>
  balance - amount - budget < 65_536n ? 2_400n : 2_402n

describe('priceAtBudget — the small-public-balance under-quote', () => {
  const measured = (budget: bigint) => costAt(budget, 200_000n)

  it('the old way — price at the 50,000 probe budget — shows 2,400 for a burn that is charged 2,402', async () => {
    expect(await measured(50_000n)).toBe(2_400n)                          // what used to be shown
    expect(await measured(withFeeMargin(2_400n))).toBe(2_402n)            // what the real budget is charged
  })

  it('the fee shown is the cost measured at the budget actually offered: 2,402', async () => {
    const budgets: bigint[] = []
    const priced = await priceAtBudget(async b => { budgets.push(b); return measured(b) }, { reserve: 50_000n })
    expect(priced.probeCost).toBe(2_400n)
    expect(priced.budget).toBe(withFeeMargin(2_400n))
    expect(priced.fee).toBe(2_402n)
    expect(priced.fee <= priced.budget).toBe(true)
    expect(budgets).toEqual([50_000n, withFeeMargin(2_400n)])
  })

  it('a large public balance never crosses the boundary: probe and real agree', async () => {
    const big = (budget: bigint) => costAt(budget, 997_000_000n)
    const priced = await priceAtBudget(async b => big(b), { reserve: 50_000n })
    expect(priced.fee).toBe(priced.probeCost)
  })

  it('re-measures when the cost at the chosen budget is above it', async () => {
    // A budget-sensitive cost that outgrows the first budget once: the second round settles it.
    let calls = 0
    const priced = await priceAtBudget(async b => { calls++; return b === 50_000n ? 1_000n : b === 1_000n ? 1_300n : 1_250n }, { reserve: 50_000n, margin: false })
    expect(priced).toEqual({ fee: 1_250n, budget: 1_300n, probeCost: 1_000n })
    expect(calls).toBe(3)
  })

  it('MAX (no margin): the budget is the cost itself', async () => {
    const priced = await priceAtBudget(async () => 9_650n, { reserve: 50_000n, margin: false })
    expect(priced).toEqual({ fee: 9_650n, budget: 9_650n, probeCost: 9_650n })
  })

  it('refuses a cost above the reserve, and one that will not settle', async () => {
    await expect(priceAtBudget(async () => 60_000n, { reserve: 50_000n })).rejects.toThrow(/exceeds the 50000/)
    let n = 1_000n
    await expect(priceAtBudget(async () => (n += 1_000n), { reserve: 50_000n, margin: false })).rejects.toThrow(/kept changing/)
  })
})

describe('compareToShownFee — the confirm check holds the cost to the fee SHOWN', () => {
  it('passes only an exact match', () => {
    expect(compareToShownFee({ accepted: true, cost: 2_402n }, 2_402n)).toEqual({ accepted: true, cost: 2_402n })
  })

  it('a higher OR lower cost is fee-changed, and confirm re-prices instead of sending', async () => {
    for (const cost of [2_404n, 2_400n]) {
      const sim = compareToShownFee({ accepted: true, cost }, 2_402n)
      expect(sim).toMatchObject({ accepted: false, kind: 'fee-changed' })
      const err = await confirmQuote({ preparedAt: Date.now(), simulate: async () => sim }).catch(e => e)
      expect(err).toBeInstanceOf(QuoteChanged)
      expect((err as QuoteChanged).reason).toBe('fee-risen')
    }
  })

  it('leaves a rejection as it is', () => {
    const rejected = { accepted: false as const, kind: 'reject' as const, reason: 'x', message: 'y' }
    expect(compareToShownFee(rejected, 2_402n)).toBe(rejected)
  })
})
