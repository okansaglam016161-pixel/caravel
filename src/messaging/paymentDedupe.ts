// One payment, one card, one Activity row — however many times it was announced.
//
// A payment message carries the recipient's UTXO id (PaymentRef). The SAME payment can arrive in
// several messages: a sender that pressed Send repeatedly before the in-flight lock existed (see
// crypto/actionLock) submitted one transaction and announced it once per press, and old clients will
// keep doing so. Every one of those messages names the same output, so every card resolved the same
// amount and Activity showed "+500" once per message. They are one payment, and render once: the
// EARLIEST message per (direction, counterparty, UTXO) wins, and the rest are dropped from the thread and from
// Activity alike.
//
// ONLY FROM THE SAME COUNTERPARTY. A message's send time is the sender's claim and is not clamped in
// the past, so "earliest wins" across senders would let anyone hide a real payment's row and take
// its credit: name your output in a message backdated before the real one, and theirs would be the
// one kept. Honest repeats come from one sender, so the key carries who the payment is with — a
// stranger's claim on the same output can never displace the real sender's card or row.
//
// AND ONLY A PAYMENT THAT LANDED IS SHOWN. A message can name an output that never came to exist —
// an attempt that failed, from an older client that announced before confirming. The UTXO id is
// checked on chain (usePaymentResolution); a card or row appears once the output is CONFIRMED there
// (resolved, or already spent), never for one that is not there or is not addressed to us. While the
// check runs nothing is drawn, and a payment that cannot be checked because the network is down
// keeps its card with a retry — unknown is not the same as absent.

// ── WHO A PAYMENT IS FROM CANNOT BE PROVEN ────────────────────────────────────────
//
// A payment message is a CLAIM: "the output utxo_… is my payment to you". Nothing on chain ties a
// confidential output to its sender, so anyone can message a claim naming any output this wallet
// owns. Two rules keep a false claim from taking credit:
//
//   OUR OWN OUTPUTS ARE NEVER A RECEIVED PAYMENT. Change from our own sends (and every other output
//   the journal records this wallet creating) is ours by construction. A message claiming one —
//   say a payee naming our change — gets no card and no Activity row.
//
//   AN OUTPUT CLAIMED BY TWO SENDERS NAMES NEITHER. It is still money that arrived, so Activity shows
//   it once, without a sender; each claimant's chat card says the sender cannot be confirmed instead
//   of crediting them. (Hiding the cards would let a false claim hide the real sender's card.)

import type { JournalEntry } from '../crypto/journal'
import type { ResolveState } from '../hooks/usePaymentResolution'
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

/** Every output the journal records this wallet creating — its own change, by construction. */
export function ownOutputIds(journal: readonly Pick<JournalEntry, 'selfOutputIds'>[]): Set<string> {
  const ids = new Set<string>()
  for (const e of journal) for (const id of e.selfOutputIds ?? []) ids.add(id)
  return ids
}

/** A RECEIVED payment message that claims one of our own outputs as a payment to us. */
export function isOwnOutputClaim(m: Pick<CaravelMessage, 'direction' | 'payment'>, own: ReadonlySet<string>): boolean {
  return m.direction === 'received' && !!m.payment?.utxoId && own.has(m.payment.utxoId)
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
