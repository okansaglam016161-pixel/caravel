// One payment, one card — however many times it was announced.
//
// A payment message carries the recipient's UTXO id (PaymentRef). The SAME payment can arrive in
// several messages (a sender retrying, an outbox resend after a reload). Every one names the same
// output, so they render once: the EARLIEST message per (direction, counterparty, UTXO) wins.
//
// ONLY FROM THE SAME COUNTERPARTY. A message's send time is the sender's claim and is not clamped in
// the past, so "earliest wins" across senders would let anyone hide a real payment's card by naming
// its output in a backdated message. The key carries who the payment is with, so a stranger's claim
// on the same output can never displace the real sender's card.
//
// AN OUTPUT CLAIMED BY TWO SENDERS NAMES NEITHER. Nothing on chain ties a confidential output to its
// sender, so each claimant's card says the sender cannot be confirmed instead of crediting them.
// (Whether a payment is OURS and carries the message's nonce is the claim's job: sapient/payments.)

import { compareMessages, type CaravelMessage } from './types'

/**
 * The identity of a payment within a message list: which way it went, who it is with, and the
 * output it names.
 */
export function paymentKey(m: Pick<CaravelMessage, 'direction' | 'payment' | 'senderPubkeyHex' | 'recipientPubkeyHex'>): string | null {
  const utxo = m.payment?.utxoId
  if (!utxo) return null
  const counterparty = m.direction === 'received' ? m.senderPubkeyHex : m.recipientPubkeyHex
  return `${m.direction}:${counterparty ?? ''}:${utxo}`
}

/**
 * The messages with every repeat announcement of a payment removed — the earliest one per payment
 * is kept. Order is preserved; messages without a payment pass through untouched.
 */
export function dedupePaymentMessages<T extends CaravelMessage>(messages: readonly T[]): T[] {
  const first = new Map<string, T>()
  for (const m of messages) {
    const key = paymentKey(m)
    if (key === null) continue
    const held = first.get(key)
    if (!held || compareMessages(m, held) < 0) first.set(key, m)
  }
  return messages.filter(m => {
    const key = paymentKey(m)
    return key === null || first.get(key) === m
  })
}

/** Outputs that more than one sender claims as their payment to us. */
export function disputedUtxos(messages: readonly Pick<CaravelMessage, 'direction' | 'payment' | 'senderPubkeyHex'>[]): Set<string> {
  const senders = new Map<string, Set<string>>()
  for (const m of messages) {
    const utxo = m.direction === 'received' ? m.payment?.utxoId : undefined
    if (!utxo) continue
    const set = senders.get(utxo) ?? new Set<string>()
    set.add(m.senderPubkeyHex)
    senders.set(utxo, set)
  }
  return new Set([...senders].filter(([, s]) => s.size > 1).map(([u]) => u))
}
