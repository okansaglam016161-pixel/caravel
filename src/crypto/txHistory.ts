import type { ScannedUtxo } from './walletScanner'

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

export interface ReceivedEntry {
  type: 'received'
  id: string            // UTXO substateId — dedup key
  amountMicrotari: bigint
  note: string          // memo / payRef decoded by scanner
  discoveredAt: number  // Date.now() when first seen in a scan
}

export type TxEntry = SentEntry | ReceivedEntry

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
interface ReceivedRaw { type: 'received'; id: string; amountMicrotari: string; note: string; discoveredAt: number }
type TxEntryRaw = SentRaw | ReceivedRaw

function toRaw(e: TxEntry): TxEntryRaw {
  if (e.type === 'sent') return { ...e, amountMicrotari: e.amountMicrotari.toString() }
  return { ...e, amountMicrotari: e.amountMicrotari.toString() }
}

function fromRaw(r: TxEntryRaw): TxEntry {
  if (r.type === 'sent') return { ...r, amountMicrotari: BigInt(r.amountMicrotari), outcome: r.outcome as SentEntry['outcome'] }
  return { ...r, amountMicrotari: BigInt(r.amountMicrotari) }
}

// ── Storage ───────────────────────────────────────────────────────────────────

function key(addr: string) { return `caravel.txhistory.v1.${addr}` }

export function loadHistory(walletAddress: string): TxEntry[] {
  try {
    const raw = localStorage.getItem(key(walletAddress))
    if (!raw) return []
    return (JSON.parse(raw) as TxEntryRaw[]).map(fromRaw)
  } catch { return [] }
}

function save(walletAddress: string, entries: TxEntry[]): void {
  try { localStorage.setItem(key(walletAddress), JSON.stringify(entries.map(toRaw))) } catch { /* quota / private mode */ }
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

export function addSent(walletAddress: string, current: TxEntry[], params: NewSentParams): TxEntry[] {
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

export function mergeReceived(walletAddress: string, current: TxEntry[], utxos: ScannedUtxo[]): TxEntry[] {
  const known = new Set(current.map(e => e.id))
  const now = Date.now()
  const incoming: ReceivedEntry[] = []

  for (const utxo of utxos) {
    if (known.has(utxo.id)) continue
    const note = [utxo.payRef, utxo.message].filter(Boolean).join(' · ')
    incoming.push({ type: 'received', id: utxo.id, amountMicrotari: utxo.amount, note, discoveredAt: now })
  }

  if (incoming.length === 0) return current
  const next = [...incoming, ...current]
  save(walletAddress, next)
  return next
}
