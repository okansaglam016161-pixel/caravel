// Seen RE-INVITE def event ids (Phase C). Sibling to tombstoneStore.ts / deletedGroupStore.ts.
//
// A re-invite def (caravel-group-reinvite) is the ONE control message allowed to lift a locally
// 'left' group. That makes it replay-sensitive in a way an ordinary def is not: the relay serves
// the same gift wrap for ~2 days, so without dedup a single re-invite would re-open the invite card
// on EVERY reload for two days — and again after each decline. Recording the gift-wrap event id the
// first time we act on it makes the lift exactly-once.
//
// NOT a revival of the defEventId plumbing reverted in d3baa8b. That was event-id suppression of
// DELETED groups, deliberately replaced by group-id suppression (deletedGroupStore), which stays
// exactly as it is and remains the mechanism for delete. This is a different thing for a different
// purpose: dedup of re-invite defs, scoped to marked defs only. The two never interact.
//
// Only MARKED re-invite defs are recorded — an ordinary def can never lift 'left', so it needs no
// dedup and costs no storage.
//
// Conventions match the sibling stores: per-identity key (under MY pubkey), quota swallowed,
// age-pruned. The prune horizon is the same 2-day serving window + 1-day margin argument: an entry
// can never be dropped while its event is still backfillable.

// defEventId → seenAtMs.
export type SeenDefMap = Record<string, number>

const PRUNE_AGE_MS = 3 * 24 * 60 * 60 * 1000

function key(myPubkeyHex: string) { return `caravel.seendefs.v1.${myPubkeyHex}` }

function save(myPubkeyHex: string, map: SeenDefMap): void {
  try { localStorage.setItem(key(myPubkeyHex), JSON.stringify(map)) } catch { /* quota / private mode */ }
}

// Load the map, pruning entries past the serving window (and persisting the prune).
export function loadSeenDefs(myPubkeyHex: string): SeenDefMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    const map = JSON.parse(raw) as SeenDefMap
    const cutoff = Date.now() - PRUNE_AGE_MS
    let pruned = false
    for (const id in map) { if (map[id] < cutoff) { delete map[id]; pruned = true } }
    if (pruned) save(myPubkeyHex, map)
    return map
  } catch { return {} }
}

// Fast lookup set for the re-invite handler (pruned on load). Rehydrated on unlock BEFORE the
// subscription replays, like tombstonesRef/deletedGroupsRef.
export function loadSeenDefIdSet(myPubkeyHex: string): Set<string> {
  return new Set(Object.keys(loadSeenDefs(myPubkeyHex)))
}

// Record a re-invite def event id as acted-upon (read-modify-write). Idempotent.
export function recordSeenDef(myPubkeyHex: string, defEventId: string): void {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    const map = raw ? JSON.parse(raw) as SeenDefMap : {}
    map[defEventId] = Date.now()
    save(myPubkeyHex, map)
  } catch { /* quota / private mode */ }
}
