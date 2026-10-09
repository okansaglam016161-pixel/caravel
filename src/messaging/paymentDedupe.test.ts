// The recipient side of a hammered Send: one card and one Activity row per payment, and only for a
// payment that landed.

import { describe, expect, it } from 'vitest'
import { buildActivity } from '../crypto/activity'
import type { ResolveState } from '../hooks/usePaymentResolution'
import {
  dedupePaymentMessages, disputedUtxos, isOwnOutputClaim, ownOutputIds, paymentKey, receivedPaymentVisible,
} from './paymentDedupe'
import { draftToEntry } from '../crypto/journal'
import type { CaravelMessage } from './types'

const SENDER = 'cc'.repeat(32)
const ME = 'dd'.repeat(32)

function received(i: number, utxoId: string, over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: `msg_${i}`, direction: 'received', plaintext: '💸 Payment',
    senderPubkeyHex: SENDER, recipientPubkeyHex: ME,
    timestamp: 1_000 + i, payment: { utxoId },
    ...over,
  } as CaravelMessage
}

function sent(i: number, utxoId: string, txId: string): CaravelMessage {
  return {
    id: `sent_${i}`, direction: 'sent', plaintext: '💸 Payment',
    senderPubkeyHex: ME, recipientPubkeyHex: SENDER,
    timestamp: 1_000 + i, payment: { utxoId },
    localPayment: { amountMicrotari: '500000000', txId },
  } as CaravelMessage
}

/** What the thread draws: one card per message that survives dedupe AND is visible once resolved. */
function cards(messages: CaravelMessage[], resolution: (utxoId: string) => ResolveState) {
  return dedupePaymentMessages(messages).filter(m => m.direction === 'sent' || receivedPaymentVisible(resolution(m.payment!.utxoId)))
}

const landed: ResolveState = { kind: 'resolved', amountMicrotari: '500000000' }
const neverLanded: ResolveState = { kind: 'failed', reason: 'not_found' }

describe('the same payment announced 5 times', () => {
  // Five messages, one transaction, one output: a sender that pressed Send five times.
  const five = [0, 1, 2, 3, 4].map(i => received(i, 'utxo_paid'))

  it('→ one card', () => {
    const shown = cards(five, () => landed)
    expect(shown).toHaveLength(1)
    expect(shown[0].id).toBe('msg_0')        // the earliest announcement is the one kept
  })

  it('→ one "Received" Activity row', () => {
    const rows = buildActivity([], [], five).filter(r => r.kind === 'received')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'received', utxoId: 'utxo_paid', id: 'msg_0' })
  })

  it('keeps the earliest by send time, wherever it sits in the list', () => {
    const shuffled = [five[3], five[1], five[4], five[0], five[2]]
    expect(dedupePaymentMessages(shuffled).map(m => m.id)).toEqual(['msg_0'])
  })

  it('the sender’s own thread and Activity show it once too', () => {
    const mine = [0, 1, 2, 3].map(i => sent(i, 'utxo_paid', 'tx_once'))
    expect(dedupePaymentMessages(mine)).toHaveLength(1)
    expect(buildActivity([], [], mine).filter(r => r.kind === 'sent')).toHaveLength(1)
  })
})

describe('5 payment attempts where only 1 landed', () => {
  // Five announcements naming five different outputs, of which only one exists on chain.
  const attempts = [0, 1, 2, 3, 4].map(i => received(i, `utxo_attempt_${i}`))
  const chain = (utxoId: string): ResolveState => (utxoId === 'utxo_attempt_3' ? landed : neverLanded)

  it('→ one card: the payment that landed', () => {
    const shown = cards(attempts, chain)
    expect(shown.map(m => m.payment!.utxoId)).toEqual(['utxo_attempt_3'])
  })

  it('→ one Activity row: the rows for outputs that do not exist are not drawn', () => {
    const rows = buildActivity([], [], attempts).filter(r => r.kind === 'received')
    const drawn = rows.filter(r => r.kind === 'received' && receivedPaymentVisible(chain(r.utxoId)))
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toMatchObject({ utxoId: 'utxo_attempt_3' })
  })
})

describe('receivedPaymentVisible — only a payment that landed is shown', () => {
  it('shows a confirmed output, one already spent, and one the network could not be asked about', () => {
    expect(receivedPaymentVisible({ kind: 'resolved', amountMicrotari: '1' })).toBe(true)
    expect(receivedPaymentVisible({ kind: 'failed', reason: 'spent' })).toBe(true)
    expect(receivedPaymentVisible({ kind: 'failed', reason: 'network_error' })).toBe(true)
    expect(receivedPaymentVisible({ kind: 'retrying', reason: 'network_error' })).toBe(true)
  })

  it('hides it while unconfirmed, when the output does not exist, and when it is not ours', () => {
    expect(receivedPaymentVisible({ kind: 'loading' })).toBe(false)
    expect(receivedPaymentVisible({ kind: 'retrying', reason: 'not_found' })).toBe(false)
    expect(receivedPaymentVisible({ kind: 'failed', reason: 'not_found' })).toBe(false)
    expect(receivedPaymentVisible({ kind: 'failed', reason: 'unreadable' })).toBe(false)
  })
})

describe('a stranger cannot hide a real payment or take its credit', () => {
  const ALICE = 'aa'.repeat(32)
  const MALLORY = 'ee'.repeat(32)
  // Alice really paid. Mallory names the same output in a message BACKDATED before Alice's.
  const alice = received(5, 'utxo_real', { id: 'alice', senderPubkeyHex: ALICE, timestamp: 5_000 })
  const mallory = received(1, 'utxo_real', { id: 'mallory', senderPubkeyHex: MALLORY, timestamp: 1 })

  it('the real sender’s message is never merged away by another sender’s claim', () => {
    const kept = dedupePaymentMessages([alice, mallory]).map(m => m.id)
    expect(kept).toContain('alice')
  })

  it('the payment still shows once in Activity — but credits neither Alice nor Mallory', () => {
    const rows = buildActivity([], [], [mallory, alice]).filter(r => r.kind === 'received')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ counterparty: 'Received', counterpartyValue: null, utxoId: 'utxo_real' })
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
    const list = [text, text]
    expect(dedupePaymentMessages(list)).toHaveLength(2)
  })
})

describe('a payee claims our change', () => {
  // We paid someone; our send returned change utxo_our_change. The payee (or anyone) then messages
  // us naming that change as "their payment to us".
  const ourSend = {
    ...draftToEntry({
      kind: 'chat-payment', amountMicrotari: 500_000_000n, feeMicrotari: 15_194n, from: 'private', to: 'external',
      counterparty: null, note: null, source: 'local-journal',
      selfOutputIds: ['utxo_our_change'], spentInputIds: ['utxo_spent'],
    }, 1_000),
    outcome: 'committed' as const, txId: 'tx_ours',
  }
  const claim = received(1, 'utxo_our_change')

  it('→ it is recognised as a claim on our own output', () => {
    expect(isOwnOutputClaim(claim, ownOutputIds([ourSend]))).toBe(true)
  })

  it('→ no card: the thread drops it', () => {
    const own = ownOutputIds([ourSend])
    const shown = dedupePaymentMessages([claim]).filter(m => !isOwnOutputClaim(m, own))
    expect(shown).toHaveLength(0)
  })

  it('→ no Activity row', () => {
    expect(buildActivity([ourSend], [], [claim]).filter(r => r.kind === 'received')).toHaveLength(0)
  })

  it('a claim on an output that is NOT ours is unaffected', () => {
    const real = received(2, 'utxo_theirs')
    expect(isOwnOutputClaim(real, ownOutputIds([ourSend]))).toBe(false)
    expect(buildActivity([ourSend], [], [real]).filter(r => r.kind === 'received')).toHaveLength(1)
  })

  it('our own SENT announcement naming our change is not a claim', () => {
    const mine = sent(3, 'utxo_our_change', 'tx_ours')
    expect(isOwnOutputClaim(mine, ownOutputIds([ourSend]))).toBe(false)
  })
})

describe('two senders claim the same output', () => {
  const A = 'a1'.repeat(32), B = 'b2'.repeat(32)
  const fromA = received(1, 'utxo_contested', { id: 'a', senderPubkeyHex: A })
  const fromB = received(2, 'utxo_contested', { id: 'b', senderPubkeyHex: B })
  const againA = received(3, 'utxo_contested', { id: 'a2', senderPubkeyHex: A })

  it('→ the output is disputed', () => {
    expect([...disputedUtxos([fromA, fromB])]).toEqual(['utxo_contested'])
    expect(disputedUtxos([fromA, againA]).size).toBe(0)          // one sender twice is not a dispute
  })

  it('→ ONE Activity row, naming no sender', () => {
    const rows = buildActivity([], [], [fromA, fromB, againA]).filter(r => r.kind === 'received')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ counterparty: 'Received', counterpartyValue: null, id: 'a' })
  })

  it('a single sender’s payment still names them', () => {
    const rows = buildActivity([], [], [fromA, againA]).filter(r => r.kind === 'received')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ counterpartyValue: A })
  })
})
