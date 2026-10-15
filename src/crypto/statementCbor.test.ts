// The browser statement encoder must write EXACTLY the bytes the Rust tool writes — the Order decodes
// them with the Rust type. The vectors in statementCbor.vectors.json were produced by caravel-trade's
// tools/statement-cbor (tari_template_lib_types 0.34.1, tari_bor 0.16.4) from statements the SDK built
// (payouts in cUSD and tTARI, a large amount, a spend with an input and a revealed output) plus two
// hand-made shapes the tool also encoded (revealed-only with no balance proof; two outputs with
// 64-bit values). IF ONE FAILS, THE PORT DRIFTED FROM THE CONTRACT'S ENCODING — do not regenerate the
// vectors from this code.

import { describe, expect, it } from 'vitest'
import vectors from './statementCbor.vectors.json'
import { decodeStatement, encodeStatement, payoutCommitment, StatementCborError, type StatementJson } from './statementCbor'

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)))

describe('statementCbor against the Rust encoder', () => {
  it('has the vectors it is pinned to', () => {
    expect(vectors.map(v => v.name)).toEqual(
      ['payout-cusd', 'payout-tari', 'payout-big', 'spend-revealed', 'revealed-only', 'two-outputs-big'])
  })

  for (const v of vectors) {
    it(`${v.name}: encodes to the Rust bytes exactly`, () => {
      expect(hex(encodeStatement(v.json))).toBe(v.hex)
    })
    it(`${v.name}: decodes the Rust bytes to the same statement`, () => {
      expect(decodeStatement(bytes(v.hex))).toEqual(JSON.parse(v.json))
    })
    it(`${v.name}: decode → encode is the identity on bytes`, () => {
      expect(hex(encodeStatement(decodeStatement(bytes(v.hex))))).toBe(v.hex)
    })
  }
})

describe('statementCbor refuses what it cannot encode exactly', () => {
  const payout = (): StatementJson => JSON.parse(vectors[0].json)

  it('script-path inputs, non-key authorisations, viewable balances and covenant claims', () => {
    const a = payout(); a.inputs_statement.inputs = [{ commitment: '00'.repeat(32), witness: 'ScriptPath' as never }]
    expect(() => encodeStatement(a)).toThrow(StatementCborError)
    const b = payout(); (b.outputs_statement.outputs[0] as { auth: unknown }).auth = { Script: '00'.repeat(32) }
    expect(() => encodeStatement(b)).toThrow(StatementCborError)
    const c = payout(); (c.outputs_statement.outputs[0].output as { viewable_balance_proof: unknown }).viewable_balance_proof = {}
    expect(() => encodeStatement(c)).toThrow(StatementCborError)
    const d = payout(); (d as { covenant_claims: unknown[] }).covenant_claims = [{}]
    expect(() => encodeStatement(d)).toThrow(StatementCborError)
  })

  it('negative amounts, as the Rust type does', () => {
    const a = payout(); a.inputs_statement.revealed_amount = '-300'
    expect(() => encodeStatement(a)).toThrow(StatementCborError)
  })

  it('wrong-length keys and commitments', () => {
    const a = payout(); a.outputs_statement.outputs[0].output.commitment = 'ab'
    expect(() => encodeStatement(a)).toThrow(StatementCborError)
  })

  it('truncated bytes, trailing bytes, and a wrong field count', () => {
    const good = bytes(vectors[0].hex)
    expect(() => decodeStatement(good.slice(0, good.length - 1))).toThrow(StatementCborError)
    expect(() => decodeStatement(Uint8Array.from([...good, 0]))).toThrow(StatementCborError)
    const wrong = good.slice(); wrong[0] = 0x83   // array(3) instead of array(4)
    expect(() => decodeStatement(wrong)).toThrow(StatementCborError)
  })
})

describe('payoutCommitment — the Order\'s check_payout, read by a taker', () => {
  const payout = () => decodeStatement(bytes(vectors[0].hex))   // a 2 cUSD payout

  it('returns the one output a fill will create', () => {
    const s = payout()
    expect(payoutCommitment(s, 2_000_000n)).toBe(s.outputs_statement.outputs[0].output.commitment)
  })
  it('refuses a payout of the wrong amount', () => {
    expect(() => payoutCommitment(payout(), 2_000_001n)).toThrow(/exactly what is owed/)
  })
  it('refuses a statement that spends inputs or reveals funds (not a payout)', () => {
    expect(() => payoutCommitment(decodeStatement(bytes(vectors[3].hex)), 0n)).toThrow(StatementCborError)
  })
})
