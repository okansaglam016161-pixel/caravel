// Local nickname storage, sibling to messageStore.ts. Nicknames are MY view of a contact,
// so they're keyed under MY pubkey (not the peer's) — the same nickname store never leaks
// between identities. Same conventions as messageStore: per-identity localStorage key, thin
// pure helpers that also write, quota errors swallowed. No bigint, so no toRaw/fromRaw layer.
//
// ── ENCRYPTED AT REST (stage 4) ──────────────────────────────────────────────
//
// Nicknames are user-chosen labels and are very often real names, which is what puts a map of
// pubkey → "Mum" in the same tier as the contact graph itself.
//
// It MIGRATES ON READ (storeIo), and this is the store that needed it most: it writes ONLY when
// somebody is renamed. On a wallet where the names were set months ago, lazy-on-write would have
// meant never.

import { asRecord, loadStore, writeStore, type Parse } from '../crypto/storeIo'

// Max nickname length, enforced at the input level too. Keeps a long name from breaking the
// sidebar layout.
export const MAX_NICKNAME_LEN = 30

// A flat map of peer pubkey hex → nickname, for the current identity.
export type NicknameMap = Record<string, string>

// ── Storage ───────────────────────────────────────────────────────────────────

// Keyed on MY Nostr pubkey hex, mirroring messageStore's per-identity key.
function key(myPubkeyHex: string) { return `caravel.nicknames.v1.${myPubkeyHex}` }

const parse: Parse<NicknameMap> = decoded => asRecord(decoded) as NicknameMap | null

export function loadNicknames(myPubkeyHex: string): NicknameMap {
  return loadStore(key(myPubkeyHex), parse, () => ({}))
}

function save(myPubkeyHex: string, map: NicknameMap): void {
  writeStore(key(myPubkeyHex), JSON.stringify(map), parse)
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

// Set (or clear, when name is blank) the nickname for one peer. Returns the next map.
// Trims and caps length so a stored value can never exceed the input constraint.
export function setNickname(myPubkeyHex: string, current: NicknameMap, peerHex: string, name: string): NicknameMap {
  const trimmed = name.trim().slice(0, MAX_NICKNAME_LEN)
  const next: NicknameMap = { ...current }
  if (trimmed) next[peerHex] = trimmed
  else delete next[peerHex]
  save(myPubkeyHex, next)
  return next
}
