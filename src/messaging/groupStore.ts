import type { Group, GroupDef } from './types'

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
    return JSON.parse(raw) as Group[]
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
export function addOrUpdateGroup(pubkeyHex: string, current: Group[], def: GroupDef): Group[] {
  const existing = current.find(g => g.id === def.id)
  if (existing && !isPlaceholder(existing)) return current  // first real def wins — ignore later defs
  const group: Group = { id: def.id, name: def.name, members: def.members, createdAt: existing?.createdAt ?? Date.now() }
  const next = existing
    ? current.map(g => (g.id === def.id ? group : g))
    : [group, ...current]
  save(pubkeyHex, next)
  return next
}

// Ensure a (lazy) group entry exists for an id — used when a group message arrives before its
// definition. No-op if the group is already known. The placeholder renders as "Group <shortid>"
// until a definition upgrades it.
export function ensureGroup(pubkeyHex: string, current: Group[], groupId: string): Group[] {
  if (current.some(g => g.id === groupId)) return current
  const placeholder: Group = { id: groupId, name: '', members: [], createdAt: Date.now() }
  const next = [placeholder, ...current]
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
