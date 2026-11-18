// The OUTBOX — chat payments between "asked Sapient" and "the chat message is sent", per identity,
// sealed under the chat storage key.
//
// A payment's commitment exists only in Sapient's answer, and the recipient can never confirm the
// payment without it. Closing the tab after the money moved but before the message went out would
// lose it. So an entry is written BEFORE the request is created, gets its requestId as soon as Sapient
// returns one, gets the result once the transaction finalizes, and is removed only when the message
// carrying the payment has been sent. On the next chat unlock, ChatApp resumes what is left:
//
//   result recorded      → paid, message not sent: send the message (no money moves)
//   requestId only       → ask Sapient: submitted → send the message; approved → ask the person
//                          ("Send now / Cancel") — NEVER submitted automatically after a reload;
//                          pending → wait; rejected / failed / expired / unknown → dropped
//   neither              → the request was never created: dropped

import { asRecord, loadStore, writeStore, type Parse } from '../crypto/storeIo'

export interface OutboxEntry {
  id: string
  peerHex: string
  recipient: string
  /** Raw units (µTARI), decimal string. */
  amount: string
  nonce: string
  network: string
  note: string
  createdAt: number
  requestId: string | null
  result: { transactionId: string; recipientSubstateId: string } | null
}

type OutboxMap = Record<string, OutboxEntry>

function key(myPubkeyHex: string) { return `caravel.payoutbox.v1.${myPubkeyHex}` }

function valid(v: unknown): v is OutboxEntry {
  const e = v as Partial<OutboxEntry> | null
  return !!e && typeof e.id === 'string' && typeof e.peerHex === 'string' && typeof e.recipient === 'string'
    && typeof e.amount === 'string' && typeof e.nonce === 'string' && typeof e.network === 'string'
    && typeof e.note === 'string' && typeof e.createdAt === 'number'
    && (e.requestId === null || typeof e.requestId === 'string')
    && (e.result === null || (typeof e.result === 'object' && typeof e.result.transactionId === 'string' && typeof e.result.recipientSubstateId === 'string'))
}

const parse: Parse<OutboxMap> = decoded => {
  const record = asRecord(decoded)
  if (record === null) return null
  const out: OutboxMap = {}
  for (const id in record) if (valid(record[id])) out[id] = record[id] as OutboxEntry
  return out
}

const load = (me: string): OutboxMap => loadStore<OutboxMap>(key(me), parse, () => ({}))
const save = (me: string, map: OutboxMap) => writeStore(key(me), JSON.stringify(map), parse)

export function loadOutbox(myPubkeyHex: string): OutboxEntry[] {
  return Object.values(load(myPubkeyHex)).sort((a, b) => a.createdAt - b.createdAt)
}

/** Write a new entry. Returns false if it could not be persisted (the caller should not pay). */
export function addOutbox(myPubkeyHex: string, entry: OutboxEntry): boolean {
  const map = load(myPubkeyHex)
  map[entry.id] = entry
  return save(myPubkeyHex, map)
}

export function updateOutbox(myPubkeyHex: string, id: string, patch: Partial<Pick<OutboxEntry, 'requestId' | 'result'>>): void {
  const map = load(myPubkeyHex)
  if (!map[id]) return
  map[id] = { ...map[id], ...patch }
  save(myPubkeyHex, map)
}

export function removeOutbox(myPubkeyHex: string, id: string): void {
  const map = load(myPubkeyHex)
  if (!(id in map)) return
  delete map[id]
  save(myPubkeyHex, map)
}

/** Transaction ids of every payment of ours still in the outbox — never credited back to us. */
export function outboxTxIds(myPubkeyHex: string): string[] {
  return loadOutbox(myPubkeyHex).map(e => e.result?.transactionId).filter((x): x is string => !!x)
}
