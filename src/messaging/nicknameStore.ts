// Local nickname storage, sibling to messageStore.ts. Nicknames are MY view of a contact,
// so they're keyed under MY pubkey (not the peer's) — the same nickname store never leaks
// between identities. Same conventions as messageStore: per-identity localStorage key, thin
// pure helpers that also write, quota errors swallowed. No bigint, so no toRaw/fromRaw layer.

// Max nickname length, enforced at the input level too. Keeps a long name from breaking the
// sidebar layout.
export const MAX_NICKNAME_LEN = 30

// A flat map of peer pubkey hex → nickname, for the current identity.
export type NicknameMap = Record<string, string>

// ── Storage ───────────────────────────────────────────────────────────────────

// Keyed on MY Nostr pubkey hex, mirroring messageStore's per-identity key.
function key(myPubkeyHex: string) { return `caravel.nicknames.v1.${myPubkeyHex}` }

export function loadNicknames(myPubkeyHex: string): NicknameMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    return JSON.parse(raw) as NicknameMap
  } catch { return {} }
}

function save(myPubkeyHex: string, map: NicknameMap): void {
  try { localStorage.setItem(key(myPubkeyHex), JSON.stringify(map)) } catch { /* quota / private mode */ }
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
