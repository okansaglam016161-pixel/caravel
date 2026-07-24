// Tombstones for deleted messages (M9.0a), sibling to messageStore.ts.
//
// Messages live on the relays for ~2 days, and the subscription backfills with since = now - 2d on
// every unlock. Without tombstones, deleting a conversation and unlocking would re-fetch its
// messages and the conversation would reappear. So on delete we record the gift-wrap event ids and
// the incoming-message handler drops any tombstoned id before it reaches messageStore.
//
// Per-MESSAGE-ID, never per-peer: a genuinely new message from a deleted contact has a new event
// id, so it is NOT tombstoned and creates a fresh conversation. Deletion mutes history, not people.
//
// Conventions match the other stores: per-identity key (keyed under MY pubkey), quota swallowed.

// eventId → addedAtMs.
export type TombstoneMap = Record<string, number>

// Prune horizon: once an event is older than the relay's ~2-day serving window it can no longer be
// backfilled, so its tombstone is dead weight. 3 days = 2-day window + 1-day safety margin. An
// event stops being servable at ~send_time + 2d ≤ delete_time + 2d, so pruning at added + 3d can
// never drop a tombstone while its event is still servable. Keeps the set naturally bounded.
const PRUNE_AGE_MS = 3 * 24 * 60 * 60 * 1000

function key(myPubkeyHex: string) { return `caravel.tombstones.v1.${myPubkeyHex}` }

function save(myPubkeyHex: string, map: TombstoneMap): void {
  try { localStorage.setItem(key(myPubkeyHex), JSON.stringify(map)) } catch { /* quota / private mode */ }
}

// Load the tombstone map, pruning entries past the serving window (and persisting the prune).
export function loadTombstones(myPubkeyHex: string): TombstoneMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    const map = JSON.parse(raw) as TombstoneMap
    const cutoff = Date.now() - PRUNE_AGE_MS
    let pruned = false
    for (const id in map) { if (map[id] < cutoff) { delete map[id]; pruned = true } }
    if (pruned) save(myPubkeyHex, map)
    return map
  } catch { return {} }
}

// Fast lookup set for the incoming-message handler (pruned on load).
export function loadTombstoneIdSet(myPubkeyHex: string): Set<string> {
  return new Set(Object.keys(loadTombstones(myPubkeyHex)))
}

// Record event ids as deleted (read-modify-write). Idempotent — re-tombstoning is a no-op refresh.
export function recordTombstones(myPubkeyHex: string, ids: string[]): void {
  if (ids.length === 0) return
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    const map = raw ? JSON.parse(raw) as TombstoneMap : {}
    const now = Date.now()
    for (const id of ids) map[id] = now
    save(myPubkeyHex, map)
  } catch { /* quota / private mode */ }
}
