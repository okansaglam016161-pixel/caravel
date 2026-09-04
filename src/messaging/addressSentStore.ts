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
//
// ── ENCRYPTED AT REST (stage 6) ──────────────────────────────────────────────
//
// MIS-FILED AS INERT METADATA UNTIL NOW, and that is the only reason it was not in stage 4. It sat
// with tombstoneStore, seenDefStore and deletedGroupStore as "an id → timestamp map", which is true
// of its SHAPE and false of its CONTENTS. Those three key on gift-wrap event ids (public on the
// relays by construction) and on random `grp-` UUIDs. This one keys on PEER PUBKEYS — the same key
// space as contactStore, nicknameStore and tariAddressStore, all three of which stage 4 sealed for
// the reason contactStore states in two words: who you talk to.
//
// And it is the LIVE slice of that graph, not stale residue: ChatApp clears an entry on decline and
// on delete, so what is here is the set of contacts currently exchanged with.
//
// It MIGRATES ON READ (storeIo), like its four stage-4 siblings, and needs no forced startup read
// the way paymentResolutionStore did: ChatApp already loads it on mount beside the nicknames.

import { asRecord, loadStore, writeStore, type Parse } from '../crypto/storeIo'

// peer Nostr pubkey hex → ms epoch when my address was delivered.
export type AddressSentMap = Record<string, number>

function key(myPubkeyHex: string) { return `caravel.addrsent.v1.${myPubkeyHex}` }

const parse: Parse<AddressSentMap> = decoded => asRecord(decoded) as AddressSentMap | null

function save(myPubkeyHex: string, map: AddressSentMap): void {
  writeStore(key(myPubkeyHex), JSON.stringify(map), parse)
}

export function loadAddressSent(myPubkeyHex: string): AddressSentMap {
  return loadStore(key(myPubkeyHex), parse, () => ({}))
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
