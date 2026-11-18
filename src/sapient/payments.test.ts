// Chat payments through Sapient, against a scripted fake provider: the request loop's every ending,
// what a send and a shield ask for, and the claim — including "already claimed", our own change, and
// a memo that does not carry the message's nonce.

import { describe, expect, it } from 'vitest'
import {
  assertPayableAddress, claimPayment, insufficientPrivateBalance, makePaymentNonce, memoMatches,
  parseSubstateId, parseTari, paymentMemo, readRequest, runTransactionRequest, sendPrivately, shield,
} from './payments'
import { TARI_RESOURCE, type TariProvider } from './provider'

const RES = '01'.repeat(32)
const COMMIT = 'ab'.repeat(32)
const UTXO = `utxo_${RES}_${COMMIT}`
const NONCE = '0123456789abcdef'
const noSleep = async () => {}

/** A provider whose answers come from a script: method → value, an error, or a list consumed in order. */
function scripted(script: Record<string, unknown>) {
  const calls: { method: string; params?: unknown }[] = []
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, Array.isArray(v) && k === 'tari_getTransactionRequest' ? [...v] : v]))
  const p: TariProvider = {
    async request({ method, params }) {
      calls.push(params === undefined ? { method } : { method, params })
      let a = queues.get(method)
      if (Array.isArray(a) && method === 'tari_getTransactionRequest') a = (a as unknown[]).length > 1 ? (a as unknown[]).shift() : (a as unknown[])[0]
      if (a && typeof a === 'object' && 'message' in (a as object) && !('status' in (a as object))) throw a
      return a
    },
  }
  return { p, calls }
}

describe('amounts, nonce, memo', () => {
  it('parses TARI exactly, refusing more than 6 decimals', () => {
    expect(parseTari('1.5')).toBe(1_500_000n)
    expect(parseTari('0.000001')).toBe(1n)
    expect(parseTari(' 12 ')).toBe(12_000_000n)
    expect(() => parseTari('1.0000001')).toThrow()
    expect(() => parseTari('-1')).toThrow()
    expect(() => parseTari('1e3')).toThrow()
  })

  it('a nonce is 16 hex characters, and only the exact memo matches it', () => {
    const n = makePaymentNonce()
    expect(n).toMatch(/^[0-9a-f]{16}$/)
    expect(makePaymentNonce()).not.toBe(n)
    expect(memoMatches(paymentMemo(n), n)).toBe(true)
    expect(memoMatches(`${paymentMemo(n)} `, n)).toBe(false)
    expect(memoMatches(undefined, n)).toBe(false)
    expect(memoMatches('caravel:0000000000000000', n)).toBe(false)
  })

  it('reads the shortfall out of Sapient\'s "exceeds your private balance" error', () => {
    expect(insufficientPrivateBalance('Amount exceeds your private balance (you have 2500000).')).toBe(2_500_000n)
    expect(insufficientPrivateBalance('Wallet is locked.')).toBeNull()
  })
})

describe('addresses and substate ids', () => {
  const parse = (network: number) => () => ({ owner_key: new Uint8Array(32), view_key: new Uint8Array(32), network })

  it('refuses an address on a different network than Sapient\'s, by its network byte', () => {
    expect(() => assertPayableAddress('otl_esm_x', 'mainnet', parse(38))).toThrow(/Esmeralda, but your wallet is on Mainnet/)
    expect(() => assertPayableAddress('otl_x', 'mainnet', parse(0))).not.toThrow()
    expect(() => assertPayableAddress('otl_esm_x', 'esmeralda', parse(38))).not.toThrow()
  })

  it('refuses empty, unparseable and malformed addresses', () => {
    expect(() => assertPayableAddress('  ', 'mainnet', parse(0))).toThrow(/Enter the address/)
    expect(() => assertPayableAddress('nope', 'mainnet', () => { throw new Error('x') })).toThrow(/valid Tari address/)
    expect(() => assertPayableAddress('otl_x', 'mainnet', () => ({ owner_key: new Uint8Array(31), view_key: new Uint8Array(32), network: 0 }))).toThrow(/malformed/)
  })

  it('splits a stealth utxo id into the claim\'s resource and commitment', () => {
    expect(parseSubstateId(UTXO)).toEqual({ resourceAddress: `resource_${RES}`, commitment: COMMIT })
    expect(parseSubstateId('component_x')).toBeNull()
  })
})

describe('the request loop', () => {
  const RESULT = { transactionId: 'tx1', recipientCommitment: COMMIT, recipientSubstateId: UTXO, minimumValuePromise: '0' }

  it('pending → approved → submit, reporting the request id and each phase', async () => {
    const { p, calls } = scripted({
      tari_createTransactionRequest: { requestId: 'r1' },
      tari_getTransactionRequest: [{ status: 'pending' }, { status: 'approved' }],
      tari_submitTransactionRequest: RESULT,
    })
    const phases: string[] = []
    let rid = ''
    const out = await runTransactionRequest(p, { kind: 'x' }, { sleep: noSleep, onRequest: r => { rid = r }, onPhase: ph => phases.push(ph) })
    expect(out).toEqual(RESULT)
    expect(rid).toBe('r1')
    expect(phases).toEqual(['approve', 'finalizing'])
    expect(calls.filter(c => c.method === 'tari_submitTransactionRequest')).toHaveLength(1)
  })

  it('a submit that lost the race is polled to its submitted result', async () => {
    const { p } = scripted({
      tari_createTransactionRequest: { requestId: 'r1' },
      tari_getTransactionRequest: [{ status: 'approved' }, { status: 'submitted', result: RESULT }],
      tari_submitTransactionRequest: { code: -32603, message: 'Request status is "submitting"' },
    })
    expect(await runTransactionRequest(p, {}, { sleep: noSleep })).toEqual(RESULT)
  })

  it('a rejection in the popup is "declined"; a failure carries Sapient\'s reason; an expiry says so', async () => {
    await expect(runTransactionRequest(scripted({ tari_createTransactionRequest: { requestId: 'r' }, tari_getTransactionRequest: [{ status: 'rejected' }] }).p, {}, { sleep: noSleep }))
      .rejects.toMatchObject({ kind: 'declined' })
    await expect(runTransactionRequest(scripted({ tari_createTransactionRequest: { requestId: 'r' }, tari_getTransactionRequest: [{ status: 'failed', error: 'Insufficient fee' }] }).p, {}, { sleep: noSleep }))
      .rejects.toMatchObject({ kind: 'wallet', message: 'Insufficient fee' })
    await expect(runTransactionRequest(scripted({ tari_createTransactionRequest: { requestId: 'r' }, tari_getTransactionRequest: [{ status: 'odd', expiresAt: 1 }] }).p, {}, { sleep: noSleep }))
      .rejects.toThrow('Request expired.')
  })

  it('resuming reads a request ONCE and never submits: submitted, approved, waiting, gone', async () => {
    const one = (status: unknown) => scripted({ tari_getTransactionRequest: [status] })
    const sub = one({ status: 'submitted', result: { transactionId: 't' } })
    expect(await readRequest(sub.p, 'r')).toEqual({ s: 'submitted', result: { transactionId: 't' } })
    const appr = one({ status: 'approved' })
    expect(await readRequest(appr.p, 'r')).toEqual({ s: 'approved' })
    expect(appr.calls.some(c => c.method === 'tari_submitTransactionRequest')).toBe(false)
    expect(await readRequest(one({ status: 'pending' }).p, 'r')).toEqual({ s: 'waiting' })
    expect(await readRequest(one({ status: 'submitting' }).p, 'r')).toEqual({ s: 'waiting' })
    expect(await readRequest(one({ status: 'expired' }).p, 'r')).toEqual({ s: 'gone' })
    expect(await readRequest(one({ code: 4100, message: 'Wallet is locked.' }).p, 'r')).toEqual({ s: 'waiting' })
    expect(await readRequest(one({ code: -32603, message: 'Unknown request.' }).p, 'r')).toEqual({ s: 'gone' })
  })
})

describe('send and shield', () => {
  it('sendPrivately asks for TARI to the address, with the amount as a string and our memo', async () => {
    const { p, calls } = scripted({
      tari_createTransactionRequest: { requestId: 'r' },
      tari_getTransactionRequest: [{ status: 'submitted', result: { transactionId: 't', recipientCommitment: COMMIT, recipientSubstateId: UTXO } }],
    })
    const r = await sendPrivately(p, { recipient: 'otl_1x', amount: 1_500_000n, nonce: NONCE }, { sleep: noSleep })
    expect(r).toEqual({ transactionId: 't', recipientCommitment: COMMIT, recipientSubstateId: UTXO })
    expect(calls[0]).toEqual({ method: 'tari_createTransactionRequest', params: {
      kind: 'sendPrivately', resourceAddress: TARI_RESOURCE, recipientWalletAddress: 'otl_1x', amount: '1500000', memo: `caravel:${NONCE}`,
    } })
  })

  it('shield asks to make TARI private, with no memo', async () => {
    const { p, calls } = scripted({ tari_createTransactionRequest: { requestId: 'r' }, tari_getTransactionRequest: [{ status: 'submitted', result: {} }] })
    await shield(p, 2_000_000n, { sleep: noSleep })
    expect(calls[0]).toEqual({ method: 'tari_createTransactionRequest', params: { kind: 'shield', resourceAddress: TARI_RESOURCE, amount: '2000000' } })
  })
})

describe('claimPayment', () => {
  const ref = { utxoId: UTXO, nonce: NONCE }

  it('a fresh claim with our memo is verified', async () => {
    const { p, calls } = scripted({ tari_claimPrivatePayment: { amount: '1500000', memo: `caravel:${NONCE}` } })
    expect(await claimPayment(p, ref, new Set())).toEqual({ s: 'verified', amount: '1500000' })
    expect(calls[0]).toEqual({ method: 'tari_claimPrivatePayment', params: { resourceAddress: `resource_${RES}`, commitment: COMMIT } })
  })

  it('a fresh claim whose memo does not carry this nonce is NOT credited', async () => {
    const { p } = scripted({ tari_claimPrivatePayment: { amount: '1500000', memo: 'caravel:ffffffffffffffff' } })
    expect(await claimPayment(p, ref, new Set())).toEqual({ s: 'unverified', amount: '1500000', reason: 'memo' })
  })

  it('"already claimed" is success: amount and memo come from the shielded outputs', async () => {
    const { p } = scripted({
      tari_claimPrivatePayment: { code: -32603, message: "You've already claimed this payment." },
      tari_getShieldedOutputs: [{ commitment: COMMIT, amount: '700000', memo: `caravel:${NONCE}`, transactionId: 'their-tx' }],
    })
    expect(await claimPayment(p, ref, new Set(['some-other-tx']))).toEqual({ s: 'verified', amount: '700000' })
  })

  it('"already claimed" on one of OUR OWN sends is refused, whatever its memo says', async () => {
    const { p } = scripted({
      tari_claimPrivatePayment: { code: -32603, message: "You've already claimed this payment." },
      tari_getShieldedOutputs: [{ commitment: COMMIT, amount: '700000', memo: `caravel:${NONCE}`, transactionId: 'our-tx' }],
    })
    expect(await claimPayment(p, ref, new Set(['our-tx']))).toEqual({ s: 'unverified', amount: '700000', reason: 'own-send' })
  })

  it('our change — no memo — never verifies', async () => {
    const { p } = scripted({
      tari_claimPrivatePayment: { code: -32603, message: "You've already claimed this payment." },
      tari_getShieldedOutputs: [{ commitment: COMMIT, amount: '5', transactionId: 'x' }],
    })
    expect(await claimPayment(p, ref, new Set())).toEqual({ s: 'unverified', amount: '5', reason: 'memo' })
  })

  it('"already claimed" but no longer unspent cannot be verified', async () => {
    const { p } = scripted({ tari_claimPrivatePayment: { code: -32603, message: "You've already claimed this payment." }, tari_getShieldedOutputs: [] })
    expect(await claimPayment(p, ref, new Set())).toEqual({ s: 'unverified', amount: null, reason: 'spent' })
  })

  it('not ours or not on chain is "not-found"; anything else is thrown for the caller to retry', async () => {
    const nf = scripted({ tari_claimPrivatePayment: { code: -32603, message: "This commitment doesn't belong to your account, or wasn't found on-chain." } })
    expect(await claimPayment(nf.p, ref, new Set())).toEqual({ s: 'not-found' })
    const locked = scripted({ tari_claimPrivatePayment: { code: 4100, message: 'Wallet is locked.' } })
    await expect(claimPayment(locked.p, ref, new Set())).rejects.toMatchObject({ kind: 'locked' })
  })
})
