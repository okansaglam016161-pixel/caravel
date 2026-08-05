// Derives the wallet Activity list from the two AUTHORITATIVE sources of payment knowledge:
//   1. wallet-modal sends (SentEntry) — outflows we initiated locally,
//   2. message-linked payments (CaravelMessage.payment) — chat sends (outflows) + received payments
//      (inflows), each announced over Nostr and therefore attributable to a real counterparty.
// The blind UTXO scan is deliberately NOT a source: a confidential UTXO carries no sender, so the
// scan cannot tell an incoming payment from our own change output. Only message-linked refs can.

import type { CaravelMessage } from '../messaging/types'
import type { SentEntry } from './txHistory'
import * as nip19 from 'nostr-tools/nip19'

// npub1abcd…wxyz — never throws (blank/invalid hex falls back to a raw prefix).
function shortNpub(peerHex: string): string {
  try {
    const npub = nip19.npubEncode(peerHex)
    return npub.slice(0, 12) + '…' + npub.slice(-4)
  } catch { return peerHex.slice(0, 10) + '…' }
}

function shortAddr(addr: string): string {
  return addr.length > 16 ? `${addr.slice(0, 10)}…${addr.slice(-4)}` : addr
}

export type ActivityRow =
  | {
      kind: 'sent'
      id: string
      counterparty: string
      note: string
      timestamp: number
      amountMicrotari: bigint | null            // null = sent from another device (amount not cached here)
      outcome: 'Commit' | 'Reject' | 'Timeout' | null  // null = chat send (outcome not tracked yet)
    }
  | {
      kind: 'received'
      id: string
      counterparty: string
      note: string
      timestamp: number
      utxoId: string                            // resolved to an amount lazily by the Activity row
    }

/** Merge the two authoritative sources into one newest-first Activity list. */
export function buildActivity(sent: SentEntry[], messages: CaravelMessage[]): ActivityRow[] {
  const rows: ActivityRow[] = []

  // Outflows initiated in the wallet modal.
  for (const e of sent) {
    rows.push({
      kind: 'sent',
      id: e.id,
      counterparty: `Sent to ${shortAddr(e.recipient)}`,
      note: e.note,
      timestamp: e.timestamp,
      amountMicrotari: e.amountMicrotari,
      outcome: e.outcome,
    })
  }

  // Message-linked payments: chat sends (outflows) and received payments (inflows).
  for (const m of messages) {
    if (!m.payment?.utxoId) continue
    if (m.direction === 'sent') {
      rows.push({
        kind: 'sent',
        id: m.id,
        counterparty: m.recipientPubkeyHex ? `Sent to ${shortNpub(m.recipientPubkeyHex)}` : 'Sent from another device',
        note: m.plaintext,
        timestamp: m.timestamp,
        // localPayment is a this-device cache (never on the wire); absent for other-device sends.
        amountMicrotari: m.localPayment ? BigInt(m.localPayment.amountMicrotari) : null,
        outcome: null,
      })
    } else {
      rows.push({
        kind: 'received',
        id: m.id,
        counterparty: `Received from ${shortNpub(m.senderPubkeyHex)}`,
        note: m.plaintext,
        timestamp: m.timestamp,
        utxoId: m.payment.utxoId,
      })
    }
  }

  rows.sort((a, b) => b.timestamp - a.timestamp)
  return rows
}
