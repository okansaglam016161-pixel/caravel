// readFinalizedVerdict — the decision field comes in two shapes, and both are FINAL.

import { describe, expect, it } from 'vitest'
import { downSubstateIds, readFinalizedVerdict } from './txResult'

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

describe('a fee-only commit names what its fee intent consumed', () => {
  const fin = (result: unknown) => ({ result: { Finalized: { final_decision: 'Commit', execution_result: { finalize: { result } } } } })
  it('reads the fee diff\'s down_substates', () => {
    const v = readFinalizedVerdict(fin({ AcceptFeeRejectRest: [
      { up_substates: [], down_substates: [['utxo_0101_fee', 0], ['vault_x', 3]], fee_withdrawals: [] }, { SubstateNotFound: 'y' },
    ] }))
    expect(v).toMatchObject({ kind: 'fee-only', consumed: ['utxo_0101_fee', 'vault_x'] })
  })
  it('is null — never a partial list — when the diff is not that shape', () => {
    expect(readFinalizedVerdict(fin({ AcceptFeeRejectRest: [{}, 'r'] }))).toMatchObject({ kind: 'fee-only', consumed: null })
    expect(downSubstateIds({ down_substates: [['a', 0], [{ Utxo: 'b' }, 1]] })).toBeNull()
  })
})
