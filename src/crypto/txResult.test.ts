// readFinalizedVerdict — the decision field comes in two shapes, and both are FINAL.

import { describe, expect, it } from 'vitest'
import { readFinalizedVerdict } from './txResult'

/** Verbatim from Esmeralda, 2026-10-05: a real send paying one microtari short (tx 04973918…). */
const SHORT_FEE_ABORT = {
  result: {
    Finalized: {
      final_decision: { Abort: 'InsufficientFeesPaid' },
      abort_details: 'Insufficient fees paid: Required fees 15199 but 15198 paid',
      execution_result: {
        finalize: {
          result: { Reject: { InsufficientFeesPaid: 'Required fees 15199 but 15198 paid' } },
          fee_receipt: { total_fee_payment: 0, total_fees_paid: 0, total_fee_overcharge: 0 },
        },
      },
    },
  },
}

describe('readFinalizedVerdict', () => {
  it('an object-form Abort is a final REJECT, not "not yet" — the short-fee case', () => {
    expect(readFinalizedVerdict(SHORT_FEE_ABORT)).toEqual({
      kind: 'reject', reason: 'InsufficientFeesPaid: Required fees 15199 but 15198 paid',
    })
  })

  it('an Abort with no readable result is still a reject, naming the abort', () => {
    const body = { result: { Finalized: { final_decision: { Abort: 'InsufficientFeesPaid' } } } }
    expect(readFinalizedVerdict(body)).toMatchObject({ kind: 'reject', reason: expect.stringContaining('InsufficientFeesPaid') })
  })

  it('a string Commit with Accept is accept', () => {
    const body = { result: { Finalized: { final_decision: 'Commit', execution_result: { finalize: { result: { Accept: {} } } } } } }
    expect(readFinalizedVerdict(body)).toEqual({ kind: 'accept' })
  })

  it('no decision yet is null — keep waiting', () => {
    expect(readFinalizedVerdict({ result: { Finalized: { final_decision: null } } })).toBeNull()
    expect(readFinalizedVerdict({ result: { Finalized: { final_decision: {} } } })).toBeNull()
    expect(readFinalizedVerdict({ result: { Pending: {} } })).toBeNull()
  })
})
