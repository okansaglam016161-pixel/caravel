// What a received payment's card shows, which payments get claimed, and which sends are ours — plus
// the two stores behind them (claim outcomes, the outbox), sealed under the chat key.

import { beforeEach, describe, expect, it } from 'vitest'
import { claimCandidates, claimReady, claimView, ownSendTxIds, type SapientReadiness } from './paymentClaims'
import { loadClaims, removeClaims, saveClaim } from './paymentClaimStore'
import { addOutbox, loadOutbox, outboxTxIds, removeOutbox, updateOutbox, type OutboxEntry } from './paymentOutbox'
import { clearStoreKey, setStoreKey } from '../crypto/sessionKey'
import type { CaravelMessage } from './types'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

const ME = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const STRANGER = 'c'.repeat(64)
const U1 = `utxo_${'01'.repeat(32)}_${'aa'.repeat(32)}`
const U2 = `utxo_${'01'.repeat(32)}_${'bb'.repeat(32)}`
const ref = (utxoId: string, network = 'mainnet') => ({ utxoId, nonce: '0123456789abcdef', network })

const READY: SapientReadiness = { status: 'connected', network: 'mainnet', viewAccess: 'granted' }

function msg(over: Partial<CaravelMessage>): CaravelMessage {
  return {
    id: Math.random().toString(36), senderPubkeyHex: PEER, recipientPubkeyHex: ME, plaintext: 'paid',
    timestamp: 1, direction: 'received', ...over,
  } as CaravelMessage
}

describe('claimView — what the card says', () => {
  it('a stored outcome wins over everything', () => {
    expect(claimView(ref(U1), { s: 'verified', amount: '5' }, 'claiming', { ...READY, status: 'missing' })).toEqual({ s: 'verified', amount: '5' })
  })

  it('in flight shows as claiming or retrying', () => {
    expect(claimView(ref(U1), undefined, 'retrying', READY)).toEqual({ s: 'retrying' })
  })

  it('says what Sapient needs: install, connect (or unlock), the right network, view access', () => {
    expect(claimView(ref(U1), undefined, undefined, { ...READY, status: 'missing' })).toEqual({ s: 'needs-sapient', why: 'install' })
    expect(claimView(ref(U1), undefined, undefined, { ...READY, status: 'disconnected' })).toEqual({ s: 'needs-sapient', why: 'connect' })
    expect(claimView(ref(U1, 'esmeralda'), undefined, undefined, READY)).toEqual({ s: 'needs-sapient', why: 'network', network: 'esmeralda' })
    expect(claimView(ref(U1), undefined, undefined, { ...READY, viewAccess: 'off' })).toEqual({ s: 'needs-sapient', why: 'view' })
  })

  // BUG 1 (mainnet): with the receiver's Sapient locked, the card said "Confirming with Sapient…"
  // forever. Locked is now its own Sapient status, and the card says what to do.
  it('BUG 1: a LOCKED Sapient says "unlock", not "Confirming…"', () => {
    expect(claimView(ref(U1), undefined, undefined, { ...READY, status: 'locked' })).toEqual({ s: 'needs-sapient', why: 'unlock' })
    expect(claimReady({ ...READY, status: 'locked' }, ref(U1))).toBe(false)
  })

  it('a failed attempt shows as an error (with Retry) — unless the wallet is locked, which says so instead', () => {
    expect(claimView(ref(U1), undefined, 'error', READY)).toEqual({ s: 'error' })
    expect(claimView(ref(U1), undefined, 'error', { ...READY, status: 'locked' })).toEqual({ s: 'needs-sapient', why: 'unlock' })
  })

  it('ready and nothing stored: queued to claim', () => {
    expect(claimView(ref(U1), undefined, undefined, READY)).toEqual({ s: 'claiming' })
    expect(claimReady(READY, ref(U1))).toBe(true)
    expect(claimReady(READY, ref(U1, 'igor'))).toBe(false)
  })
})

describe('claimCandidates — which payments get claimed', () => {
  it('received one-to-one payments from accepted contacts, one per output', () => {
    const messages = [
      msg({ payment: ref(U1) }),
      msg({ payment: ref(U1) }),                                   // the same output announced twice
      msg({ payment: ref(U2), senderPubkeyHex: STRANGER }),        // a pending request — not yet
      msg({ payment: ref(U2), groupId: 'g' }),                     // groups carry no payments
      msg({ payment: ref(U2), direction: 'sent' }),                // our own send
      msg({}),                                                     // no payment
    ]
    const out = claimCandidates(messages, { [STRANGER]: { state: 'pending', updatedAt: 1 } })
    expect(out.map(r => r.utxoId)).toEqual([U1])
  })

  it('a stored pre-v2 row (no nonce) is never claimed', () => {
    const old = msg({ payment: { utxoId: U1 } as unknown as CaravelMessage['payment'] })
    expect(claimCandidates([old], {})).toEqual([])
  })

  it('a contact with no record but messages counts as accepted (the lazy rule)', () => {
    expect(claimCandidates([msg({ payment: ref(U1) })], {}).length).toBe(1)
  })
})

describe('ownSendTxIds — never credited back to us', () => {
  it('collects our sent payments\' local txIds and the outbox\'s', () => {
    const ids = ownSendTxIds([
      msg({ direction: 'sent', localPayment: { amountMicrotari: '1', txId: 'tx-sent' } }),
      msg({ localPayment: { amountMicrotari: '1', txId: 'not-ours' } }),
    ], ['tx-outbox'])
    expect([...ids].sort()).toEqual(['tx-outbox', 'tx-sent'])
  })
})

describe('the stores, sealed under the chat key', () => {
  beforeEach(() => {
    globalThis.localStorage = memoryStorage()
    setStoreKey(new Uint8Array(32).fill(5), 'chat')
  })

  it('outcomes stored under v1 (which could hold a genuine payment as "not verified") are not read back', () => {
    localStorage.setItem(`caravel.payclaims.v1.${ME}`, 'anything')
    expect(loadClaims(ME)).toEqual({})
  })

  it('claim outcomes round-trip, encrypted, and can be forgotten', () => {
    saveClaim(ME, U1, { s: 'verified', amount: '1500000' })
    saveClaim(ME, U2, { s: 'unverified', amount: null, reason: 'memo' })
    expect(localStorage.getItem(`caravel.payclaims.v2.${ME}`)).not.toContain('1500000')
    expect(loadClaims(ME)).toEqual({ [U1]: { s: 'verified', amount: '1500000' }, [U2]: { s: 'unverified', amount: null, reason: 'memo' } })
    removeClaims(ME, [U1])
    expect(Object.keys(loadClaims(ME))).toEqual([U2])
  })

  it('the outbox keeps an entry through requestId and result until removed', () => {
    const entry: OutboxEntry = {
      id: 'o1', peerHex: PEER, recipient: 'otl_1x', amount: '1500000', nonce: '0123456789abcdef',
      network: 'mainnet', note: 'hi', createdAt: 1, requestId: null, result: null,
    }
    expect(addOutbox(ME, entry)).toBe(true)
    updateOutbox(ME, 'o1', { requestId: 'r1' })
    updateOutbox(ME, 'o1', { result: { transactionId: 'tx1', recipientSubstateId: U1 } })
    expect(loadOutbox(ME)).toEqual([{ ...entry, requestId: 'r1', result: { transactionId: 'tx1', recipientSubstateId: U1 } }])
    expect(outboxTxIds(ME)).toEqual(['tx1'])
    expect(localStorage.getItem(`caravel.payoutbox.v1.${ME}`)).not.toContain('otl_1x')
    removeOutbox(ME, 'o1')
    expect(loadOutbox(ME)).toEqual([])
  })

  it('an outbox that cannot be written says so — the caller must not pay', () => {
    clearStoreKey('chat')
    expect(addOutbox(ME, {
      id: 'o2', peerHex: PEER, recipient: 'otl_1x', amount: '1', nonce: '0123456789abcdef',
      network: 'mainnet', note: '', createdAt: 1, requestId: null, result: null,
    })).toBe(false)
  })
})
