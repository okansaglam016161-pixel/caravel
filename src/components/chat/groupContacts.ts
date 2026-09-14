// Who can be added to a group.
//
// ── THE DIVERGENCE THIS EXISTS TO END ────────────────────────────────────────
//
// The sidebar and this picker answered "who are my contacts?" from different places, and disagreed.
// The sidebar derives from MESSAGES and treats a peer with no contact record as accepted — a
// deliberate lazy migration, since conversations predating the contact-state feature were never
// backfilled. The picker read `Object.entries(contacts)` and could only ever see peers with an
// explicit record.
//
// So anyone with messages and no record was in the sidebar and invisible here, and the picker said
// "No contacts yet" about people the user could see one pane over. Reachable without doing anything
// unusual: any conversation older than the feature, and anyone whose record was refused while the
// contacts store was unreadable (messages kept arriving; the writes did not land).
//
// The two lines even LOOKED alike — both tested `(c?.state ?? 'accepted') === 'accepted'`. On the
// sidebar that default is the whole lazy-migration rule; in the picker it was dead, because only
// keys that exist reach the callback. Identical text, opposite meaning, which is most of why the
// divergence survived review.
//
// One rule, applied once, over the union of both populations.

import type { ContactMap } from '../../messaging/contactStore'
import type { GroupContactOption } from './CreateGroupModal'

export interface GroupContactInput {
  /**
   * Every peer with DM messages, in the order the sidebar shows them (most recent first). Records
   * with no conversation are appended after these — see the ordering note below.
   */
  conversationPeers: readonly string[]
  contacts: ContactMap
  /** My own pubkey, excluded from the result. Null while locked. */
  mePubkeyHex: string | null
  /** Nickname or truncated npub, resolved by the caller so this stays pure. */
  nameFor: (hex: string) => string
}

/**
 * The accepted contacts offered in the create-group modal.
 *
 * ── THE UNION, AND WHY BOTH HALVES ARE NEEDED ────────────────────────────────
 *
 * Conversations alone would drop a peer accepted but not yet messaged — startWith and acceptContact
 * both write an accepted record before any message exists, which is the state the DM thread already
 * synthesises an empty conversation for. Records alone is the bug above. Neither is the whole set.
 *
 * ── ONE ACCEPTANCE RULE FOR BOTH ─────────────────────────────────────────────
 *
 * `(contacts[hex]?.state ?? 'accepted') === 'accepted'` covers the union exactly, because the
 * default fires for precisely the half that needs it: a conversation peer with no record is the
 * lazy-accepted case, while a record-only peer always has a record, so the default cannot reach it
 * and its real state decides. A peer still PENDING is a request, not a contact, and is excluded by
 * the same line.
 *
 * ── SELF IS EXCLUDED, WHICH IT WAS NOT BEFORE ────────────────────────────────
 *
 * Notes-to-self are an ordinary conversation and sending one writes an accepted record under your
 * OWN key, so the old derivation could already offer you yourself — and sourcing from conversations
 * would make that the common case rather than the rare one. createGroup puts the creator in the
 * roster unconditionally, so picking yourself was never anything but a confusing no-op.
 *
 * ORDER is conversation order first — which is recency, as the sidebar presents it — then the
 * record-only peers. Deterministic, and it puts the people most recently spoken to at the top, where
 * a picker wants them.
 */
export function buildGroupContactOptions(input: GroupContactInput): GroupContactOption[] {
  const { conversationPeers, contacts, mePubkeyHex, nameFor } = input

  const accepted = (hex: string) => (contacts[hex]?.state ?? 'accepted') === 'accepted'

  const seen = new Set<string>()
  const out: GroupContactOption[] = []
  const take = (hex: string) => {
    if (!hex || hex === mePubkeyHex || seen.has(hex) || !accepted(hex)) return
    seen.add(hex)
    out.push({ hex, name: nameFor(hex) })
  }

  for (const hex of conversationPeers) take(hex)
  for (const hex of Object.keys(contacts)) take(hex)
  return out
}
