import type { CaravelMessage } from './types'

// Local persistence for messages, sibling to crypto/txHistory.ts. Same shape of problem:
// localStorage keyed per identity, load on unlock, merge on arrival, clear React state on lock
// while the stored copy persists. Two deliberate divergences from txHistory:
//   1. No bigint fields — CaravelMessage is fully JSON-safe, so there is no toRaw/fromRaw layer.
//   2. Function names are *Message-suffixed to avoid colliding with txHistory's addSent, which
//      WalletContext imports alongside these.

// Window within which a self-authored 'received' copy is treated as an echo of a local 'sent'
// message (see addReceivedMessage). Generous enough to cover relay round-trip + clock skew.
const SELF_ECHO_WINDOW_MS = 60_000

// ── Storage ───────────────────────────────────────────────────────────────────

// Keyed on Nostr pubkey hex, mirroring how txHistory keys on wallet address.
function key(pubkeyHex: string) { return `caravel.messages.v1.${pubkeyHex}` }

export function loadMessages(pubkeyHex: string): CaravelMessage[] {
  try {
    const raw = localStorage.getItem(key(pubkeyHex))
    if (!raw) return []
    return JSON.parse(raw) as CaravelMessage[]
  } catch { return [] }
}

function save(pubkeyHex: string, messages: CaravelMessage[]): void {
  try { localStorage.setItem(key(pubkeyHex), JSON.stringify(messages)) } catch { /* quota / private mode */ }
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

// Record a message we just sent (route a: the CaravelMessage returned by sendMessage).
// Deduped by event id so a double-fire can't create two rows. Newest-first, like txHistory.
export function addSentMessage(pubkeyHex: string, current: CaravelMessage[], msg: CaravelMessage): CaravelMessage[] {
  if (current.some(m => m.id === msg.id)) return current
  const next = [msg, ...current]
  save(pubkeyHex, next)
  return next
}

// Merge an incoming message from the subscription (provider marks these 'received').
export function addReceivedMessage(pubkeyHex: string, current: CaravelMessage[], incoming: CaravelMessage): CaravelMessage[] {
  // Dedup by gift-wrap event id — the same event arrives from multiple relays and is
  // re-fetched on each unlock. First-seen wins, so the stored timestamp stays stable
  // (this is what gives real per-message timing instead of all-the-unlock-moment).
  if (current.some(m => m.id === incoming.id)) return current

  // Self-authored copy: NIP-17 can gift-wrap a copy back to the sender. It unwraps with
  // senderPubkeyHex === our own pubkey, and carries no recipient (unwrap doesn't expose the
  // rumor's p-tag), so a locally-recorded 'sent' row is strictly richer.
  if (incoming.senderPubkeyHex === pubkeyHex) {
    const echoOfLocalSend = current.some(m =>
      m.direction === 'sent' &&
      // Content match, widened for edits (M1): the echo carries the text as SENT, but applyEdit
      // has since overwritten `plaintext` — so also compare the pre-edit text it preserved.
      // Without this a late echo of an edited message fails every match and is stored as a
      // duplicate 'sent from another device' row. Matching on event id instead is not an option:
      // the echo is a DIFFERENT event with its own id (same-id is already handled above).
      (m.plaintext === incoming.plaintext || m.preEditPlaintext === incoming.plaintext) &&
      m.groupId === incoming.groupId &&   // don't cross-match a DM and a same-text group message
      Math.abs(m.timestamp - incoming.timestamp) < SELF_ECHO_WINDOW_MS
    )
    // Have the local 'sent' already → drop the redundant echo. Otherwise it was sent from
    // another device: keep it, flipped to 'sent' so it renders on the correct side. Recipient
    // is unrecoverable here, left blank until a later milestone can resolve it.
    if (echoOfLocalSend) return current
    const fromOtherDevice: CaravelMessage = { ...incoming, direction: 'sent', recipientPubkeyHex: '' }
    const next = [fromOtherDevice, ...current]
    save(pubkeyHex, next)
    return next
  }

  const next = [incoming, ...current]
  save(pubkeyHex, next)
  return next
}

// ── Editing (M1) ──────────────────────────────────────────────────────────────

// Apply an edit to a stored message, replacing its text in place — Caravel keeps no version
// history. THE FIRST MUTATION in this store: every other helper appends (dedup-by-id,
// first-write-wins) or bulk-deletes, so the guards below are what keep that contract honest.
//
// Rejects — returning `current` BY REFERENCE, so React skips the re-render, exactly as the delete
// helpers do — unless all of these hold:
//
//   1. the message exists. This is ALSO the deleted/tombstoned check: deleteConversation removes
//      the rows as well as tombstoning their ids, so a deleted message is simply absent from
//      `current` and this store needs no dependency on tombstoneStore.
//   2. the editor authored it. Gift-wrap event ids are PUBLIC on relays, so without this check
//      anyone who saw one could rewrite someone else's message. `senderPubkeyHex` is our own key
//      on 'sent' rows and the peer's on 'received', so one comparison covers both directions.
//   3. it is not a system notice — a group-leave row has empty plaintext composed at render time,
//      so editing one would put a stray bubble in the thread.
//   4. `revision` is strictly newer than any revision already applied. STRICTLY: the same edit is
//      re-delivered by every relay that has it and again by the ~2-day backfill on each unlock, so
//      a replay must be a no-op. That is also what makes this safe under React StrictMode, which
//      double-invokes the functional updater this runs inside.
//
// `timestamp` is deliberately never written: threads order by it, so an edit that touched it would
// jump the message to the bottom and destroy the real per-message timing the dedup guard in
// addReceivedMessage exists to protect. payment / localPayment / groupId / direction all survive —
// only the text changes.
export function applyEdit(
  pubkeyHex: string,
  current: CaravelMessage[],
  messageId: string,
  newText: string,
  revision: number,
  editorPubkeyHex: string
): CaravelMessage[] {
  if (!Number.isInteger(revision) || revision <= 0) return current

  const index = current.findIndex(m => m.id === messageId)
  if (index === -1) return current                                   // absent, incl. deleted
  const target = current[index]
  if (target.senderPubkeyHex !== editorPubkeyHex) return current     // authorship
  if (target.system) return current                                  // never edit a system notice
  if (revision <= (target.revision ?? 0)) return current             // stale / replayed edit

  // New object AND new array: ChatApp memoises deriveConversations on the array identity, so an
  // in-place write would persist correctly and still leave the UI showing the old text.
  const edited: CaravelMessage = {
    ...target,
    plaintext: newText,
    editedAt: Date.now(),
    revision,
    // First edit only — pin the text as actually SENT, for the echo suppressor above.
    preEditPlaintext: target.preEditPlaintext ?? target.plaintext,
  }
  const next = [...current]
  next[index] = edited
  save(pubkeyHex, next)
  return next
}

// The revision an edit of `logicalId` should carry: one past whatever has been applied, so it
// satisfies applyEdit's strictly-newer guard. Derived from stored state rather than a counter, so a
// send that failed and is retried recomputes the SAME number instead of drifting. An unknown
// logicalId yields 1 — harmless, because the caller checks the message exists before sending.
export function nextRevision(current: CaravelMessage[], logicalId: string): number {
  const row = current.find(m => m.logicalId === logicalId)
  return (row?.revision ?? 0) + 1
}

// Find a message by its LOGICAL id (replies v1). The read-only sibling of applyEditByLogicalId, and
// deliberately the same shape: logicalId is the only name sender and recipients agree on, so it is
// the only usable handle for "the message this reply quotes".
//
// PURE — no persistence, which is why it takes no pubkeyHex. An empty id or an unknown one returns
// undefined, and the caller renders the "original unavailable" placeholder: a reply whose target we
// never received, or have since deleted, is a normal and expected state, not an error.
//
// NOT the render path. Resolving a quote by calling this once per rendered reply is O(rows × replies)
// over an array holding EVERY thread's messages; the views build one Map per render pass instead
// (see QuotedPreview). This is the primitive for logic and tests, where clarity beats sharing a map.
export function findByLogicalId(current: CaravelMessage[], logicalId: string | undefined): CaravelMessage | undefined {
  if (!logicalId) return undefined
  return current.find(m => m.logicalId === logicalId)
}

// applyEdit keyed by LOGICAL id — the name an edit travels under on the wire, since `id` is not
// shared between sender and recipients for group messages (see CaravelMessage.logicalId).
//
// Deliberately a thin sibling rather than a change to applyEdit's key: every guard stays inside
// applyEdit (authorship, revision, system row, existence), so this cannot weaken them, and M1's
// primitive plus its tests are untouched. An unknown logicalId returns `current` by reference —
// which is also how a tombstoned/deleted message is handled, since deletion removes the row, and how
// an edit for a group I left but whose messages I deleted resolves.
//
// KNOWN GAP — ORPHAN EDITS (parked, not fixed in M4). An edit that arrives BEFORE the message it
// names is silently and PERMANENTLY lost: this no-ops, then the message lands carrying its original
// text and nothing ever re-applies the edit. Gift wraps randomise created_at by up to 2 days, so
// relay backfill order is arbitrary and this is reachable, not theoretical. It has been true since
// M2 for DMs; M4 makes it more likely in groups, where the message and its edit are separate wraps
// racing independently to each of N members. Fixing it needs an orphan-edit buffer — hold unmatched
// edits, replay them when a matching logicalId first appears, age them out — which is its own
// feature with its own storage and pruning story, not a line in this function.
export function applyEditByLogicalId(
  pubkeyHex: string,
  current: CaravelMessage[],
  logicalId: string,
  newText: string,
  revision: number,
  editorPubkeyHex: string
): CaravelMessage[] {
  if (!logicalId) return current
  const target = current.find(m => m.logicalId === logicalId)
  if (!target) return current
  return applyEdit(pubkeyHex, current, target.id, newText, revision, editorPubkeyHex)
}

// Did a group edit's fan-out do ENOUGH to commit it locally? (M4)
//
// Lives here, beside applyEditByLogicalId, because it is the OUTBOUND half of the same commit
// decision: this decides whether an edit we sent is written to our own store, and the UI's optimistic
// layer reads the same answer to decide whether the bubble keeps the new text or snaps back. One
// definition, so the two can never disagree. (Nothing about it touches localStorage, which is why it
// takes no messages — it is policy, not persistence.)
//
// The boundary is TOTAL failure, not partial. Reaching some members is the same best-effort outcome a
// group MESSAGE has, and snapping back would be the bigger lie: the members who did receive it are
// already showing the new text, so refusing locally would put the AUTHOR out of step with them. The
// shortfall is reported honestly in the group composer footer instead.
//
// memberCount === 0 is ok, not a failure: a solo roster (or a lazy placeholder with no roster yet)
// has nobody to reach, and calling that failure would make its messages permanently un-editable.
// Mirrors sendGroupMessage's `recipients.length > 0 && membersReached === 0` throw guard exactly.
export function editReachOk(memberCount: number, membersReached: number): boolean {
  return memberCount === 0 || membersReached > 0
}

// Should an inbound edit be DROPPED because its target belongs to a group I have LEFT? (M4)
//
// The gap this closes was latent until group editing existed: leave/decline are NON-DESTRUCTIVE, so
// a left group's rows are kept and merely hidden by state — which means an edit naming one would
// have been applied, silently rewriting history inside a group whose whole contract (B-M2) is that
// "nothing about this group should touch the store again". The DM path could never hit it: a DM has
// no left state, and a DELETED conversation's rows are gone, which applyEditByLogicalId already
// no-ops on.
//
// KEYED ON THE RECEIVER'S OWN ROW, not on anything in the edit. An edit carries no group tag on the
// wire (wrapEdit), and it deliberately doesn't need one: the stored row IS the authoritative
// statement of which group the target belongs to, so this covers left / deleted / never-had alike
// and works for an edit from ANY client version, including one older than M4.
//
// Answers false for a DM, an unknown logical id, and a live group — so the caller can apply, and
// applyEditByLogicalId's own guards decide the rest.
export function editTargetsLeftGroup(
  current: CaravelMessage[],
  logicalId: string,
  leftGroupIds: ReadonlySet<string>
): boolean {
  if (!logicalId) return false
  const target = current.find(m => m.logicalId === logicalId)
  if (!target?.groupId) return false
  return leftGroupIds.has(target.groupId)
}

// Delete every message belonging to one peer conversation (M9.0a). Membership matches
// ChatApp's deriveConversations: the "other party" is senderPubkeyHex for received, recipientPubkeyHex
// for sent. Returns the remaining messages (also persisted). Caller must tombstone the deleted ids
// FIRST so a relay backfill can't repopulate them in the gap.
export function deletePeerMessages(pubkeyHex: string, current: CaravelMessage[], peerHex: string): CaravelMessage[] {
  const next = current.filter(m => {
    const other = m.direction === 'received' ? m.senderPubkeyHex : m.recipientPubkeyHex
    return other !== peerHex
  })
  if (next.length === current.length) return current
  save(pubkeyHex, next)
  return next
}

// Delete every message belonging to a group (Phase 1 group cleanup — pairs with groupStore.deleteGroup).
export function deleteGroupMessages(pubkeyHex: string, current: CaravelMessage[], groupId: string): CaravelMessage[] {
  const next = current.filter(m => m.groupId !== groupId)
  if (next.length === current.length) return current
  save(pubkeyHex, next)
  return next
}
