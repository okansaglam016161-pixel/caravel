// Persisted store of transactions WE sent from the wallet modal. Outflows initiated here are the one
// thing the app authoritatively knows without scanning. Received payments are NOT stored here — they
// are derived from message-linked payment refs (see activity.ts); the blind UTXO scan cannot tell a
// real incoming payment from our own change output, so it must not feed Activity.
//
// ── ENCRYPTED AT REST (stage 3) ──────────────────────────────────────────────
//
// Sealed under the session store key through storeCrypto, exactly as journalStore is. This file
// holds a recipient address, an amount and a note per row — the same disclosure the journal was
// fixed for, in an older and smaller form. Migration is lazy: a plaintext store reads through the
// v1 passthrough and is re-emitted sealed by the next write. Nothing is ever wiped.

import { getStoreKey } from './sessionKey'
import { open, seal } from './storeCrypto'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SentEntry {
  type: 'sent'
  id: string            // txHash — unique per send
  recipient: string
  amountMicrotari: bigint
  note: string
  txHash: string
  timestamp: number     // Date.now() at send time
  outcome: 'Commit' | 'Reject' | 'Timeout'
}

export interface NewSentParams {
  recipient: string
  amountMicrotari: bigint
  note: string
  txHash: string
  outcome: 'Commit' | 'Reject' | 'Timeout'
}

// ── Serialization ─────────────────────────────────────────────────────────────

// bigint can't round-trip through JSON — store as decimal string
interface SentRaw { type: 'sent'; id: string; recipient: string; amountMicrotari: string; note: string; txHash: string; timestamp: number; outcome: string }

function toRaw(e: SentEntry): SentRaw {
  return { ...e, amountMicrotari: e.amountMicrotari.toString() }
}

function fromRaw(r: SentRaw): SentEntry {
  return { ...r, amountMicrotari: BigInt(r.amountMicrotari), outcome: r.outcome as SentEntry['outcome'] }
}

// ── Storage ───────────────────────────────────────────────────────────────────

function key(addr: string) { return `caravel.txhistory.v1.${addr}` }

/** Readable rows, nothing stored, or present-but-unopenable. See journalStore for the full note. */
type ReadResult =
  | { status: 'ok'; rows: Array<{ type?: string }> }
  | { status: 'empty' }
  | { status: 'unreadable' }

function read(walletAddress: string): ReadResult {
  let raw: string | null
  try {
    raw = localStorage.getItem(key(walletAddress))
  } catch {
    return { status: 'unreadable' }
  }

  const opened = open(getStoreKey(), raw)
  if (opened.status !== 'ok') return opened

  try {
    const parsed = JSON.parse(opened.json) as Array<{ type?: string }>
    if (!Array.isArray(parsed)) return { status: 'unreadable' }
    return { status: 'ok', rows: parsed }
  } catch {
    return { status: 'unreadable' }
  }
}

export function loadHistory(walletAddress: string): SentEntry[] {
  // THE UNREADABLE CHECK COMES FIRST, and the ordering is load-bearing: the row-filtering migration
  // below writes during this read, and a record we could not open must never trigger a self-heal
  // that writes over itself.
  const result = read(walletAddress)
  if (result.status !== 'ok') return []

  // MIGRATION: legacy stores mixed in `received` rows derived from the blind UTXO scan — our own
  // change outputs, faucet/ONS self-deposits, dust — all read as "Received · No note" noise. Keep
  // only real sends; re-persist the cleaned list once so the noise never comes back.
  //
  // This is also the fast path onto the sealed format for any store that still carries those rows:
  // it re-persists here rather than waiting for the next send.
  const sentRaw = result.rows.filter((e): e is SentRaw => e?.type === 'sent')
  const entries = sentRaw.map(fromRaw)
  if (sentRaw.length !== result.rows.length) save(walletAddress, entries)
  return entries
}

/**
 * NO SUCCESS SIGNAL, unlike journalStore's — and there is none to preserve, because addSent runs
 * inside `setTxHistory(prev => addSent(...))` and a React updater has nowhere to route a failure.
 * A refused write behaves exactly as a quota failure always has here: React state holds a row that
 * disk does not, and a reload loses it.
 *
 * Two refusals before the write, both for the reasons journalStore's save documents at length: no
 * store key means never falling back to plaintext, and a present-but-unreadable record is never
 * overwritten — under a wrong key `current` comes from React state seeded by an empty read, so
 * without that guard one send would encrypt a single row over an entire history.
 */
function save(walletAddress: string, entries: SentEntry[]): void {
  const storeKey = getStoreKey()
  if (storeKey === null) return
  if (read(walletAddress).status === 'unreadable') return

  try {
    localStorage.setItem(key(walletAddress), seal(storeKey, JSON.stringify(entries.map(toRaw))))
  } catch { /* quota / private mode */ }
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

export function addSent(walletAddress: string, current: SentEntry[], params: NewSentParams): SentEntry[] {
  const entry: SentEntry = {
    type: 'sent',
    id: params.txHash,
    recipient: params.recipient,
    amountMicrotari: params.amountMicrotari,
    note: params.note,
    txHash: params.txHash,
    timestamp: Date.now(),
    outcome: params.outcome,
  }
  const next = [entry, ...current]
  save(walletAddress, next)
  return next
}
