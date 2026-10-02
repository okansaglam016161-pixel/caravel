import { describe, expect, it } from 'vitest'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import {
  buildClaim,
  claimRefusalMessage,
  classifyClaimFailure,
  FaucetClaimRefused,
} from './faucet'
import {
  FAUCET_COMPONENT_ADDRESS,
  FAUCET_RECEIPTS_RESOURCE_ADDRESS,
  FAUCET_VAULT_ADDRESS,
} from './faucetConfig'

const PK = 'ab'.repeat(32)
// buildClaim only embeds the statement's compact JSON, so a stand-in is enough to test the shape.
const statement = { toCompactJson: () => '{"stand_in":true}' } as never

type Unsigned = {
  fee_instructions: Record<string, unknown>[]
  instructions: unknown[]
  inputs: { substate_id: string; is_write: boolean }[]
  max_epoch: number
}
const unsigned = () => buildClaim(4242, PK, statement).buildUnsignedTransaction() as unknown as Unsigned

describe('buildClaim — the claim transaction', () => {
  it('is fee phase only: claim → StealthTransfer → PayFeeFromBucket', () => {
    const tx = unsigned()
    expect(tx.instructions).toEqual([])
    expect(tx.fee_instructions.map(i => Object.keys(i)[0])).toEqual([
      'CallMethod',
      'PutLastInstructionOutputOnWorkspace',
      'StealthTransfer',
      'PutLastInstructionOutputOnWorkspace',
      'PayFeeFromBucket',
    ])
  })

  it('never creates an account and never touches Tari’s built-in faucet', () => {
    const json = JSON.stringify(unsigned())
    expect(json).not.toContain('CreateAccount')
    expect(json).not.toContain('"take"')
    expect(json).not.toContain('0102030000000000000000000000000000000000000000000000000000000002')
  })

  it('calls claim on our faucet, naming the wallet’s own key as a 32-byte CBOR byte string', () => {
    const call = unsigned().fee_instructions[0]!.CallMethod as { call: { Address: string }; method: string; args: { Literal: string }[] }
    expect(call.call.Address).toBe(FAUCET_COMPONENT_ADDRESS)
    expect(call.method).toBe('claim')
    expect(call.args).toEqual([{ Literal: `5820${PK}` }])
  })

  it('feeds the payout bucket into the transfer, and the transfer’s output into the fee', () => {
    const tx = unsigned()
    const save1 = tx.fee_instructions[1]!.PutLastInstructionOutputOnWorkspace as { key: number }
    const transfer = tx.fee_instructions[2]!.StealthTransfer as {
      resource_address_ref: { Address: string }
      revealed_input_bucket: { id: number }
      statement: Record<string, string>
    }
    const save2 = tx.fee_instructions[3]!.PutLastInstructionOutputOnWorkspace as { key: number }
    const pay = tx.fee_instructions[4]!.PayFeeFromBucket as { bucket: { id: number } }

    expect(transfer.resource_address_ref.Address).toBe(TARI_RESOURCE_ADDRESS)
    expect(transfer.revealed_input_bucket.id).toBe(save1.key)
    expect(pay.bucket.id).toBe(save2.key)
    expect(save1.key).not.toBe(save2.key)
    expect(Object.values(transfer.statement)).toEqual(['{"stand_in":true}'])
  })

  it('declares exactly the faucet component, its vault and the receipt resource, all writable', () => {
    expect(unsigned().inputs.map(i => [i.substate_id, i.is_write])).toEqual([
      [FAUCET_COMPONENT_ADDRESS, true],
      [FAUCET_VAULT_ADDRESS, true],
      [FAUCET_RECEIPTS_RESOURCE_ADDRESS, true],
    ])
  })

  it('carries the validity window it was given', () => {
    expect(unsigned().max_epoch).toBe(4242)
  })
})

describe('classifyClaimFailure — the faucet’s own refusals', () => {
  it('a second claim by the same key', () => {
    expect(classifyClaimFailure(
      'The network rejected this transaction in simulation: ExecutionFailure (DuplicateNonFungibleId): At instruction #1: Duplicate NFT token id: uuid_abab',
    )).toBe('already-claimed')
  })

  it('a paused faucet', () => {
    expect(classifyClaimFailure('ExecutionFailure: Panic: Faucet is paused: claims are temporarily disabled')).toBe('paused')
  })

  it('an empty faucet', () => {
    expect(classifyClaimFailure('ExecutionFailure: Panic: Faucet is empty: 0 µTARI available, 1000000000 needed for a claim')).toBe('empty')
  })

  it('a claim the claimer did not sign', () => {
    expect(classifyClaimFailure(
      'ExecutionFailure (InvalidArgument): At instruction #1: Encountered unknown or out of scope signer badge with public key 20db',
    )).toBe('unsigned')
  })

  it('leaves anything else to be shown as the network wrote it', () => {
    expect(classifyClaimFailure('Could not estimate the network fee: indexer HTTP 502')).toBeNull()
    expect(classifyClaimFailure('InsufficientFeesPaid')).toBeNull()
  })
})

describe('refusal messages', () => {
  it('says what happened, and that nothing was lost', () => {
    expect(claimRefusalMessage('already-claimed')).toBe('This wallet has already claimed its test funds.')
    expect(claimRefusalMessage('paused')).toMatch(/paused.*Check back soon/)
    expect(claimRefusalMessage('empty')).toMatch(/empty.*Check back soon/)
    expect(claimRefusalMessage('unsigned')).toMatch(/Nothing was taken/)
  })

  it('FaucetClaimRefused carries the refusal and its message', () => {
    const e = new FaucetClaimRefused('paused')
    expect(e).toBeInstanceOf(Error)
    expect(e.refusal).toBe('paused')
    expect(e.message).toBe(claimRefusalMessage('paused'))
  })
})
