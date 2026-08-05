// Persisted store of transactions WE sent from the wallet modal. Outflows initiated here are the one
// thing the app authoritatively knows without scanning. Received payments are NOT stored here — they
// are derived from message-linked payment refs (see activity.ts); the blind UTXO scan cannot tell a
// real incoming payment from our own change output, so it must not feed Activity.

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

export function loadHistory(walletAddress: string): SentEntry[] {
  try {
    const raw = localStorage.getItem(key(walletAddress))
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<{ type?: string }>
    // MIGRATION: legacy stores mixed in `received` rows derived from the blind UTXO scan — our own
    // change outputs, faucet/ONS self-deposits, dust — all read as "Received · No note" noise. Keep
    // only real sends; re-persist the cleaned list once so the noise never comes back.
    const sentRaw = parsed.filter((e): e is SentRaw => e?.type === 'sent')
    const entries = sentRaw.map(fromRaw)
    if (sentRaw.length !== parsed.length) save(walletAddress, entries)
    return entries
  } catch { return [] }
}

function save(walletAddress: string, entries: SentEntry[]): void {
  try { localStorage.setItem(key(walletAddress), JSON.stringify(entries.map(toRaw))) } catch { /* quota / private mode */ }
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
