// Deleted-group ids (Phase 1 group delete). Sibling to tombstoneStore.ts.
//
// A group DEFINITION control message creates no stored message, so a per-message-id tombstone can't
// cover it: on the next unlock the relay backfills the def (it lives ~2 days) and it would
// re-materialise a group the user deleted. So on delete we record the GROUP ID here, and
// onGroupDefinition drops a def whose group is absent locally AND whose id is in this set — a stale
// replay resurrecting a deleted group. A genuinely new MESSAGE re-materialises the group (that path
// is ungated), after which a replayed def re-names/re-rosters it: "forget until re-invited" via a
// message. Covers every group, legacy included, since the group id is always known.
//
// Phase A/B also write here as belt-and-suspenders for the permanent 'left' suppression: declining
// an invite (A-M1) and leaving an active group (B-M1) both record the id, covering the edge where
// the local record is absent or a placeholder.
//
// Phase 2 (leave/join, versioned defs): key the suppression on (groupId, defVersion) so a newer def
// defeats the entry and def-based re-invite returns in full.
//
// Conventions match the other stores: per-identity key (under MY pubkey), quota swallowed, age-pruned.

// groupId → deletedAtMs.
export type DeletedGroupMap = Record<string, number>

// Prune horizon: a def stops being backfillable ~2 days after it was sent, so a 3-day horizon
// (2-day window + 1-day margin) can never drop an entry while its def is still servable.
const PRUNE_AGE_MS = 3 * 24 * 60 * 60 * 1000

function key(myPubkeyHex: string) { return `caravel.deletedgroups.v1.${myPubkeyHex}` }

function save(myPubkeyHex: string, map: DeletedGroupMap): void {
  try { localStorage.setItem(key(myPubkeyHex), JSON.stringify(map)) } catch { /* quota / private mode */ }
}

// Load the map, pruning entries past the serving window (and persisting the prune).
export function loadDeletedGroups(myPubkeyHex: string): DeletedGroupMap {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return {}
    const map = JSON.parse(raw) as DeletedGroupMap
    const cutoff = Date.now() - PRUNE_AGE_MS
    let pruned = false
    for (const id in map) { if (map[id] < cutoff) { delete map[id]; pruned = true } }
    if (pruned) save(myPubkeyHex, map)
    return map
  } catch { return {} }
}

// Fast lookup set for the group-definition handler (pruned on load).
export function loadDeletedGroupIdSet(myPubkeyHex: string): Set<string> {
  return new Set(Object.keys(loadDeletedGroups(myPubkeyHex)))
}

// Forget a group's deleted/left record (Phase C). Called when a genuine RE-INVITE lifts a 'left'
// group: the tombstone must go with it, or a later replay would find a stale entry and suppress the
// group again. Idempotent — absent id is a no-op.
export function clearDeletedGroup(myPubkeyHex: string, groupId: string): void {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    if (!raw) return
    const map = JSON.parse(raw) as DeletedGroupMap
    if (!(groupId in map)) return
    delete map[groupId]
    save(myPubkeyHex, map)
  } catch { /* quota / private mode */ }
}

// Record a group id as deleted (read-modify-write). Idempotent — re-deleting refreshes the timestamp.
export function recordDeletedGroup(myPubkeyHex: string, groupId: string): void {
  try {
    const raw = localStorage.getItem(key(myPubkeyHex))
    const map = raw ? JSON.parse(raw) as DeletedGroupMap : {}
    map[groupId] = Date.now()
    save(myPubkeyHex, map)
  } catch { /* quota / private mode */ }
}
