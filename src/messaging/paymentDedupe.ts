// One payment, one card, one Activity row — however many times it was announced.
//
// A payment message carries the recipient's UTXO id (PaymentRef). The SAME payment can arrive in
// several messages: a sender that pressed Send repeatedly before the in-flight lock existed (see
// crypto/actionLock) submitted one transaction and announced it once per press, and old clients will
// keep doing so. Every one of those messages names the same output, so every card resolved the same
// amount and Activity showed "+500" once per message. They are one payment, and render once: the
// EARLIEST message per (direction, UTXO) wins, and the rest are dropped from the thread and from
// Activity alike.
//
// AND ONLY A PAYMENT THAT LANDED IS SHOWN. A message can name an output that never came to exist —
// an attempt that failed, from an older client that announced before confirming. The UTXO id is
// checked on chain (usePaymentResolution); a card or row appears once the output is CONFIRMED there
// (resolved, or already spent), never for one that is not there or is not addressed to us. While the
// check runs nothing is drawn, and a payment that cannot be checked because the network is down
// keeps its card with a retry — unknown is not the same as absent.

import type { ResolveState } from '../hooks/usePaymentResolution'
import { compareMessages, type CaravelMessage } from './types'

/** The identity of a payment within a message list: which way it went, and the output it names. */
export function paymentKey(m: Pick<CaravelMessage, 'direction' | 'payment'>): string | null {
  const utxo = m.payment?.utxoId
  return utxo ? `${m.direction}:${utxo}` : null
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

/**
 * Should a RECEIVED payment's card (and its Activity row) be drawn, given what the chain said?
 *
 *   resolved            yes — the output is ours and on chain
 *   failed: spent       yes — it existed (and has since been spent)
 *   network_error       yes — could not check; unknown is not absent, so it stays with a retry
 *   loading / not_found no  — not confirmed yet; drawn the moment it is
 *   failed: not_found   no  — no such output: the payment never landed
 *   failed: unreadable  no  — an output that is not addressed to this wallet is not a payment to it
 */
export function receivedPaymentVisible(state: ResolveState): boolean {
  switch (state.kind) {
    case 'resolved': return true
    case 'loading': return false
    case 'retrying': return state.reason === 'network_error'
    case 'failed': return state.reason === 'spent' || state.reason === 'network_error'
  }
}
