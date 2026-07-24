// Remembered recipient Tari addresses, sibling to nicknameStore.ts.
//
// TEMPORARY BRIDGE (M10.1): a conversation is keyed on a Nostr pubkey, but a confidential payment
// needs an otl_esm_ Tari address — two different keys with no link yet. Until M9's contact flow
// exchanges addresses cryptographically, the sender pastes the recipient's Tari address manually
// and we remember it per-conversation so it isn't re-entered every payment.
//
// IMPORTANT: a manually-entered address is NOT bound to the Nostr identity — anyone could hand you
// any address. The composer must show that caveat in the UI (not just here). Persisting it makes it
// feel authoritative; it isn't. M9 will replace this with verified address exchange.
//
// Same conventions as nicknameStore: per-identity localStorage key (keyed under MY pubkey), thin
// pure helpers that also write, quota errors swallowed. No bigint, so no raw layer.

// peer Nostr pubkey hex → recipient otl_esm_ Tari address, for the current identity.
export type TariAddressMap = Record<string, string>

function key(myPubkeyHex: string) { return `caravel.tariaddr.v1.${myPubkeyHex}` }

export function loadTariAddresses(myPubkeyHex: string): TariAddressMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    return JSON.parse(raw) as TariAddressMap
  } catch { return {} }
}

function save(myPubkeyHex: string, map: TariAddressMap): void {
  try { localStorage.setItem(key(myPubkeyHex), JSON.stringify(map)) } catch { /* quota / private mode */ }
}

// Remember (or clear, when addr is blank) the Tari address for one peer. Returns the next map.
export function setTariAddress(myPubkeyHex: string, current: TariAddressMap, peerHex: string, addr: string): TariAddressMap {
  const trimmed = addr.trim()
  const next: TariAddressMap = { ...current }
  if (trimmed) next[peerHex] = trimmed
  else delete next[peerHex]
  save(myPubkeyHex, next)
  return next
}
