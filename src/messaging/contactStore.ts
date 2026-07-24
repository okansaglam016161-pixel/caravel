// Per-peer contact state (M9.0b), sibling to the other stores.
//
// Every npub you have messages with has an effective contact state:
//   - accepted — a normal conversation (behaves as before)
//   - pending  — they messaged you first and you have not decided yet; held out of the list
//   - declined — NOT a stored state. Declining = M9.0a delete + tombstone + removeContact, so a
//                later message from them creates a FRESH pending request. Hence the union is only
//                'pending' | 'accepted'; "declined" is the absence of a record + no messages.
//
// LAZY MIGRATION: a peer with messages but no record is treated as 'accepted' by the derivation
// (see ChatApp) — no one-time backfill. The incoming handler only writes a 'pending' record for a
// peer with NO prior messages, so existing conversations are never mis-flagged.
//
// Conventions match the other stores: per-identity key (keyed under MY pubkey), quota swallowed.

export type ContactState = 'pending' | 'accepted'

export interface ContactRecord {
  state: ContactState
  updatedAt: number
}

// peer pubkey hex → record, for the current identity.
export type ContactMap = Record<string, ContactRecord>

function key(myPubkeyHex: string) { return `caravel.contacts.v1.${myPubkeyHex}` }

function save(myPubkeyHex: string, map: ContactMap): void {
  try { localStorage.setItem(key(myPubkeyHex), JSON.stringify(map)) } catch { /* quota / private mode */ }
}

export function loadContacts(myPubkeyHex: string): ContactMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    return JSON.parse(raw) as ContactMap
  } catch { return {} }
}

// Set a peer's contact state (read-modify-write). Returns the next map (React-state friendly).
export function setContactState(myPubkeyHex: string, current: ContactMap, peerHex: string, state: ContactState): ContactMap {
  const next: ContactMap = { ...current, [peerHex]: { state, updatedAt: Date.now() } }
  save(myPubkeyHex, next)
  return next
}

// Remove a peer's record (used by decline/delete). Returns the next map.
export function removeContact(myPubkeyHex: string, current: ContactMap, peerHex: string): ContactMap {
  if (!(peerHex in current)) return current
  const next = { ...current }
  delete next[peerHex]
  save(myPubkeyHex, next)
  return next
}
