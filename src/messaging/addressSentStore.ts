// Tracks which contacts I have delivered MY Tari address to (M9.0d self-healing exchange).
//
// The dedicated address control message (sent on initiate/accept) can fail independently — a
// network blip or relay rejection can leave the exchange asymmetric. Rather than a retry queue,
// we piggyback my address on my NEXT normal message to a contact until I've delivered it. This
// store records "delivered" (at least one relay accepted the send) so we STOP attaching it once
// they clearly have it. "Delivered" is a relay-accepted proxy; it could be upgraded to a true
// acknowledgement later.
//
// Cleared on decline/delete so a fresh contact re-exchanges. Per-identity key, quota swallowed.

// peer Nostr pubkey hex → ms epoch when my address was delivered.
export type AddressSentMap = Record<string, number>

function key(myPubkeyHex: string) { return `caravel.addrsent.v1.${myPubkeyHex}` }

function save(myPubkeyHex: string, map: AddressSentMap): void {
  try { localStorage.setItem(key(myPubkeyHex), JSON.stringify(map)) } catch { /* quota / private mode */ }
}

export function loadAddressSent(myPubkeyHex: string): AddressSentMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    return JSON.parse(raw) as AddressSentMap
  } catch { return {} }
}

// Mark my address delivered to a peer. Returns the next map.
export function markAddressSent(myPubkeyHex: string, current: AddressSentMap, peerHex: string): AddressSentMap {
  if (current[peerHex]) return current
  const next = { ...current, [peerHex]: Date.now() }
  save(myPubkeyHex, next)
  return next
}

// Forget delivery for a peer (decline/delete), so re-adding them re-exchanges. Returns the next map.
export function clearAddressSent(myPubkeyHex: string, current: AddressSentMap, peerHex: string): AddressSentMap {
  if (!(peerHex in current)) return current
  const next = { ...current }
  delete next[peerHex]
  save(myPubkeyHex, next)
  return next
}
