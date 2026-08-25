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
import { dryRunFee, withFeeMargin, FEE_MARGIN_PERCENT } from './feeProbe'

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

describe('withFeeMargin', () => {
  it('adds the margin, rounding down in bigint', () => {
    expect(withFeeMargin(9_941n)).toBe((9_941n * (100n + FEE_MARGIN_PERCENT)) / 100n)
    expect(withFeeMargin(9_941n)).toBe(12_426n)
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    expect(withFeeMargin(18_446_744_073_709_551_615n)).toBe(23_058_430_092_136_939_518n)
  })
})
