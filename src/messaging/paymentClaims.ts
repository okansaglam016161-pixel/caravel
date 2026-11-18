// Which received chat payments to claim, and what each one's card says — pure, so it is testable.
// The claiming itself runs in hooks/usePaymentClaimer; the Sapient calls are sapient/payments.

import type { CaravelMessage, PaymentRef } from './types'
import type { ContactMap } from './contactStore'
import type { StoredClaim } from './paymentClaimStore'

/** What a received payment's card shows. */
export type ClaimView =
  | StoredClaim
  | { s: 'claiming' }
  /** Not found yet — waiting out indexer lag before asking again. */
  | { s: 'retrying' }
  /** Sapient cannot confirm it right now, and why — the card says what to do. */
  | { s: 'needs-sapient'; why: 'install' | 'connect' | 'view' | 'network'; network?: string }

/** The parts of the Sapient connection a card's state depends on. */
export interface SapientReadiness {
  status: 'detecting' | 'missing' | 'disconnected' | 'connecting' | 'connected'
  network: string | null
  viewAccess: 'unknown' | 'off' | 'requesting' | 'granted'
}

export function claimReady(s: SapientReadiness, ref: Pick<PaymentRef, 'network'>): boolean {
  return s.status === 'connected' && s.viewAccess === 'granted' && s.network === ref.network
}

/**
 * A card's state: a stored outcome wins; then whatever is in flight; then what Sapient needs before
 * it can confirm; otherwise it is queued to be claimed.
 */
export function claimView(
  ref: Pick<PaymentRef, 'network'>, stored: StoredClaim | undefined, busy: 'claiming' | 'retrying' | undefined, s: SapientReadiness,
): ClaimView {
  if (stored) return stored
  if (busy) return { s: busy }
  if (s.status === 'missing') return { s: 'needs-sapient', why: 'install' }
  if (s.status !== 'connected') return { s: 'needs-sapient', why: 'connect' }
  if (s.network !== ref.network) return { s: 'needs-sapient', why: 'network', network: ref.network }
  if (s.viewAccess !== 'granted') return { s: 'needs-sapient', why: 'view' }
  return { s: 'claiming' }
}

/**
 * The payments to claim: received, one-to-one (groups carry no payments), from a contact this person
 * has ACCEPTED. A pending request's payment is not claimed until they accept — the same rule that
 * keeps chat from doing network work on a stranger's behalf. One per output.
 */
export function claimCandidates(messages: readonly CaravelMessage[], contacts: ContactMap): PaymentRef[] {
  const seen = new Set<string>()
  const out: PaymentRef[] = []
  for (const m of messages) {
    if (m.direction !== 'received' || !m.payment || m.groupId) continue
    // A row stored before payment tag v2 has no nonce to check against: never claimed.
    if (!m.payment.nonce || !m.payment.network) continue
    if (contacts[m.senderPubkeyHex]?.state === 'pending') continue
    if (seen.has(m.payment.utxoId)) continue
    seen.add(m.payment.utxoId)
    out.push(m.payment)
  }
  return out
}

/** Our own sends' transaction ids — never credited back to us as someone else's payment. */
export function ownSendTxIds(messages: readonly CaravelMessage[], outboxTxIds: readonly string[]): Set<string> {
  const ids = new Set(outboxTxIds)
  for (const m of messages) if (m.direction === 'sent' && m.localPayment?.txId) ids.add(m.localPayment.txId)
  return ids
}
