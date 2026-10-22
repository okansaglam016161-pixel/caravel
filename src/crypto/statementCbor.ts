// A stealth transfer statement ⇄ the `tari_bor` CBOR an Order stores as its maker's payout.
//
// The browser port of caravel-trade's tools/statement-cbor (Rust: serde_json → tari_bor::encode of
// `tari_template_lib_types::stealth::StealthTransferStatement`, 0.34.1, tari_bor 0.16.4). The Order
// contract decodes the stored bytes with that same Rust type at placement (check_payout) and again at
// fill (pay_maker), so these bytes must be EXACTLY what the Rust encoder writes — not merely something
// that decodes. Round-trip tested against vectors the Rust tool produced (statementCbor.test.ts), and
// re-checked live against the tool by the harness (`trade-cbor-check`).
//
// ── THE WIRE FORMAT (minicbor derive, `#[n(i)]` indices) ─────────────────────
//
//   struct         → CBOR array of its fields in index order. A `None` in the MIDDLE is `null`; TRAILING
//                    `None`s are omitted (UnspentOutput is array(4) when viewable_balance_proof is None).
//   enum variant   → array(2) [variant index, array(fields)]   — Key(pk) = [0,[pk]], KeyPath = [0,[]]
//   Amount         → CBOR integer (0.39+: minicbor's native integer, no longer a digit array)
//   byte newtypes  → CBOR byte string (commitment, nonce, encrypted data, range proof, keys, signature)
//   integers       → shortest head (minicbor writes minimal lengths); definite lengths only
//
// ── WHAT IS SUPPORTED, AND WHY THE REST IS REFUSED ───────────────────────────
//
// Exactly the shapes the SDK produces for an ordinary key-path transfer: KeyPath witnesses, Key spend
// authorisations, no viewable-balance proof, no covenant claims. Anything else (script-path spends,
// script/covenant outputs, viewable balances) has a richer encoding this file does not implement — so
// it THROWS rather than writing bytes the contract might read differently. A maker's payout is always
// the simple shape (check_payout requires no covenant claims), so refusing the rest costs nothing; and a
// decode that refuses an order's exotic payout makes the safety check refuse the fill, which is the
// safe direction.
//
// The JSON shape is the SDK's `toCompactJson()` and the Rust tool's `--decode` output (they are equal):
// hex strings for bytes, decimal strings for Amounts, numbers for u32/u64.

export interface StatementInputJson { commitment: string; witness: 'KeyPath' }
export interface UnspentOutputJson {
  commitment: string
  sender_public_nonce: string
  encrypted_data: string
  minimum_value_promise: number
  viewable_balance_proof: null
}
export interface StealthOutputJson { output: UnspentOutputJson; auth: { Key: string }; tag: number }
export interface StatementJson {
  inputs_statement: { inputs: StatementInputJson[]; revealed_amount: string }
  outputs_statement: {
    outputs: StealthOutputJson[]
    revealed_output: { amount: string; receiver: string } | null
    agg_range_proof: string
  }
  balance_proof: { public_nonce: string; signature: string } | null
  covenant_claims: []
}

export class StatementCborError extends Error {
  constructor(message: string) {
    super(`Payout statement: ${message}`)
    this.name = 'StatementCborError'
  }
}

// ── Encode ───────────────────────────────────────────────────────────────────

class Writer {
  private chunks: number[] = []
  head(major: number, value: bigint) {
    if (value < 0n) throw new StatementCborError('negative length or value')
    const m = major << 5
    if (value < 24n) this.chunks.push(m | Number(value))
    else if (value < 0x100n) this.chunks.push(m | 24, Number(value))
    else if (value < 0x10000n) this.chunks.push(m | 25, ...be(value, 2))
    else if (value < 0x100000000n) this.chunks.push(m | 26, ...be(value, 4))
    else if (value < 0x10000000000000000n) this.chunks.push(m | 27, ...be(value, 8))
    else throw new StatementCborError('integer out of the 64-bit range')
  }
  int(v: bigint) { this.head(0, v) }
  bytes(b: Uint8Array) { this.head(2, BigInt(b.length)); for (const x of b) this.chunks.push(x) }
  array(n: number) { this.head(4, BigInt(n)) }
  null() { this.chunks.push(0xf6) }
  done(): Uint8Array { return Uint8Array.from(this.chunks) }
}

function be(v: bigint, n: number): number[] {
  const out: number[] = []
  for (let i = n - 1; i >= 0; i--) out.push(Number((v >> BigInt(8 * i)) & 0xffn))
  return out
}

function hexBytes(h: unknown, what: string, len?: number): Uint8Array {
  if (typeof h !== 'string' || h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) throw new StatementCborError(`${what} is not hex`)
  const b = new Uint8Array(h.length / 2)
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
  if (len !== undefined && b.length !== len) throw new StatementCborError(`${what} must be ${len} bytes`)
  return b
}

// Non-negative only: the Rust type's JSON form refuses a sign ("invalid digit"), and a statement's
// amounts are never negative, so a negative one here is refused in both directions.
function amountOf(v: unknown, what: string): bigint {
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  throw new StatementCborError(`${what} is not an amount`)
}

function uintOf(v: unknown, what: string, max: bigint): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && BigInt(v) <= max) return BigInt(v)
  throw new StatementCborError(`${what} is not an unsigned integer`)
}

const U32_MAX = 0xffffffffn
const U64_MAX = 0xffffffffffffffffn

/** The `tari_bor` bytes of a statement, given its JSON wire form (object or `toCompactJson()` string). */
export function encodeStatement(statement: StatementJson | string): Uint8Array {
  const s = (typeof statement === 'string' ? JSON.parse(statement) : statement) as StatementJson
  const w = new Writer()
  w.array(4)                                                     // StealthTransferStatement

  const ins = s?.inputs_statement
  if (!ins || !Array.isArray(ins.inputs)) throw new StatementCborError('missing inputs_statement')
  w.array(2)                                                     // StealthInputsStatement
  w.array(ins.inputs.length)
  for (const i of ins.inputs) {
    if (i.witness !== 'KeyPath') throw new StatementCborError('only key-path inputs are supported')
    w.array(2)                                                   // StealthInput
    w.bytes(hexBytes(i.commitment, 'input commitment', 32))
    w.array(2); w.int(0n); w.array(0)                            // SpendWitness::KeyPath
  }
  w.int(amountOf(ins.revealed_amount, 'revealed_amount'))

  const outs = s.outputs_statement
  if (!outs || !Array.isArray(outs.outputs)) throw new StatementCborError('missing outputs_statement')
  w.array(3)                                                     // StealthOutputsStatement
  w.array(outs.outputs.length)
  for (const o of outs.outputs) {
    const u = o?.output
    if (!u) throw new StatementCborError('output without its unspent output')
    if (u.viewable_balance_proof !== null && u.viewable_balance_proof !== undefined) {
      throw new StatementCborError('viewable balance proofs are not supported')
    }
    w.array(3)                                                   // StealthUnspentOutput
    w.array(4)                                                   // UnspentOutput (trailing None omitted)
    w.bytes(hexBytes(u.commitment, 'output commitment', 32))
    w.bytes(hexBytes(u.sender_public_nonce, 'sender public nonce', 32))
    w.bytes(hexBytes(u.encrypted_data, 'encrypted data'))
    w.int(uintOf(u.minimum_value_promise, 'minimum_value_promise', U64_MAX))
    const key = (o.auth as { Key?: unknown } | undefined)?.Key
    if (key === undefined || Object.keys(o.auth).length !== 1) throw new StatementCborError('only key spend authorisations are supported')
    w.array(2); w.int(0n); w.array(1); w.bytes(hexBytes(key, 'spend key', 32))   // SpendAuthorization::Key
    w.int(uintOf(o.tag, 'output tag', U32_MAX))
  }
  if (outs.revealed_output === null || outs.revealed_output === undefined) w.null()
  else {
    w.array(2)                                                   // RevealedOutput
    w.int(amountOf(outs.revealed_output.amount, 'revealed output amount'))
    w.bytes(hexBytes(outs.revealed_output.receiver, 'revealed output receiver', 32))
  }
  w.bytes(hexBytes(outs.agg_range_proof, 'range proof'))

  if (s.balance_proof === null || s.balance_proof === undefined) w.null()
  else {
    w.array(2)                                                   // BalanceProofSignature
    w.bytes(hexBytes(s.balance_proof.public_nonce, 'balance proof nonce', 32))
    w.bytes(hexBytes(s.balance_proof.signature, 'balance proof signature', 32))
  }

  if (Array.isArray(s.covenant_claims) && s.covenant_claims.length > 0) {
    throw new StatementCborError('covenant claims are not supported')
  }
  w.array(0)
  return w.done()
}

// ── Decode ───────────────────────────────────────────────────────────────────

class Reader {
  private i = 0
  private readonly b: Uint8Array
  constructor(b: Uint8Array) { this.b = b }
  get offset() { return this.i }
  private byte(): number {
    if (this.i >= this.b.length) throw new StatementCborError('truncated')
    return this.b[this.i++]
  }
  /** The next head, which must be `major`; returns its argument. Definite lengths only. */
  head(major: number, what: string): bigint {
    const ib = this.byte()
    if (ib >> 5 !== major) throw new StatementCborError(`${what}: unexpected CBOR type`)
    return this.arg(ib & 31, what)
  }
  private arg(ai: number, what: string): bigint {
    if (ai < 24) return BigInt(ai)
    const n = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : 0
    if (n === 0) throw new StatementCborError(`${what}: indefinite or reserved length`)
    let v = 0n
    for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(this.byte())
    return v
  }
  peekNull(): boolean { return this.b[this.i] === 0xf6 }
  null() { if (this.byte() !== 0xf6) throw new StatementCborError('expected null') }
  /** A non-negative integer (every integer in a statement is). */
  int(what: string): bigint {
    const ib = this.byte()
    if (ib >> 5 !== 0) throw new StatementCborError(`${what}: expected a non-negative integer`)
    return this.arg(ib & 31, what)
  }
  array(what: string): number { return Number(this.head(4, what)) }
  arrayOf(n: number, what: string) {
    const got = this.array(what)
    if (got !== n) throw new StatementCborError(`${what}: expected ${n} fields, got ${got}`)
  }
  bytes(what: string, len?: number): string {
    const n = Number(this.head(2, what))
    if (this.i + n > this.b.length) throw new StatementCborError(`${what}: truncated`)
    if (len !== undefined && n !== len) throw new StatementCborError(`${what}: must be ${len} bytes`)
    let s = ''
    for (let k = 0; k < n; k++) s += this.b[this.i + k].toString(16).padStart(2, '0')
    this.i += n
    return s
  }
  end() { if (this.i !== this.b.length) throw new StatementCborError('trailing bytes') }
}

function safeNumber(v: bigint, what: string): number {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new StatementCborError(`${what} out of range`)
  return Number(v)
}

/** The JSON wire form of `tari_bor` statement bytes — equal to the Rust tool's `--decode` output. */
export function decodeStatement(bytes: Uint8Array): StatementJson {
  const r = new Reader(bytes)
  r.arrayOf(4, 'statement')

  r.arrayOf(2, 'inputs statement')
  const nIn = r.array('inputs')
  const inputs: StatementInputJson[] = []
  for (let k = 0; k < nIn; k++) {
    r.arrayOf(2, 'input')
    const commitment = r.bytes('input commitment', 32)
    r.arrayOf(2, 'spend witness')
    if (r.int('spend witness variant') !== 0n) throw new StatementCborError('only key-path inputs are supported')
    r.arrayOf(0, 'key path')
    inputs.push({ commitment, witness: 'KeyPath' })
  }
  const revealedAmount = r.int('revealed_amount')

  r.arrayOf(3, 'outputs statement')
  const nOut = r.array('outputs')
  const outputs: StealthOutputJson[] = []
  for (let k = 0; k < nOut; k++) {
    r.arrayOf(3, 'stealth output')
    const fields = r.array('unspent output')
    if (fields !== 4 && fields !== 5) throw new StatementCborError('unspent output: unexpected field count')
    const commitment = r.bytes('output commitment', 32)
    const nonce = r.bytes('sender public nonce', 32)
    const encrypted = r.bytes('encrypted data')
    const promise = safeNumber(r.int('minimum_value_promise'), 'minimum_value_promise')
    if (fields === 5) {
      if (!r.peekNull()) throw new StatementCborError('viewable balance proofs are not supported')
      r.null()
    }
    r.arrayOf(2, 'spend authorisation')
    if (r.int('spend authorisation variant') !== 0n) throw new StatementCborError('only key spend authorisations are supported')
    r.arrayOf(1, 'key authorisation')
    const key = r.bytes('spend key', 32)
    const tag = r.int('output tag')
    if (tag < 0n || tag > U32_MAX) throw new StatementCborError('output tag out of range')
    outputs.push({
      output: { commitment, sender_public_nonce: nonce, encrypted_data: encrypted, minimum_value_promise: promise, viewable_balance_proof: null },
      auth: { Key: key },
      tag: Number(tag),
    })
  }
  let revealedOutput: StatementJson['outputs_statement']['revealed_output'] = null
  if (r.peekNull()) r.null()
  else {
    r.arrayOf(2, 'revealed output')
    const amount = r.int('revealed output amount')
    revealedOutput = { amount: amount.toString(), receiver: r.bytes('revealed output receiver', 32) }
  }
  const rangeProof = r.bytes('range proof')

  let balanceProof: StatementJson['balance_proof'] = null
  if (r.peekNull()) r.null()
  else {
    r.arrayOf(2, 'balance proof')
    balanceProof = { public_nonce: r.bytes('balance proof nonce', 32), signature: r.bytes('balance proof signature', 32) }
  }

  if (r.array('covenant claims') !== 0) throw new StatementCborError('covenant claims are not supported')
  r.end()

  return {
    inputs_statement: { inputs, revealed_amount: revealedAmount.toString() },
    outputs_statement: { outputs, revealed_output: revealedOutput, agg_range_proof: rangeProof },
    balance_proof: balanceProof,
    covenant_claims: [],
  }
}

/**
 * The checks the Order makes of a maker's payout at placement (check_payout), read here so a taker's
 * safety check can state them too: no private inputs, reveals exactly `owed`, reveals nothing out,
 * exactly one private output, a balance proof, no covenant claims. Returns that one output's
 * commitment (hex) — the substate the fill will create, which must not already exist.
 */
export function payoutCommitment(statement: StatementJson, owed: bigint): string {
  if (statement.inputs_statement.inputs.length !== 0) throw new StatementCborError('the payout spends private inputs')
  if (BigInt(statement.inputs_statement.revealed_amount) !== owed) throw new StatementCborError('the payout does not pay exactly what is owed')
  if (statement.outputs_statement.revealed_output !== null) throw new StatementCborError('the payout reveals funds')
  if (statement.outputs_statement.outputs.length !== 1) throw new StatementCborError('the payout must create exactly one private output')
  if (statement.balance_proof === null) throw new StatementCborError('the payout carries no balance proof')
  return statement.outputs_statement.outputs[0].output.commitment
}
