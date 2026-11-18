// The recipient side of a repeated announcement: one card per payment, and a contested output
// credits nobody.

import { describe, expect, it } from 'vitest'
import { dedupePaymentMessages, disputedUtxos, paymentKey } from './paymentDedupe'
import type { CaravelMessage } from './types'

const SENDER = 'cc'.repeat(32)
const ME = 'dd'.repeat(32)

function received(i: number, utxoId: string, over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: `msg_${i}`, direction: 'received', plaintext: 'Payment',
    senderPubkeyHex: SENDER, recipientPubkeyHex: ME,
    timestamp: 1_000 + i, payment: { utxoId, nonce: '0123456789abcdef', network: 'mainnet' },
    ...over,
  } as CaravelMessage
}

function sent(i: number, utxoId: string, txId: string): CaravelMessage {
  return {
    id: `sent_${i}`, direction: 'sent', plaintext: 'Payment',
    senderPubkeyHex: ME, recipientPubkeyHex: SENDER,
    timestamp: 1_000 + i, payment: { utxoId, nonce: '0123456789abcdef', network: 'mainnet' },
    localPayment: { amountMicrotari: '500000000', txId },
  } as CaravelMessage
}

describe('the same payment announced 5 times', () => {
  const five = [0, 1, 2, 3, 4].map(i => received(i, 'utxo_paid'))

  it('→ one card, the earliest announcement', () => {
    const shown = dedupePaymentMessages(five)
    expect(shown).toHaveLength(1)
    expect(shown[0].id).toBe('msg_0')
  })

  it('keeps the earliest by send time, wherever it sits in the list', () => {
    const shuffled = [five[3], five[1], five[4], five[0], five[2]]
    expect(dedupePaymentMessages(shuffled).map(m => m.id)).toEqual(['msg_0'])
  })

  it('the sender’s own thread shows it once too', () => {
    const mine = [0, 1, 2, 3].map(i => sent(i, 'utxo_paid', 'tx_once'))
    expect(dedupePaymentMessages(mine)).toHaveLength(1)
  })
})

describe('a stranger cannot hide a real payment', () => {
  const ALICE = 'aa'.repeat(32)
  const MALLORY = 'ee'.repeat(32)
  // Alice really paid. Mallory names the same output in a message BACKDATED before Alice's.
  const alice = received(5, 'utxo_real', { id: 'alice', senderPubkeyHex: ALICE, timestamp: 5_000 })
  const mallory = received(1, 'utxo_real', { id: 'mallory', senderPubkeyHex: MALLORY, timestamp: 1 })

  it('the real sender’s message is never merged away by another sender’s claim', () => {
    expect(dedupePaymentMessages([alice, mallory]).map(m => m.id)).toContain('alice')
  })

  it('repeats from the SAME sender still collapse to one', () => {
    const again = received(9, 'utxo_real', { id: 'alice2', senderPubkeyHex: ALICE, timestamp: 9_000 })
    expect(dedupePaymentMessages([alice, again]).map(m => m.id)).toEqual(['alice'])
  })
})

describe('paymentKey / dedupe boundaries', () => {
  it('the same output sent and received are different payments (a payment to yourself)', () => {
    const both = [sent(0, 'utxo_x', 'tx'), received(1, 'utxo_x')]
    expect(dedupePaymentMessages(both)).toHaveLength(2)
    expect(paymentKey(both[0])).not.toBe(paymentKey(both[1]))
  })

  it('messages without a payment pass through untouched', () => {
    const text = { ...received(0, 'u'), payment: undefined } as CaravelMessage
    expect(dedupePaymentMessages([text, text])).toHaveLength(2)
  })
})

describe('two senders claim the same output', () => {
  const A = 'a1'.repeat(32), B = 'b2'.repeat(32)
  const fromA = received(1, 'utxo_contested', { id: 'a', senderPubkeyHex: A })
  const fromB = received(2, 'utxo_contested', { id: 'b', senderPubkeyHex: B })
  const againA = received(3, 'utxo_contested', { id: 'a2', senderPubkeyHex: A })

  it('→ the output is disputed; one sender twice is not', () => {
    expect([...disputedUtxos([fromA, fromB])]).toEqual(['utxo_contested'])
    expect(disputedUtxos([fromA, againA]).size).toBe(0)
  })
})
