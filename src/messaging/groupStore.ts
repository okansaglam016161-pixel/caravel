import type { Group, GroupDef, GroupState } from './types'

// Local persistence for groups, sibling to messageStore.ts. Same shape of problem: localStorage
// keyed per identity, loaded on unlock, merged on arrival, React state cleared on lock while the
// stored copy persists. Phase 1: fan-out messaging, in-message roster, fixed membership.

// ── Storage ───────────────────────────────────────────────────────────────────

// Keyed on Nostr pubkey hex, mirroring messageStore.
function key(pubkeyHex: string) { return `caravel.groups.v1.${pubkeyHex}` }

export function loadGroups(pubkeyHex: string): Group[] {
  try {
    const raw = localStorage.getItem(key(pubkeyHex))
    if (!raw) return []
    const stored = JSON.parse(raw) as Group[]
    // LAZY MIGRATION (Phase A): a group persisted before the invite-gating field existed has no
    // `state`. It was already visible, so default it to 'active' — nothing regresses. Same shape as
    // the DM lazy 'accepted' migration. No one-time backfill; done on every load.
    return stored.map(g => (g.state ? g : { ...g, state: 'active' as GroupState }))
  } catch { return [] }
}

function save(pubkeyHex: string, groups: Group[]): void {
  try { localStorage.setItem(key(pubkeyHex), JSON.stringify(groups)) } catch { /* quota / private mode */ }
}

// A lazy placeholder is a group we learned of from a message before its definition arrived: it has
// no members and no real name. The first real definition upgrades it in place.
function isPlaceholder(g: Group): boolean {
  return g.members.length === 0
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

// Apply a received (or local) group definition. FIRST-DEF-WINS: once a real (non-placeholder) group
// exists for an id, later definitions are ignored (Phase 1 has no roster changes). A def upgrades a
// lazy placeholder created earlier by a group message.
//
// `initialState` sets the lifecycle state ONLY when creating a brand-new group: 'pending' for an
// inbound def (invite-gated — held until accepted), 'active' for local creation (I made it). When
// upgrading a placeholder, the EXISTING state is preserved — a placeholder created 'pending' by a
// message-first arrival stays pending after its def lands, and a 'left' placeholder stays left.
//
// PHASE C (re-invite) LANDED HERE: `reinvite` is the opt-in that lets a genuine re-invite def lift a
// locally 'left' group, bypassing first-def-wins for that ONE case. The caller must have verified
// the def carried the caravel-group-reinvite marker AND that its event id was not already acted on
// (seenDefStore) — this function does not and cannot check either.
//
// INDEPENDENCE FROM THE DELETE SUPPRESSION (d3baa8b) — the reason this is safe to touch alone:
// a 'left' group's record is KEPT, so it is PRESENT locally, so onGroupDefinition's present-check
// (`!prev.some(id) && deletedGroupsRef.has(id)`) never fires for it — only first-def-wins here does.
// A DELETED group is the mirror image: its record is ABSENT, so the present-check is what stops it
// and this function is never reached. The two suppressions cover disjoint cases, which is why
// Phase C changes this line and leaves the present-check byte-for-byte alone.
export function addOrUpdateGroup(
  pubkeyHex: string,
  current: Group[],
  def: GroupDef,
  initialState: GroupState = 'active',
  opts: { reinvite?: boolean } = {},
): Group[] {
  const existing = current.find(g => g.id === def.id)
  // RE-INVITE LIFT: a marked, not-yet-acted-on def for a group I have LEFT. Replace the record from
  // the new def (name/roster may have changed while I was away) and return it to 'pending', so it
  // surfaces as an ordinary invite card and goes through the normal Accept/Decline flow — never
  // straight to 'active'. Scoped to state === 'left': a 'pending' or 'active' group is untouched by
  // a re-invite marker, so first-def-wins still holds everywhere else.
  if (opts.reinvite && existing && existing.state === 'left') {
    const lifted: Group = { id: def.id, name: def.name, members: def.members, createdAt: existing.createdAt, state: 'pending' }
    const next = current.map(g => (g.id === def.id ? lifted : g))
    save(pubkeyHex, next)
    return next
  }
  if (existing && !isPlaceholder(existing)) return current  // first real def wins — ignore later defs
  const group: Group = {
    id: def.id,
    name: def.name,
    members: def.members,
    createdAt: existing?.createdAt ?? Date.now(),
    state: existing?.state ?? initialState,  // upgrade preserves state; new group takes initialState
  }
  const next = existing
    ? current.map(g => (g.id === def.id ? group : g))
    : [group, ...current]
  save(pubkeyHex, next)
  return next
}

// Ensure a (lazy) group entry exists for an id — used when a group message arrives before its
// definition. No-op if the group is already known. The placeholder renders as "Group <shortid>"
// until a definition upgrades it.
//
// A brand-new placeholder is created 'pending' (invite-gated): a group we first learn of from a
// message is held out of the active thread until accepted, closing the message-first bypass (a def
// would otherwise be the only gated entry point). A later def upgrades it in place, preserving state.
export function ensureGroup(pubkeyHex: string, current: Group[], groupId: string): Group[] {
  if (current.some(g => g.id === groupId)) return current
  const placeholder: Group = { id: groupId, name: '', members: [], createdAt: Date.now(), state: 'pending' }
  const next = [placeholder, ...current]
  save(pubkeyHex, next)
  return next
}

// Is this group known locally? Reads the PERSISTED store, which every mutation helper here writes
// synchronously — so it is authoritative at call time, unlike a snapshot held in a ref. Used by the
// system-notice ingest gate (B-M2), which must not depend on React commit timing: a group learned
// moments earlier in the same relay backfill burst is already saved here and answers true.
// Deliberately not used for per-message gates — this parses the whole store, which is fine for the
// rare control message but not for every inbound message.
export function hasGroup(pubkeyHex: string, groupId: string): boolean {
  return loadGroups(pubkeyHex).some(g => g.id === groupId)
}

// A group's persisted lifecycle state, or undefined if unknown locally. Same authoritative-at-call-
// time property as hasGroup, and used for the same reason: the re-invite lift (Phase C) must decide
// against real state, not a ref snapshot that the [groups] effect has not caught up with. Also rare
// (one call per received def), so the whole-store parse is fine.
export function getGroupState(pubkeyHex: string, groupId: string): GroupState | undefined {
  return loadGroups(pubkeyHex).find(g => g.id === groupId)?.state
}

// Set a group's lifecycle state (read-modify-write, persisted). No-op if the group is absent or
// already in that state. Drives accept (pending → active) and decline (pending → left).
export function setGroupState(pubkeyHex: string, current: Group[], groupId: string, state: GroupState): Group[] {
  const existing = current.find(g => g.id === groupId)
  if (!existing || existing.state === state) return current
  const next = current.map(g => (g.id === groupId ? { ...g, state } : g))
  save(pubkeyHex, next)
  return next
}

// Remove a group (Phase 1 local cleanup). Its groupId-keyed messages are removed separately via
// messageStore.deleteGroupMessages.
export function deleteGroup(pubkeyHex: string, current: Group[], groupId: string): Group[] {
  const next = current.filter(g => g.id !== groupId)
  if (next.length === current.length) return current
  save(pubkeyHex, next)
  return next
}
