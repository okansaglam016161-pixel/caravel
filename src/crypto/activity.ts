// Derives the wallet Activity list from the THREE authoritative sources of payment knowledge:
//
//   1. the activity JOURNAL — every action the user took here, recorded as it happened: sends,
//      make-private, make-public, faucet claims. Richest of the three; it alone carries the fee,
//      the structured direction and the full counterparty address.
//   2. wallet-modal sends (SentEntry) — the journal's predecessor. Sends only, no fee. Still read
//      because it holds every send made before the journal existed.
//   3. message-linked payments (CaravelMessage.payment) — chat sends (outflows) and received
//      payments (inflows), each announced over Nostr and so attributable to a real counterparty.
//
// The blind UTXO scan is deliberately NOT a source: a confidential UTXO carries no sender, so the
// scan cannot tell an incoming payment from our own change output. Reconciling that against the
// journal's recorded self-outputs is a later phase; until then, every INFLOW here still comes from
// a message-linked ref and nowhere else.

import { sortKey, type CaravelMessage } from '../messaging/types'
import type { SentEntry } from './txHistory'
import type { JournalEntry, JournalOutcome } from './journal'
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

/**
 * How an event ended, in ONE vocabulary.
 *
 * The three sources each had their own — the journal's five states, txHistory's three, and chat's
 * "not tracked at all" — and a display layer translating three of them would be three places for a
 * timeout to become a failure. They are normalised here, once. `'unknown'` is the chat send: the
 * message went out, and nothing in this app ever learned what the chain did with the payment.
 */
export type ActivityOutcome = JournalOutcome | 'unknown'

/** Where a row's knowledge came from. Different sources deserve different trust — see the sort. */
export type ActivitySource = 'local-journal' | 'chat-ref'

export type ActivityRow =
  | {
      kind: 'sent'
      id: string
      counterparty: string
      /** The FULL address or npub, unabbreviated, when the source knew it. For hover/copy. */
      counterpartyValue: string | null
      note: string
      timestamp: number
      amountMicrotari: bigint | null            // null = sent from another device (amount not cached here)
      feeMicrotari: bigint | null               // journal-only; txHistory never recorded one
      outcome: ActivityOutcome
      source: ActivitySource
      txId: string | null
    }
  | {
      kind: 'received'
      id: string
      counterparty: string
      counterpartyValue: string | null
      note: string
      timestamp: number
      utxoId: string                            // resolved to an amount lazily by the Activity row
      source: ActivitySource
    }
  /**
   * A move between the user's OWN two balances.
   *
   * NOT AN INFLOW AND NOT AN OUTFLOW, which is the whole reason it is its own kind. Making 50 XTR
   * public does not reduce holdings by 50 — it moves them, and the only value that actually leaves
   * is the fee. A renderer that put a sign on this figure would be stating a confident wrong
   * number, so `to` describes a direction of travel between balances and nothing here implies a
   * change in total.
   */
  | {
      kind: 'swap'
      id: string
      /** Which balance the value landed in. The opposite one is where it came from. */
      to: 'private' | 'public'
      timestamp: number
      amountMicrotari: bigint | null
      feeMicrotari: bigint | null
      outcome: ActivityOutcome
      source: ActivitySource
      txId: string | null
    }
  | {
      kind: 'faucet'
      id: string
      timestamp: number
      amountMicrotari: bigint | null
      feeMicrotari: bigint | null
      outcome: ActivityOutcome
      source: ActivitySource
      txId: string | null
    }

/** txHistory's outcome vocabulary, normalised onto the journal's. One table, one direction. */
const LEGACY_OUTCOME: Record<'Commit' | 'Reject' | 'Timeout', JournalOutcome> = {
  Commit: 'committed',
  Reject: 'rejected',
  Timeout: 'timeout',
}

/** One journalled action, projected into a row. Returns null for kinds the list does not show. */
function fromJournal(e: JournalEntry): ActivityRow | null {
  const common = {
    id: e.id,
    timestamp: e.timestamp,
    amountMicrotari: e.amountMicrotari,
    feeMicrotari: e.feeMicrotari,
    outcome: e.outcome as ActivityOutcome,
    source: 'local-journal' as const,
    txId: e.txId,
  }

  switch (e.kind) {
    case 'send':
      return {
        kind: 'sent',
        ...common,
        counterparty: `Sent to ${e.counterparty ? shortAddr(e.counterparty.value) : 'an address'}`,
        counterpartyValue: e.counterparty?.value ?? null,
        note: e.note ?? '',
      }
    // `to` comes from the STRUCTURED field, never from a label. This is the same discipline the
    // move flow's copy follows: the direction a screen reports is the direction the record holds,
    // so the two cannot be swapped by an edit to either one.
    case 'make-private':
      return { kind: 'swap', ...common, to: 'private' }
    case 'make-public':
      return { kind: 'swap', ...common, to: 'public' }
    case 'faucet':
      return { kind: 'faucet', ...common }
    // Written by nothing yet — the reconciliation phase's output. Ignored rather than guessed at.
    case 'receive':
      return null
    // RECORDED, NOT DISPLAYED. A chat payment is journalled so its change output can be subtracted
    // during reconciliation and never mistaken for a receive. Wallet Activity shows wallet actions;
    // chat payments belong to chat. Recording is not displaying.
    case 'chat-payment':
      return null
  }
}

/**
 * Merge all three sources into one newest-first list.
 *
 * ── DEDUPE ──────────────────────────────────────────────────────────────────
 *
 * A wallet-modal send is recorded TWICE: once in the journal and once in txHistory, both keyed on
 * the same transaction id. Only one row may survive, and it is always the journal's — it carries
 * the fee, the full address and the structured direction, where txHistory carries a pre-rendered
 * sentence and no fee.
 *
 * The key is the TRANSACTION id, not the row id. Two things follow, and both are deliberate:
 *
 *   - A journal entry with NO txId cannot collide with anything. That is correct: it is an attempt
 *     that never reached the network, and it is a row txHistory never had.
 *   - A retried send produces two entries and two rows. Also correct — it was two attempts, and
 *     collapsing them would hide that the first one happened.
 *
 * Dedupe spans all three sources rather than just the two that can collide today, so journalling
 * the chat path later cannot start double-rendering.
 */
export function buildActivity(
  journal: JournalEntry[],
  sent: SentEntry[],
  messages: CaravelMessage[],
): ActivityRow[] {
  const rows: ActivityRow[] = []
  const claimedTxIds = new Set<string>()

  // FIRST, so it wins every collision below.
  for (const e of journal) {
    const row = fromJournal(e)
    // ORDER MATTERS: a kind that renders nothing claims nothing either. A `chat-payment` entry is
    // recorded only so its change output can be subtracted later, and it names the same txId the
    // chat message does — so claiming it here would silently delete the chat row that legitimately
    // renders that payment. A non-displayed entry must never suppress a displayed one.
    if (!row) continue
    if (e.txId !== null) claimedTxIds.add(e.txId)
    rows.push(row)
  }

  // The journal's predecessor. `SentEntry.id` IS the txHash, so a send the journal already holds
  // is skipped here rather than rendered a second time.
  for (const e of sent) {
    if (claimedTxIds.has(e.txHash)) continue
    claimedTxIds.add(e.txHash)
    rows.push({
      kind: 'sent',
      id: e.id,
      counterparty: `Sent to ${shortAddr(e.recipient)}`,
      counterpartyValue: e.recipient,
      note: e.note,
      timestamp: e.timestamp,
      amountMicrotari: e.amountMicrotari,
      feeMicrotari: null,               // txHistory never recorded one, and it is unrecoverable now
      outcome: LEGACY_OUTCOME[e.outcome],
      source: 'local-journal',
      txId: e.txHash,
    })
  }

  // Message-linked payments: chat sends (outflows) and received payments (inflows).
  for (const m of messages) {
    if (!m.payment?.utxoId) continue
    if (m.direction === 'sent') {
      const txId = m.localPayment?.txId ?? null
      if (txId !== null && claimedTxIds.has(txId)) continue
      if (txId !== null) claimedTxIds.add(txId)
      rows.push({
        kind: 'sent',
        id: m.id,
        counterparty: m.recipientPubkeyHex ? `Sent to ${shortNpub(m.recipientPubkeyHex)}` : 'Sent from another device',
        counterpartyValue: m.recipientPubkeyHex ?? null,
        note: m.plaintext,
        timestamp: sortKey(m),
        // localPayment is a this-device cache (never on the wire); absent for other-device sends.
        amountMicrotari: m.localPayment ? BigInt(m.localPayment.amountMicrotari) : null,
        feeMicrotari: null,
        // The chat path does not track what the chain did with the payment — the message being
        // delivered says nothing about the transaction. Stated as unknown rather than assumed good.
        outcome: 'unknown',
        source: 'chat-ref',
        txId,
      })
    } else {
      rows.push({
        kind: 'received',
        id: m.id,
        counterparty: `Received from ${shortNpub(m.senderPubkeyHex)}`,
        counterpartyValue: m.senderPubkeyHex,
        note: m.plaintext,
        timestamp: sortKey(m),
        utxoId: m.payment.utxoId,
        source: 'chat-ref',
      })
    }
  }

  // Newest first. Rows reach this sort on TWO clocks, and the difference is worth knowing: a
  // journalled row and a wallet send carry OUR clock, taken when the action was initiated, and
  // nobody else can move them. A message-linked row carries sortKey — the counterparty's CLAMPED
  // SEND TIME. That is a real weakening of a financial record and is called out rather than
  // hidden: a peer who back-dates can place their payment row earlier in the ledger than it
  // belongs, because clampSendTime bounds only future claims. What they cannot do is reorder
  // anything by claiming to be recent, invent a row, or alter an amount — the amount and the UTXO
  // come from the chain and from our own local cache, never from the label. Ordering follows the
  // chat thread deliberately: a payment the user finds by scrolling to a message must sit where
  // that message sits, and two views of the same event disagreeing would be its own bug.
  rows.sort((a, b) => b.timestamp - a.timestamp)
  return rows
}
