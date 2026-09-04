import type { CaravelMessage, ReactionEntry } from './types'
import { getStoreKey } from '../crypto/sessionKey'
import { open, seal } from '../crypto/storeCrypto'

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
//
// ── ENCRYPTED AT REST (stage 3) ──────────────────────────────────────────────
//
// Sealed under the session store key through storeCrypto. This store holds the plaintext of every
// message in both directions, the confidential amount of every chat payment sent
// (LocalPaymentMeta.amountMicrotari, which the wire deliberately cannot carry), and the AES key for
// every image attachment (MediaRef.key). Encrypting the journal while this sat in the clear beside
// it would have been half a fix.
//
// THIS IS WHAT FALSIFIED blobCache's OLD ARGUMENT. That module reasoned that caching DECRYPTED image
// bytes bought nothing, because the key travels in the message and messages were plaintext at rest.
// Sealing MediaRef.key here broke the second half of that, leaving the cached images the only
// plaintext left. CLOSED IN STAGE 5 — blobCache seals its records under the same store key, and
// keeps the dead argument at putBlob rather than deleting it.
//
// ── THE COST, MEASURED ───────────────────────────────────────────────────────
//
// THIS IS THE HOT STORE. Every mutation rewrites the WHOLE history, so encryption cost scales with
// total messages rather than with the change. Measured (warmed, median of 7, realistic rows):
//
//     msgs   plaintext   JSON.stringify (before)   seal (now)   sealed size
//      500      176 KB                    0.2 ms       1.5 ms        235 KB
//    2 000      704 KB                    0.7 ms       9.1 ms        939 KB
//    5 000      1.7 MB                    2.9 ms      48.5 ms        2.3 MB
//   10 000      3.5 MB                    4.5 ms       126 ms        4.7 MB
//
// So sealing is 10-25x the cost of the write it replaces, and it is SYNCHRONOUS main-thread work on
// every message arrival. At realistic sizes that is single-digit milliseconds and invisible; from
// ~5 000 messages it is perceptible jank.
//
// Size grows a flat +33.3% (base64; the nonce and tag are noise). Against a ~5 MB localStorage
// quota, plaintext hit the wall near ~14 000 messages and sealed hits it near ~10 600 — encryption
// did not create that cliff, it moved it ~25% closer. THERE IS NO HISTORY CAP OR PRUNING IN THIS
// FILE, which is what makes the cliff reachable at all.
//
// FOLLOW-UP, DELIBERATELY NOT DONE HERE: add a history cap + chunking. It fixes both the quota
// cliff and the encryption jank, which land at roughly the same store size, and it is a hot-path
// refactor that deserves its own change rather than being bundled into a security stage.

// Keyed on Nostr pubkey hex, mirroring how txHistory keys on wallet address.
function key(pubkeyHex: string) { return `caravel.messages.v1.${pubkeyHex}` }

/** Readable rows, nothing stored, or present-but-unopenable. See journalStore for the full note. */
type ReadResult =
  | { status: 'ok'; messages: CaravelMessage[] }
  | { status: 'empty' }
  | { status: 'unreadable' }

function read(pubkeyHex: string): ReadResult {
  let raw: string | null
  try {
    raw = localStorage.getItem(key(pubkeyHex))
  } catch {
    return { status: 'unreadable' }
  }

  const opened = open(getStoreKey(), raw)
  if (opened.status !== 'ok') return opened

  try {
    const parsed = JSON.parse(opened.json) as CaravelMessage[]
    if (!Array.isArray(parsed)) return { status: 'unreadable' }
    return { status: 'ok', messages: parsed }
  } catch {
    return { status: 'unreadable' }
  }
}

export function loadMessages(pubkeyHex: string): CaravelMessage[] {
  const result = read(pubkeyHex)
  return result.status === 'ok' ? result.messages : []
}

/**
 * STILL RETURNS void, and there is no contract to preserve — all seven callers run inside React
 * state updaters (`setMessages(prev => addReceivedMessage(...))`) and have nowhere to route a
 * failure. SYNCHRONOUS for that same reason, which is why storeCrypto is built on @noble rather
 * than crypto.subtle: an async seal here would make every one of those updaters impure.
 *
 * A refused write leaves React state holding a message that disk does not, so a reload loses it.
 * THAT DIVERGENCE IS NOT NEW — it is exactly what a quota failure has always done here — and the
 * two refusals below simply add two more ways to reach it:
 *
 * 1. NO STORE KEY. Never a plaintext fallback; that would defeat the point entirely.
 * 2. THE CURRENT RECORD IS UNREADABLE. The guard against silent total loss. `current` is React
 *    state seeded by loadMessages at unlock, so under a wrong key it is [] — and without this, the
 *    first arriving message would encrypt a one-row array over the entire history it could not
 *    read. Losing one message to a refusal is recoverable; losing every message is not.
 */
function save(pubkeyHex: string, messages: CaravelMessage[]): void {
  const storeKey = getStoreKey()
  if (storeKey === null) return
  if (read(pubkeyHex).status === 'unreadable') return

  try {
    localStorage.setItem(key(pubkeyHex), seal(storeKey, JSON.stringify(messages)))
  } catch { /* quota / private mode */ }
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

// Should an inbound MUTATION be DROPPED because its target belongs to a group I have LEFT? (M4)
//
// Named for the target rather than for the edit because nothing in it is edit-specific: it reads
// the RECEIVER's own stored row and asks which group that row belongs to. Reactions (reactions v1)
// call it unchanged, and any future control message that names a logical id can too.
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
export function targetsLeftGroup(
  current: CaravelMessage[],
  logicalId: string,
  leftGroupIds: ReadonlySet<string>
): boolean {
  if (!logicalId) return false
  const target = current.find(m => m.logicalId === logicalId)
  if (!target?.groupId) return false
  return leftGroupIds.has(target.groupId)
}

// ── Emoji reactions (reactions v1) ────────────────────────────────────────────

// How many LIVE reactions one person may hold on one message. Enforced at SEND (so this client
// never emits a third) and again in the applier below (so a misbehaving peer cannot).
export const MAX_LIVE_REACTIONS_PER_REACTOR = 2

// Hard ceiling on TOTAL reaction rows per message, tombstoned rows INCLUDED. Removed rows are never
// deleted (they carry the seq high-water — see ReactionEntry), so without this a peer could cycle
// through hundreds of distinct emoji and permanently inflate one row in localStorage: each
// add/remove pair costs a row forever, and MAX_LIVE_REACTIONS_PER_REACTOR bounds only the LIVE set,
// not the distinct one. 64 is far above any real conversation (a 20-member group where everyone
// uses their full allowance is 40) and far below anything that hurts. Same class of bound as the
// length caps on attacker-controlled tag values in nostrMessaging.
const MAX_REACTION_ROWS = 64

// Which rows may carry reactions AT ALL: text messages only in v1.
//
// Checked on RECEIPT as well as at send, and that is the half that matters. Payment and media rows
// render as PaymentMessageCard / MediaMessageCard, neither of which has anywhere to show a pill, so
// a reaction naming one would be stored and never seen — quiet, permanent localStorage growth a
// peer on a richer client could produce without meaning anything by it. Dropping it is the same
// discipline the extractors follow: ignore what you do not fully understand rather than half-apply.
export function isReactableTarget(m: CaravelMessage): boolean {
  return !m.system && !m.payment && !m.media
}

// LIVE (non-tombstoned) reactions one person holds on one message. The send-side max-2 check and
// the applier's own cap both count with this, so the two can never disagree about what "two" means.
export function liveReactionCountBy(m: CaravelMessage, reactorPubkeyHex: string): number {
  if (!m.reactions) return 0
  let n = 0
  for (const r of m.reactions) if (r.by === reactorPubkeyHex && !r.removed) n++
  return n
}

// The seq a reaction from `reactorPubkeyHex` with `emoji` should carry: one past whatever has been
// applied for THAT PAIR. The direct analogue of nextRevision, and derived from stored state for the
// same reason — a send that failed and is retried recomputes the SAME number instead of drifting.
//
// Counts TOMBSTONED rows too, which is the whole point of keeping them: after add(1) → remove(2), a
// fresh add must be 3. If removal deleted the row this would answer 1, every peer still holding
// seq 2 would reject it, and the reaction would be silently un-re-addable forever.
export function nextReactionSeq(current: CaravelMessage[], logicalId: string, reactorPubkeyHex: string, emoji: string): number {
  const row = current.find(m => m.logicalId === logicalId)
  const entry = row?.reactions?.find(r => r.by === reactorPubkeyHex && r.emoji === emoji)
  return (entry?.seq ?? 0) + 1
}

// Apply an inbound (or locally-committed) reaction, keyed on LOGICAL id — the only name the sender
// and every recipient agree on, exactly as for edits. There is no by-message-id sibling: applyEdit
// has one only because M1 shipped store-only before the wire carried a logical id, and reactions
// have no such history, so every guard lives here in one function.
//
// GUARDS, IN ORDER (each returns `current` BY REFERENCE, so a rejected event costs no re-render):
//   1. seq is a positive safe integer                 — malformed ordering key, unusable
//   2. the target row exists                          — unknown / deleted / never received
//   3. the target is reactable                        — text only in v1; see isReactableTarget
//   4. the per-message row cap                        — only for a NEW pair; see MAX_REACTION_ROWS
//   5. seq > the stored seq for THIS (by, emoji)      — stale or replayed; the ordering guard
// then: `add` clears the tombstone, `remove` sets it, and BOTH bump the stored seq.
//
// AUTHORSHIP IS DELIBERATELY ABSENT, which is the one substantive divergence from applyEdit. Anyone
// may react to anyone's message, including in a group where every member knows every logical id.
// That is safe because `reactorPubkeyHex` comes from the authenticated seal and nowhere else: the
// (by, emoji) key means an inbound reaction can only ever create or flip the row belonging to its
// own sender. "Only you can remove your reaction" therefore holds BY CONSTRUCTION — there is no way
// to address someone else's row — rather than by a check a future edit here could forget to keep.
//
// MAX-2 ON THE RECEIVE SIDE IS AN ANTI-ABUSE BOUND, NOT A CONSENSUS RULE. Backfill order is
// arbitrary (gift wraps fuzz created_at by up to 2 days), so if a misbehaving client emits three
// live reactions from one person, two devices may keep a different two. A cap-rejected add is
// stored as a TOMBSTONE rather than dropped, so its seq is still recorded and a later legitimate
// remove/re-add of that pair orders correctly; what it cannot do is agree with the other device
// about which two are showing. The sender-side cap is the real one — this is the backstop.
//
// KNOWN GAP — ORPHAN REACTIONS (parked). A reaction arriving BEFORE the message it names is
// silently and permanently lost: guard 2 no-ops, and nothing ever replays it. Identical in shape,
// cause and cure to the ORPHAN EDITS gap documented on applyEditByLogicalId above — it needs a
// buffer of unmatched events with its own storage and pruning story, not a line in this function.
export function applyReactionByLogicalId(
  pubkeyHex: string,
  current: CaravelMessage[],
  logicalId: string,
  emoji: string,
  action: 'add' | 'remove',
  seq: number,
  reactorPubkeyHex: string
): CaravelMessage[] {
  if (!logicalId || !emoji || !reactorPubkeyHex) return current
  if (!Number.isSafeInteger(seq) || seq <= 0) return current

  const index = current.findIndex(m => m.logicalId === logicalId)
  if (index === -1) return current                                   // absent, incl. deleted
  const target = current[index]
  if (!isReactableTarget(target)) return current

  const rows = target.reactions ?? []
  const entryIndex = rows.findIndex(r => r.by === reactorPubkeyHex && r.emoji === emoji)
  // The cap bites only on a NEW pair — an update to a pair already stored adds no row, so refusing
  // it would freeze the message's existing reactions instead of merely refusing to grow them.
  if (entryIndex === -1 && rows.length >= MAX_REACTION_ROWS) return current

  const existing = entryIndex === -1 ? undefined : rows[entryIndex]
  if (existing && seq <= existing.seq) return current                // stale / replayed

  // An `add` beyond the allowance is recorded as a TOMBSTONE, not applied and not dropped: the row
  // carries the seq forward so this pair stays orderable, while showing nothing. See the note above.
  let removed = action === 'remove'
  if (action === 'add') {
    let live = 0
    for (let i = 0; i < rows.length; i++) {
      if (i !== entryIndex && rows[i].by === reactorPubkeyHex && !rows[i].removed) live++
    }
    if (live >= MAX_LIVE_REACTIONS_PER_REACTOR) removed = true
  }

  // `removed` is spread in only when true, so a live row is byte-identical to one written before
  // any removal existed — the same absent-not-undefined discipline the send path uses for media.
  const entry: ReactionEntry = { by: reactorPubkeyHex, emoji, seq, at: Date.now(), ...(removed ? { removed: true } : {}) }
  const nextRows = [...rows]
  if (entryIndex === -1) nextRows.push(entry)
  else nextRows[entryIndex] = entry

  // New object, new reactions array AND new outer array — ChatApp memoises deriveConversations on
  // the array identity, so an in-place write would persist correctly and still show nothing.
  const next = [...current]
  next[index] = { ...target, reactions: nextRows }
  save(pubkeyHex, next)
  return next
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
