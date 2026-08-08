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
// PHASE C (re-invite) TOUCHES THIS: first-def-wins makes 'left' permanent — it also swallows a
// genuine re-invite def. Lifting 'left' on a real new invite is a deliberate Phase C change and
// must be added here (and/or the present-check in onGroupDefinition), not discovered as a surprise.
export function addOrUpdateGroup(pubkeyHex: string, current: Group[], def: GroupDef, initialState: GroupState = 'active'): Group[] {
  const existing = current.find(g => g.id === def.id)
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
