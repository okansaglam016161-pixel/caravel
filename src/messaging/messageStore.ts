import type { CaravelMessage } from './types'

// Local persistence for messages, sibling to crypto/txHistory.ts. Same shape of problem:
// localStorage keyed per identity, load on unlock, merge on arrival, clear React state on lock
// while the stored copy persists. Two deliberate divergences from txHistory:
//   1. No bigint fields — CaravelMessage is fully JSON-safe, so there is no toRaw/fromRaw layer.
//   2. Function names are *Message-suffixed to avoid colliding with txHistory's addSent /
//      mergeReceived, which WalletContext imports alongside these.

// Window within which a self-authored 'received' copy is treated as an echo of a local 'sent'
// message (see addReceivedMessage). Generous enough to cover relay round-trip + clock skew.
const SELF_ECHO_WINDOW_MS = 60_000

// ── Storage ───────────────────────────────────────────────────────────────────

// Keyed on Nostr pubkey hex, mirroring how txHistory keys on wallet address.
function key(pubkeyHex: string) { return `caravel.messages.v1.${pubkeyHex}` }

export function loadMessages(pubkeyHex: string): CaravelMessage[] {
  try {
    const raw = localStorage.getItem(key(pubkeyHex))
    if (!raw) return []
    return JSON.parse(raw) as CaravelMessage[]
  } catch { return [] }
}

function save(pubkeyHex: string, messages: CaravelMessage[]): void {
  try { localStorage.setItem(key(pubkeyHex), JSON.stringify(messages)) } catch { /* quota / private mode */ }
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

// Record a message we just sent (route a: the CaravelMessage returned by sendMessage).
// Deduped by event id so a double-fire can't create two rows. Newest-first, like txHistory.
export function addSentMessage(pubkeyHex: string, current: CaravelMessage[], msg: CaravelMessage): CaravelMessage[] {
  if (current.some(m => m.id === msg.id)) return current
  const next = [msg, ...current]
  save(pubkeyHex, next)
  return next
}

// Merge an incoming message from the subscription (provider marks these 'received').
export function addReceivedMessage(pubkeyHex: string, current: CaravelMessage[], incoming: CaravelMessage): CaravelMessage[] {
  // Dedup by gift-wrap event id — the same event arrives from multiple relays and is
  // re-fetched on each unlock. First-seen wins, so the stored timestamp stays stable
  // (this is what gives real per-message timing instead of all-the-unlock-moment).
  if (current.some(m => m.id === incoming.id)) return current

  // Self-authored copy: NIP-17 can gift-wrap a copy back to the sender. It unwraps with
  // senderPubkeyHex === our own pubkey, and carries no recipient (unwrap doesn't expose the
  // rumor's p-tag), so a locally-recorded 'sent' row is strictly richer.
  if (incoming.senderPubkeyHex === pubkeyHex) {
    const echoOfLocalSend = current.some(m =>
      m.direction === 'sent' &&
      m.plaintext === incoming.plaintext &&
      Math.abs(m.timestamp - incoming.timestamp) < SELF_ECHO_WINDOW_MS
    )
    // Have the local 'sent' already → drop the redundant echo. Otherwise it was sent from
    // another device: keep it, flipped to 'sent' so it renders on the correct side. Recipient
    // is unrecoverable here, left blank until a later milestone can resolve it.
    if (echoOfLocalSend) return current
    const fromOtherDevice: CaravelMessage = { ...incoming, direction: 'sent', recipientPubkeyHex: '' }
    const next = [fromOtherDevice, ...current]
    save(pubkeyHex, next)
    return next
  }

  const next = [incoming, ...current]
  save(pubkeyHex, next)
  return next
}

// Delete every message belonging to one peer conversation (M9.0a). Membership matches
// ChatApp's deriveConversations: the "other party" is senderPubkeyHex for received, recipientPubkeyHex
// for sent. Returns the remaining messages (also persisted). Caller must tombstone the deleted ids
// FIRST so a relay backfill can't repopulate them in the gap.
export function deletePeerMessages(pubkeyHex: string, current: CaravelMessage[], peerHex: string): CaravelMessage[] {
  const next = current.filter(m => {
    const other = m.direction === 'received' ? m.senderPubkeyHex : m.recipientPubkeyHex
    return other !== peerHex
  })
  if (next.length === current.length) return current
  save(pubkeyHex, next)
  return next
}
