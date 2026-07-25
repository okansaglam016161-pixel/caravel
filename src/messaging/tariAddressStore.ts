// Recipient Tari addresses per contact, sibling to nicknameStore.ts.
//
// A conversation is keyed on a Nostr pubkey, but a confidential payment needs an otl_esm_ Tari
// address. Two ways an address gets here:
//   - 'manual'    — pasted by hand (M10.1). NOT bound to the Nostr identity; the composer warns.
//   - 'exchanged' — received over the encrypted, authenticated channel (M9.0d), so it IS bound to
//                   the sender's Nostr identity (seal.pubkey === rumor.pubkey). No warning needed.
// The `source` lets M9.0e drop the unverified warning for exchanged addresses. An exchanged
// address takes precedence over a manual one for the same peer (verified beats pasted).
//
// Conventions match the other stores: per-identity localStorage key (keyed under MY pubkey),
// quota swallowed. Legacy entries were bare strings (all manual) and migrate lazily on load.

export type AddressSource = 'manual' | 'exchanged'

export interface TariAddressRecord {
  address: string
  source: AddressSource
}

// peer Nostr pubkey hex → record, for the current identity.
export type TariAddressMap = Record<string, TariAddressRecord>

function key(myPubkeyHex: string) { return `caravel.tariaddr.v1.${myPubkeyHex}` }

function save(myPubkeyHex: string, map: TariAddressMap): void {
  try { localStorage.setItem(key(myPubkeyHex), JSON.stringify(map)) } catch { /* quota / private mode */ }
}

export function loadTariAddresses(myPubkeyHex: string): TariAddressMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string | TariAddressRecord>
    const out: TariAddressMap = {}
    for (const peer in parsed) {
      const v = parsed[peer]
      // Lazy migration: legacy bare-string values were all manually-entered addresses.
      out[peer] = typeof v === 'string' ? { address: v, source: 'manual' } : v
    }
    return out
  } catch { return {} }
}

// Set (or clear, when addr is blank) a peer's address with an explicit source. Returns the next
// map. An 'exchanged' (verified) record is never silently overwritten by a 'manual' one.
export function setTariAddress(
  myPubkeyHex: string,
  current: TariAddressMap,
  peerHex: string,
  addr: string,
  source: AddressSource,
): TariAddressMap {
  const trimmed = addr.trim()
  const next: TariAddressMap = { ...current }
  if (!trimmed) {
    delete next[peerHex]
  } else if (source === 'manual' && current[peerHex]?.source === 'exchanged') {
    return current  // don't let a manual entry clobber a verified one
  } else {
    next[peerHex] = { address: trimmed, source }
  }
  save(myPubkeyHex, next)
  return next
}
