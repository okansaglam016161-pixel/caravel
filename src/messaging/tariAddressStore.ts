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
// quota swallowed.
//
// ── ENCRYPTED AT REST (stage 4) ──────────────────────────────────────────────
//
// THE HIGHEST-VALUE LINKAGE IN THE APP, and the reason tier 2 started here: this map is the join
// between a Nostr identity and an on-chain one. Beside the journal — which is now sealed — it was
// the other half of a deanonymisation package.
//
// It MIGRATES ON READ (storeIo), because it writes only when an address is pasted or exchanged: a
// wallet whose contacts already have addresses would otherwise keep this in plaintext forever.
//
// AND THAT MAKES THE LEGACY-STRING MIGRATION PERMANENT. Entries were once bare strings (all
// manual); the conversion below has been re-derived on every load ever since, because nothing
// re-persisted it. The migration write now stores the PARSED map, so it is done once and stays
// done.

import { asRecord, loadStore, writeStore, type Parse } from '../crypto/storeIo'

export type AddressSource = 'manual' | 'exchanged'

export interface TariAddressRecord {
  address: string
  source: AddressSource
}

// peer Nostr pubkey hex → record, for the current identity.
export type TariAddressMap = Record<string, TariAddressRecord>

function key(myPubkeyHex: string) { return `caravel.tariaddr.v1.${myPubkeyHex}` }

const parse: Parse<TariAddressMap> = decoded => {
  const record = asRecord(decoded)
  if (record === null) return null
  const out: TariAddressMap = {}
  for (const peer in record) {
    const v = record[peer] as string | TariAddressRecord
    // Legacy bare-string values were all manually-entered addresses.
    out[peer] = typeof v === 'string' ? { address: v, source: 'manual' } : v
  }
  return out
}

function save(myPubkeyHex: string, map: TariAddressMap): void {
  writeStore(key(myPubkeyHex), JSON.stringify(map), parse)
}

export function loadTariAddresses(myPubkeyHex: string): TariAddressMap {
  return loadStore(key(myPubkeyHex), parse, () => ({}))
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
