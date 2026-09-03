// Unit tests for the message store's EDIT path (M1) — the first mutation in a store that is
// otherwise append-only / first-write-wins / dedup-by-id. applyEdit's guards are what keep that
// contract honest, and a bug here corrupts stored messages, so each guard is covered explicitly.

import { beforeEach, describe, expect, it } from 'vitest'
import { clearStoreKey, setStoreKey } from '../crypto/sessionKey'
import {
  addReceivedMessage, addSentMessage, applyEdit, applyEditByLogicalId, applyReactionByLogicalId, deletePeerMessages, editReachOk, findByLogicalId, isReactableTarget, liveReactionCountBy, loadMessages, nextReactionSeq, nextRevision, targetsLeftGroup,
} from './messageStore'
import { sortKey, type CaravelMessage } from './types'

// messageStore persists through localStorage, which does not exist under Vitest's node
// environment. A tiny in-memory Storage keeps the dependency footprint at one package (no jsdom)
// and lets the tests assert what was actually WRITTEN, not just what was returned.
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

const ME = 'a'.repeat(64)
const PEER = 'b'.repeat(64)

function msg(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: 'evt1',
    senderPubkeyHex: ME,
    recipientPubkeyHex: PEER,
    plaintext: 'original',
    timestamp: 1_000_000,
    direction: 'sent',
    ...over,
  }
}

// Messages are sealed at rest from stage 3 on, so these specs run against the ENCRYPTED path —
// every dedup, edit, reaction and deletion rule below is now verified through real
// XChaCha20-Poly1305 rather than over bare JSON. A fixed key keeps them deterministic.
const STORE_KEY = new Uint8Array(32).fill(42)

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

describe('applyEdit — guards', () => {
  it('rejects an editor who did not author the message', () => {
    // The forgery case: wrap ids are public on relays, so an unauthenticated edit path would let
    // any observer rewrite someone else's message.
    const current = [msg({ senderPubkeyHex: PEER, direction: 'received' })]
    const next = applyEdit(ME, current, 'evt1', 'hijacked', 1, ME)

    expect(next).toBe(current)                       // same reference — React skips the re-render
    expect(next[0].plaintext).toBe('original')
  })

  it('rejects a stale or equal revision (out-of-order edit protection)', () => {
    const current = [msg({ plaintext: 'v2', revision: 2 })]

    expect(applyEdit(ME, current, 'evt1', 'v1-late', 1, ME)).toBe(current)   // older
    expect(applyEdit(ME, current, 'evt1', 'v2-again', 2, ME)).toBe(current)  // equal
    expect(current[0].plaintext).toBe('v2')
  })

  it('rejects a non-existent id — which is also the deleted/tombstoned case', () => {
    // deleteConversation removes the rows as well as tombstoning the ids, so a deleted message is
    // simply absent here. That is why applyEdit needs no tombstoneStore dependency.
    const current = [msg()]
    expect(applyEdit(ME, current, 'evt-deleted', 'ghost', 1, ME)).toBe(current)
  })

  it('rejects a system notice row', () => {
    const current = [msg({ system: 'group-leave', plaintext: '', groupId: 'g1' })]
    expect(applyEdit(ME, current, 'evt1', 'not allowed', 1, ME)).toBe(current)
  })

  it('rejects a non-positive or non-integer revision', () => {
    const current = [msg()]
    expect(applyEdit(ME, current, 'evt1', 'x', 0, ME)).toBe(current)
    expect(applyEdit(ME, current, 'evt1', 'x', -1, ME)).toBe(current)
    expect(applyEdit(ME, current, 'evt1', 'x', 1.5, ME)).toBe(current)
  })
})

describe('applyEdit — successful apply', () => {
  it('replaces the text, stamps editedAt/revision, and preserves everything else', () => {
    const current = [msg({
      payment: { utxoId: 'utxo_1' },
      localPayment: { amountMicrotari: '42', txId: 'tx_1' },
      groupId: 'g1',
    })]
    const next = applyEdit(ME, current, 'evt1', 'edited', 1, ME)
    const row = next[0]

    expect(row.plaintext).toBe('edited')
    expect(row.revision).toBe(1)
    expect(row.editedAt).toBeTypeOf('number')
    expect(row.preEditPlaintext).toBe('original')

    // timestamp frozen — threads order by it, so an edit must not move the message.
    expect(row.timestamp).toBe(1_000_000)
    // untouched payload
    expect(row.payment).toEqual({ utxoId: 'utxo_1' })
    expect(row.localPayment).toEqual({ amountMicrotari: '42', txId: 'tx_1' })
    expect(row.groupId).toBe('g1')
    expect(row.direction).toBe('sent')
    expect(row.recipientPubkeyHex).toBe(PEER)
  })

  it('produces a new array and a new row object, mutating neither input', () => {
    // ChatApp memoises deriveConversations on the array identity — an in-place write would
    // persist correctly and still leave the UI showing the old text.
    const original = msg()
    const current = [original]
    const next = applyEdit(ME, current, 'evt1', 'edited', 1, ME)

    expect(next).not.toBe(current)
    expect(next[0]).not.toBe(original)
    expect(original.plaintext).toBe('original')
    expect(current[0].plaintext).toBe('original')
  })

  it('persists the edit', () => {
    applyEdit(ME, [msg()], 'evt1', 'edited', 1, ME)
    expect(loadMessages(ME)[0].plaintext).toBe('edited')
  })

  it('is idempotent on replay, and keeps the ORIGINAL text in preEditPlaintext across edits', () => {
    // The same edit arrives from every relay holding it, and again from the ~2-day backfill on
    // each unlock; the strict > guard is also what makes this safe under StrictMode's
    // double-invoked updaters.
    const current = [msg()]
    const first = applyEdit(ME, current, 'evt1', 'edited', 1, ME)
    const replay = applyEdit(ME, first, 'evt1', 'edited', 1, ME)
    expect(replay).toBe(first)

    // A genuine second edit advances; preEditPlaintext still holds the text as SENT, not 'edited'.
    const second = applyEdit(ME, first, 'evt1', 'edited twice', 2, ME)
    expect(second[0].plaintext).toBe('edited twice')
    expect(second[0].revision).toBe(2)
    expect(second[0].preEditPlaintext).toBe('original')
  })

  it('edits a received message when the peer authored it', () => {
    const current = [msg({ senderPubkeyHex: PEER, direction: 'received' })]
    const next = applyEdit(ME, current, 'evt1', 'peer edited', 1, PEER)
    expect(next[0].plaintext).toBe('peer edited')
  })
})

describe('addReceivedMessage — self-echo suppressor after an edit', () => {
  it('still suppresses a late echo carrying the PRE-EDIT text', () => {
    // Regression for the bug the edit feature would otherwise introduce: the suppressor matches on
    // content, so once applyEdit overwrites plaintext a late echo of the original text matches
    // nothing and lands as a duplicate 'from another device' row.
    const sent = msg({ plaintext: 'helo' })
    const stored = applyEdit(ME, addSentMessage(ME, [], sent), 'evt1', 'hello', 1, ME)
    expect(stored[0].plaintext).toBe('hello')

    // The echo is a DIFFERENT event (its own id) carrying the text as sent.
    const echo: CaravelMessage = {
      id: 'evt-echo',
      senderPubkeyHex: ME,
      recipientPubkeyHex: '',
      plaintext: 'helo',
      timestamp: 1_000_500,      // inside SELF_ECHO_WINDOW_MS
      direction: 'received',
    }
    const next = addReceivedMessage(ME, stored, echo)

    expect(next).toBe(stored)    // suppressed
    expect(next).toHaveLength(1)
  })

  it('still suppresses a normal (unedited) echo, and still keeps a genuine other-device message', () => {
    const stored = addSentMessage(ME, [], msg({ plaintext: 'hello' }))

    const echo: CaravelMessage = {
      id: 'evt-echo', senderPubkeyHex: ME, recipientPubkeyHex: '',
      plaintext: 'hello', timestamp: 1_000_500, direction: 'received',
    }
    expect(addReceivedMessage(ME, stored, echo)).toBe(stored)

    // Different text, self-authored → genuinely from another device, so it must still be kept.
    const other: CaravelMessage = {
      id: 'evt-other', senderPubkeyHex: ME, recipientPubkeyHex: '',
      plaintext: 'from my phone', timestamp: 1_000_500, direction: 'received',
    }
    const kept = addReceivedMessage(ME, stored, other)
    expect(kept).toHaveLength(2)
    expect(kept[0].direction).toBe('sent')
  })
})


describe('addReceivedMessage — self-echo across send time and arrival', () => {
  // Before send-time display, an inbound row's `timestamp` was our DECRYPT time, so the window below
  // compared our send clock against our sign-in clock: an echo that queued while we were signed out
  // fell far outside it and landed as a duplicate 'from another device' row. Both sides of the
  // comparison are now the SENDER's clock, which is what makes these cases hold.
  //
  // The suppressor is keyed on `timestamp`, and must stay that way whatever the sort basis is doing:
  // send time is the only value a local row and its echo SHARE. Arrival is not — the local row is
  // stamped when we sent, the echo whenever it happens to find its way back.

  const SENT_AT = 1_700_000_000_700    // 12:04:00.700 — our clock when we pressed send
  const SIGN_IN = 1_700_002_400_000    // 12:44 — 40 minutes later, when the backfill decrypts

  // The local 'sent' row exactly as sendMessage writes it: one instant in both fields.
  const localSend = msg({ id: 'evt-local', plaintext: 'hello', timestamp: SENT_AT, receivedAt: SENT_AT })

  // An inbound self-copy as the provider builds it: `timestamp` is the sender's claimed send time
  // (that sender being us, on some device), `receivedAt` is when we actually decrypted it.
  function echo(over: Partial<CaravelMessage> = {}): CaravelMessage {
    return msg({
      id: 'evt-echo',
      senderPubkeyHex: ME,
      recipientPubkeyHex: '',        // unwrapMessage does not expose the rumor's p-tag
      plaintext: 'hello',
      timestamp: SENT_AT,
      receivedAt: SIGN_IN,
      direction: 'received',
      ...over,
    })
  }

  it('suppresses an echo claiming the exact instant of the local send', () => {
    const stored = addSentMessage(ME, [], localSend)
    const next = addReceivedMessage(ME, stored, echo())

    expect(next).toBe(stored)             // same reference — suppressed, so React skips the re-render
    expect(next).toHaveLength(1)
    // The surviving row keeps OUR send instant, not the moment the echo turned up 40 minutes later.
    expect(next[0].timestamp).toBe(SENT_AT)
  })

  it('suppresses an echo offset by whole-second rounding, in either direction', () => {
    // wrapMessage stamps Math.round(Date.now() / 1000), so an echo's claim is the local send rounded
    // to the NEAREST second — up to ~500ms away from it, and free to round either way.
    const stored = addSentMessage(ME, [], localSend)

    const rounded = Math.round(SENT_AT / 1000) * 1000    // 12:04:01.000, i.e. 300ms ahead of the send
    expect(rounded - SENT_AT).toBe(300)
    expect(addReceivedMessage(ME, stored, echo({ timestamp: rounded }))).toBe(stored)

    // The worst case each way, pinned explicitly so a narrower window would have to fail here.
    expect(addReceivedMessage(ME, stored, echo({ timestamp: SENT_AT + 500 }))).toBe(stored)
    expect(addReceivedMessage(ME, stored, echo({ timestamp: SENT_AT - 500 }))).toBe(stored)
  })

  it('keeps a genuine other-device message that merely shares an arrival time', () => {
    // Signing in after an offline stretch decrypts a whole backfill at once, so unrelated
    // self-authored messages land at the SAME arrival instant. Arrival therefore cannot be what
    // decides an echo.
    //
    // Same text as the desktop send, deliberately: content alone cannot tell these two apart, so the
    // send times are the only thing that can. A suppressor keyed on receivedAt would see two
    // identical-looking rows arriving together and silently swallow the phone's message.
    const stored = addSentMessage(ME, [], localSend)

    const PHONE_SENT_AT = SENT_AT + 26 * 60 * 1000       // sent from my phone, well past the window
    const fromPhone = echo({ id: 'evt-phone', timestamp: PHONE_SENT_AT })

    expect(fromPhone.receivedAt).toBe(echo().receivedAt) // the shared arrival instant...
    expect(addReceivedMessage(ME, stored, echo())).toBe(stored)   // ...yet only the echo is suppressed

    const kept = addReceivedMessage(ME, stored, fromPhone)
    expect(kept).toHaveLength(2)
    const row = kept[0]
    expect(row.id).toBe('evt-phone')
    expect(row.direction).toBe('sent')          // flipped, so it renders on our own side
    expect(row.timestamp).toBe(PHONE_SENT_AT)   // labelled with the phone's send time...
    expect(sortKey(row)).toBe(PHONE_SENT_AT)    // ...and ordered by it, so the two cannot disagree
    expect(row.receivedAt).toBe(SIGN_IN)        // arrival is kept, but only as compareMessages' tiebreak
  })
})

describe('nextRevision (M2)', () => {
  it('is 1 for a never-edited message and one past the applied revision otherwise', () => {
    expect(nextRevision([msg({ logicalId: 'L1' })], 'L1')).toBe(1)
    expect(nextRevision([msg({ logicalId: 'L1', revision: 3 })], 'L1')).toBe(4)
  })

  it('is 1 for an unknown logicalId — the caller checks existence before sending', () => {
    expect(nextRevision([msg({ logicalId: 'L1' })], 'nope')).toBe(1)
  })

  it('recomputes the SAME number after a failed send, so a retry cannot drift', () => {
    const current = [msg({ logicalId: 'L1' })]
    expect(nextRevision(current, 'L1')).toBe(1)
    expect(nextRevision(current, 'L1')).toBe(1)   // send failed, nothing applied, retry
  })
})

describe('applyEditByLogicalId (M2)', () => {
  it('resolves the logical id and applies the edit', () => {
    const current = [msg({ logicalId: 'L1' })]
    const next = applyEditByLogicalId(ME, current, 'L1', 'edited', 1, ME)

    expect(next[0].plaintext).toBe('edited')
    expect(next[0].revision).toBe(1)
    expect(next[0].logicalId).toBe('L1')
  })

  it('no-ops on an unknown or empty logical id — this is also the tombstoned/deleted case', () => {
    const current = [msg({ logicalId: 'L1' })]
    expect(applyEditByLogicalId(ME, current, 'unknown', 'x', 1, ME)).toBe(current)
    expect(applyEditByLogicalId(ME, current, '', 'x', 1, ME)).toBe(current)
    // deleted conversations remove the rows, so the target is simply absent
    const emptied: CaravelMessage[] = []
    expect(applyEditByLogicalId(ME, emptied, 'L1', 'x', 1, ME)).toBe(emptied)
  })

  it('does not weaken any guard it delegates to', () => {
    // Authorship: the forgery case, now arriving over the wire by logical id.
    const peerMsg = [msg({ logicalId: 'L1', senderPubkeyHex: PEER, direction: 'received' })]
    expect(applyEditByLogicalId(ME, peerMsg, 'L1', 'hijacked', 1, ME)).toBe(peerMsg)

    // Stale revision.
    const edited = [msg({ logicalId: 'L1', revision: 2, plaintext: 'v2' })]
    expect(applyEditByLogicalId(ME, edited, 'L1', 'old', 1, ME)).toBe(edited)

    // System row.
    const notice = [msg({ logicalId: 'L1', system: 'group-leave', plaintext: '', groupId: 'g1' })]
    expect(applyEditByLogicalId(ME, notice, 'L1', 'x', 1, ME)).toBe(notice)
  })

  it('leaves the message findable by logical id after editing, so a second edit lands', () => {
    const first = applyEditByLogicalId(ME, [msg({ logicalId: 'L1' })], 'L1', 'v1', 1, ME)
    const second = applyEditByLogicalId(ME, first, 'L1', 'v2', 2, ME)
    expect(second[0].plaintext).toBe('v2')
    expect(second[0].revision).toBe(2)
    expect(second[0].preEditPlaintext).toBe('original')
  })
})

// ── Group editing (M4) ────────────────────────────────────────────────────────

const MEMBER = 'c'.repeat(64)

// A group message as the SENDER stores it: synthetic grp- id (there are N gift-wrap ids, none of
// them shared), no single recipient, and the shared logicalId every member's copy also carries.
function groupSent(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return msg({ id: 'grp-1', recipientPubkeyHex: '', groupId: 'g1', logicalId: 'L1', ...over })
}

// The same logical message as a MEMBER stores it: a real gift-wrap id, sender = the author.
function groupReceived(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return msg({ id: 'evt-g1', senderPubkeyHex: PEER, recipientPubkeyHex: ME, direction: 'received', groupId: 'g1', logicalId: 'L1', ...over })
}

describe('applyEditByLogicalId — group rows (M4)', () => {
  it('applies to the sender\'s own group row, keyed on the shared logical id', () => {
    const current = [groupSent()]
    const next = applyEditByLogicalId(ME, current, 'L1', 'edited', 1, ME)

    expect(next[0].plaintext).toBe('edited')
    expect(next[0].revision).toBe(1)
    // The group routing fields survive — only the text changes.
    expect(next[0].groupId).toBe('g1')
    expect(next[0].id).toBe('grp-1')
    expect(next[0].timestamp).toBe(1_000_000)
  })

  it('applies to a member\'s received copy when its AUTHOR sent the edit', () => {
    const current = [groupReceived()]
    const next = applyEditByLogicalId(ME, current, 'L1', 'edited', 1, PEER)
    expect(next[0].plaintext).toBe('edited')
  })

  it('REJECTS a member editing another member\'s group message', () => {
    // The attack group editing actually creates: every member legitimately learns the logicalId of
    // every group message, so MEMBER can address an edit at PEER's message. Rejected on every
    // device by the authorship guard — including on the author's own, where the stored sender is
    // themself and the editor is not.
    const asMember = [groupReceived()]                                   // I hold PEER's message
    expect(applyEditByLogicalId(ME, asMember, 'L1', 'hijacked', 1, MEMBER)).toBe(asMember)

    const asAuthor = [groupSent({ senderPubkeyHex: ME })]                 // PEER's own device
    expect(applyEditByLogicalId(ME, asAuthor, 'L1', 'hijacked', 1, MEMBER)).toBe(asAuthor)
  })

  it('no-ops for a RE-INVITED member who never stored the original — no phantom row', () => {
    // Phase C: messages sent while I was 'left' were never stored, so the group resumes fresh and an
    // edit can name a logicalId I have no row for. It must degrade to nothing at all.
    const afterReinvite = [groupSent({ id: 'grp-old', logicalId: 'L-old' })]
    const next = applyEditByLogicalId(ME, afterReinvite, 'L1', 'edit of a message I never had', 1, PEER)
    expect(next).toBe(afterReinvite)      // by reference — React skips the re-render
    expect(next).toHaveLength(1)          // nothing appended
  })

  it('is idempotent across a re-delivered fan-out — every member applies the same revision once', () => {
    const first = applyEditByLogicalId(ME, [groupReceived()], 'L1', 'edited', 1, PEER)
    // The same edit re-arrives (another relay, or the ~2-day backfill on the next unlock).
    expect(applyEditByLogicalId(ME, first, 'L1', 'edited', 1, PEER)).toBe(first)
  })
})

describe('editReachOk (M4)', () => {
  it('is ok when at least one member was reached', () => {
    expect(editReachOk(3, 1)).toBe(true)
    expect(editReachOk(3, 3)).toBe(true)
  })

  it('fails ONLY on total failure, which is what snaps the bubble back', () => {
    expect(editReachOk(3, 0)).toBe(false)
    expect(editReachOk(1, 0)).toBe(false)
  })

  it('is ok with an empty roster — nobody to reach is not a failure', () => {
    // A solo roster or a lazy placeholder with no members yet. Treating this as failure would make
    // such a group's messages permanently un-editable.
    expect(editReachOk(0, 0)).toBe(true)
  })
})

describe('targetsLeftGroup (M4)', () => {
  const LEFT = new Set(['g-left'])

  it('drops an edit whose target belongs to a group I have LEFT', () => {
    // Leave/decline are NON-destructive: the rows are kept and hidden by state, so without this gate
    // an edit would keep rewriting history inside a group that should never be touched again.
    const current = [groupSent({ groupId: 'g-left' })]
    expect(targetsLeftGroup(current, 'L1', LEFT)).toBe(true)
  })

  it('allows a live group, a pending group, and a DM', () => {
    expect(targetsLeftGroup([groupSent()], 'L1', LEFT)).toBe(false)
    // A pending (invite-gated) group stores its messages; an edit should land so the corrected text
    // is what you read on accept.
    expect(targetsLeftGroup([groupSent({ groupId: 'g-pending' })], 'L1', LEFT)).toBe(false)
    expect(targetsLeftGroup([msg({ logicalId: 'L1' })], 'L1', LEFT)).toBe(false)
  })

  it('allows an unknown or empty logical id — deletion already resolves to a store no-op', () => {
    expect(targetsLeftGroup([groupSent({ groupId: 'g-left' })], 'unknown', LEFT)).toBe(false)
    expect(targetsLeftGroup([groupSent({ groupId: 'g-left' })], '', LEFT)).toBe(false)
    expect(targetsLeftGroup([], 'L1', LEFT)).toBe(false)
  })

  it('allows everything when no group has been left', () => {
    expect(targetsLeftGroup([groupSent({ groupId: 'g-left' })], 'L1', new Set())).toBe(false)
  })
})

describe('nextRevision — group rows (M4)', () => {
  it('derives from the sender\'s own group row, so a retried fan-out cannot drift', () => {
    expect(nextRevision([groupSent()], 'L1')).toBe(1)
    expect(nextRevision([groupSent({ revision: 2 })], 'L1')).toBe(3)
  })
})

describe('findByLogicalId — resolving a reply\'s target (replies v1)', () => {
  const rows = [
    msg({ id: 'e1', logicalId: 'aaa', plaintext: 'first' }),
    msg({ id: 'e2', logicalId: 'bbb', plaintext: 'second' }),
    msg({ id: 'e3', plaintext: 'pre-M2, no logical id' }),
  ]

  it('finds the row carrying the logical id', () => {
    expect(findByLogicalId(rows, 'bbb')?.plaintext).toBe('second')
  })

  it('returns undefined for an unknown id — the "original unavailable" case', () => {
    // Not an error: a reply whose target we never received, or have since deleted, is normal.
    expect(findByLogicalId(rows, 'zzz')).toBeUndefined()
  })

  it('returns undefined for an empty or absent id rather than matching a row without one', () => {
    // The guard matters: without it, `undefined === undefined` would match the pre-M2 row above.
    expect(findByLogicalId(rows, undefined)).toBeUndefined()
    expect(findByLogicalId(rows, '')).toBeUndefined()
  })

  it('is a pure read — it does not persist anything', () => {
    findByLogicalId(rows, 'aaa')
    expect(loadMessages(ME)).toEqual([])
  })

  it('finds a group row by the id shared across the fan-out', () => {
    const group = [msg({ id: 'grp-1', groupId: 'g1', logicalId: 'shared', plaintext: 'to the group' })]
    expect(findByLogicalId(group, 'shared')?.plaintext).toBe('to the group')
  })
})


// ── Emoji reactions (reactions v1) ────────────────────────────────────────────
//
// The applier is the second mutation in this store, and unlike the edit path it accepts events from
// ANYONE. What keeps that safe is not a check but a shape: the row is keyed on (by, emoji) where
// `by` is the authenticated seal pubkey, so a reaction can only ever reach its own sender's row.
// These tests pin that, the seq ordering that makes replay harmless, and the two caps.

const OTHER = 'c'.repeat(64)

// A text row with a shared logical id — the only thing a reaction can name.
function reactable(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return msg({ logicalId: 'L1', ...over })
}

// Convenience: apply a chain of reactions and return the final array.
function react(rows: CaravelMessage[], by: string, emoji: string, action: 'add' | 'remove', seq: number) {
  return applyReactionByLogicalId(ME, rows, 'L1', emoji, action, seq, by)
}

function reactionsOf(rows: CaravelMessage[]) {
  return rows[0].reactions ?? []
}

function liveEmoji(rows: CaravelMessage[], by: string) {
  return reactionsOf(rows).filter(r => r.by === by && !r.removed).map(r => r.emoji)
}

describe('applyReactionByLogicalId — applying and removing', () => {
  it('adds a reaction and persists it', () => {
    const next = react([reactable()], PEER, '👍', 'add', 1)

    expect(reactionsOf(next)).toHaveLength(1)
    expect(reactionsOf(next)[0]).toMatchObject({ by: PEER, emoji: '👍', seq: 1 })
    expect(reactionsOf(next)[0].removed).toBeUndefined()   // absent, not false
    expect(loadMessages(ME)[0].reactions).toHaveLength(1)
  })

  it('returns a NEW array and a NEW row — the memo on array identity must see the change', () => {
    const before = [reactable()]
    const next = react(before, PEER, '👍', 'add', 1)
    expect(next).not.toBe(before)
    expect(next[0]).not.toBe(before[0])
    expect(before[0].reactions).toBeUndefined()            // the input row is untouched
  })

  it('TOMBSTONES on remove instead of deleting the row — the seq high-water must survive', () => {
    const added = react([reactable()], PEER, '👍', 'add', 1)
    const removed = react(added, PEER, '👍', 'remove', 2)

    // The row is still there, flagged — this is what nextReactionSeq reads.
    expect(reactionsOf(removed)).toHaveLength(1)
    expect(reactionsOf(removed)[0]).toMatchObject({ by: PEER, emoji: '👍', seq: 2, removed: true })
  })

  it('re-adds by clearing the tombstone rather than appending a second row', () => {
    let rows = react([reactable()], PEER, '👍', 'add', 1)
    rows = react(rows, PEER, '👍', 'remove', 2)
    rows = react(rows, PEER, '👍', 'add', 3)

    expect(reactionsOf(rows)).toHaveLength(1)
    expect(reactionsOf(rows)[0].removed).toBeUndefined()
    expect(reactionsOf(rows)[0].seq).toBe(3)
  })

  it('leaves the message itself completely intact', () => {
    const next = react([reactable({ plaintext: 'hi', timestamp: 1_000_000, revision: 2 })], PEER, '👍', 'add', 1)
    // Ordering, text and edit state are none of a reaction's business.
    expect(next[0].plaintext).toBe('hi')
    expect(next[0].timestamp).toBe(1_000_000)
    expect(next[0].revision).toBe(2)
    expect(next[0].editedAt).toBeUndefined()
  })
})

describe('applyReactionByLogicalId — seq ordering and replay', () => {
  it('ignores a repeat of the same seq (idempotent), by reference', () => {
    const once = react([reactable()], PEER, '👍', 'add', 1)
    const twice = react(once, PEER, '👍', 'add', 1)
    expect(twice).toBe(once)
  })

  it('ignores a seq BELOW the stored one', () => {
    const at3 = react([reactable()], PEER, '👍', 'add', 3)
    expect(react(at3, PEER, '👍', 'add', 2)).toBe(at3)
    expect(react(at3, PEER, '👍', 'remove', 1)).toBe(at3)
  })

  it('REPLAY: add(1) → remove(2) → replayed add(1) stays removed, seq 2, array identity unchanged', () => {
    // The case the whole tombstone design exists for. Relays re-serve everything inside their ~2-day
    // window on every unlock, and gift wraps fuzz created_at by up to 2 days, so a stale add
    // arriving AFTER the remove is ordinary, not exotic. If removal deleted the row, the stored seq
    // would be gone and this replay would resurrect a reaction the person took back.
    let rows = react([reactable()], PEER, '👍', 'add', 1)
    rows = react(rows, PEER, '👍', 'remove', 2)

    const replayed = react(rows, PEER, '👍', 'add', 1)

    expect(replayed).toBe(rows)                                        // rejected, no re-render
    expect(reactionsOf(replayed)).toHaveLength(1)
    expect(reactionsOf(replayed)[0]).toMatchObject({ seq: 2, removed: true })
    expect(loadMessages(ME)[0].reactions?.[0].removed).toBe(true)      // and nothing was persisted over it
  })

  it('rejects a seq that is not a positive safe integer', () => {
    const rows = [reactable()]
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(applyReactionByLogicalId(ME, rows, 'L1', '👍', 'add', bad, PEER), `seq ${bad}`).toBe(rows)
    }
  })
})

describe('applyReactionByLogicalId — who may react', () => {
  it('ANYONE-TO-ANYONE: a third party may react to a message between two others', () => {
    // The deliberate divergence from applyEdit, which refuses unless the sender authored the target.
    const next = react([reactable({ senderPubkeyHex: ME, recipientPubkeyHex: PEER })], OTHER, '👍', 'add', 1)
    expect(reactionsOf(next)[0].by).toBe(OTHER)
  })

  it('keys the row on the REACTOR, so one person can never touch another person\'s reaction', () => {
    // This is why removal is self-only by construction: PEER\'s "remove" addresses PEER\'s row, and
    // there is no way to express "remove OTHER\'s row" — the key comes from the authenticated seal.
    let rows = react([reactable()], OTHER, '👍', 'add', 1)
    rows = react(rows, PEER, '👍', 'remove', 5)      // PEER tries to unreact OTHER\'s 👍

    const byOther = reactionsOf(rows).find(r => r.by === OTHER)
    expect(byOther?.emoji).toBe('👍')
    expect(byOther?.removed).toBeUndefined()      // untouched — still live
    // PEER only ever tombstoned their OWN (absent) row.
    expect(reactionsOf(rows).find(r => r.by === PEER)).toMatchObject({ removed: true })
  })

  it('keeps each reactor\'s seq independent — B\'s first is not ordered against A\'s third', () => {
    let rows = react([reactable()], PEER, '👍', 'add', 3)
    rows = react(rows, OTHER, '👍', 'add', 1)        // lower seq, different reactor → accepted

    expect(liveEmoji(rows, PEER)).toEqual(['👍'])
    expect(liveEmoji(rows, OTHER)).toEqual(['👍'])
  })

  it('keeps each EMOJI independent for one reactor', () => {
    let rows = react([reactable()], PEER, '👍', 'add', 4)
    rows = react(rows, PEER, '❤️', 'add', 1)         // lower seq, different emoji → accepted

    expect(liveEmoji(rows, PEER).sort()).toEqual(['❤️', '👍'].sort())
  })
})

describe('applyReactionByLogicalId — the two caps', () => {
  it('MAX-2: a third live emoji from one person is tombstoned, not applied', () => {
    let rows = react([reactable()], PEER, '👍', 'add', 1)
    rows = react(rows, PEER, '❤️', 'add', 1)
    rows = react(rows, PEER, '😂', 'add', 1)

    expect(liveEmoji(rows, PEER).sort()).toEqual(['❤️', '👍'].sort())
    // Stored as a tombstone rather than dropped, so its seq is recorded (F2): a later legitimate
    // remove/re-add of that pair still orders correctly instead of starting from nothing.
    expect(reactionsOf(rows).find(r => r.emoji === '😂')).toMatchObject({ by: PEER, seq: 1, removed: true })
  })

  it('MAX-2 is per person, not per message', () => {
    let rows = react([reactable()], PEER, '👍', 'add', 1)
    rows = react(rows, PEER, '❤️', 'add', 1)
    rows = react(rows, OTHER, '😂', 'add', 1)       // a different reactor has their own allowance

    expect(liveEmoji(rows, OTHER)).toEqual(['😂'])
  })

  it('MAX-2 does not block a seq bump on an emoji already held', () => {
    let rows = react([reactable()], PEER, '👍', 'add', 1)
    rows = react(rows, PEER, '❤️', 'add', 1)
    rows = react(rows, PEER, '👍', 'add', 2)        // re-add of one I hold: costs no new slot

    expect(liveEmoji(rows, PEER).sort()).toEqual(['❤️', '👍'].sort())
    expect(reactionsOf(rows).find(r => r.emoji === '👍')?.seq).toBe(2)
  })

  it('MAX-2 frees a slot once a reaction is removed', () => {
    let rows = react([reactable()], PEER, '👍', 'add', 1)
    rows = react(rows, PEER, '❤️', 'add', 1)
    rows = react(rows, PEER, '👍', 'remove', 2)
    rows = react(rows, PEER, '😂', 'add', 2)

    expect(liveEmoji(rows, PEER).sort()).toEqual(['❤️', '😂'].sort())
  })

  it('never caps a remove — it can only free a slot', () => {
    let rows = react([reactable()], PEER, '👍', 'add', 1)
    rows = react(rows, PEER, '❤️', 'add', 1)
    rows = react(rows, PEER, '😂', 'remove', 1)     // removing one I never had

    expect(reactionsOf(rows).find(r => r.emoji === '😂')).toMatchObject({ removed: true })
    expect(liveEmoji(rows, PEER)).toHaveLength(2)
  })

  it('PER-MESSAGE CAP: refuses a new pair past 64 rows, tombstones included', () => {
    // Removed rows are never deleted, so without this cap a peer could cycle through hundreds of
    // distinct emoji and permanently inflate one row in localStorage.
    const many = Array.from({ length: 64 }, (_, i) => ({ by: PEER, emoji: `e${i}`, seq: 1, at: 1, removed: true }))
    const rows = [reactable({ reactions: many })]

    const next = react(rows, OTHER, '👍', 'add', 1)
    expect(next).toBe(rows)                                  // rejected, by reference
  })

  it('PER-MESSAGE CAP: still allows updating a pair that is already stored', () => {
    // The cap bites on GROWTH only. Refusing updates too would freeze a full message\'s existing
    // reactions — nobody could take theirs back.
    const many = Array.from({ length: 63 }, (_, i) => ({ by: OTHER, emoji: `e${i}`, seq: 1, at: 1, removed: true }))
    many.push({ by: PEER, emoji: '👍', seq: 1, at: 1, removed: false })
    const rows = [reactable({ reactions: many })]

    const next = react(rows, PEER, '👍', 'remove', 2)
    expect(next).not.toBe(rows)
    expect(next[0].reactions).toHaveLength(64)
    expect(next[0].reactions?.find(r => r.emoji === '👍')).toMatchObject({ seq: 2, removed: true })
  })
})

describe('applyReactionByLogicalId — what it refuses outright', () => {
  it('no-ops on an unknown or empty logical id, by reference', () => {
    const rows = [reactable()]
    expect(applyReactionByLogicalId(ME, rows, 'nope', '👍', 'add', 1, PEER)).toBe(rows)
    expect(applyReactionByLogicalId(ME, rows, '', '👍', 'add', 1, PEER)).toBe(rows)
    expect(applyReactionByLogicalId(ME, [], 'L1', '👍', 'add', 1, PEER)).toEqual([])
  })

  it('refuses a NON-TEXT target — payment, media and system rows', () => {
    // Neither card has anywhere to draw a pill, so a stored reaction on one would be invisible
    // forever: quiet localStorage growth a peer on a richer client could produce by accident.
    for (const over of [
      { payment: { utxoId: 'utxo_1' } },
      { media: { url: 'u', key: 'k', nonce: 'n', mime: 'image/webp', x: 'x', ox: 'o', width: 1, height: 1, size: 1 } },
      { system: 'group-leave' as const, plaintext: '' },
    ]) {
      const rows = [reactable(over)]
      expect(applyReactionByLogicalId(ME, rows, 'L1', '👍', 'add', 1, PEER), JSON.stringify(Object.keys(over))).toBe(rows)
    }
  })

  it('refuses a blank emoji or a blank reactor', () => {
    const rows = [reactable()]
    expect(applyReactionByLogicalId(ME, rows, 'L1', '', 'add', 1, PEER)).toBe(rows)
    expect(applyReactionByLogicalId(ME, rows, 'L1', '👍', 'add', 1, '')).toBe(rows)
  })
})

describe('isReactableTarget / liveReactionCountBy', () => {
  it('accepts a text row and refuses payment, media and system rows', () => {
    expect(isReactableTarget(msg())).toBe(true)
    expect(isReactableTarget(msg({ payment: { utxoId: 'u' } }))).toBe(false)
    expect(isReactableTarget(msg({ system: 'group-leave', plaintext: '' }))).toBe(false)
  })

  it('counts LIVE reactions only, per person', () => {
    const row = msg({ reactions: [
      { by: PEER, emoji: '👍', seq: 1, at: 1 },
      { by: PEER, emoji: '❤️', seq: 2, at: 1, removed: true },
      { by: OTHER, emoji: '😂', seq: 1, at: 1 },
    ] })
    expect(liveReactionCountBy(row, PEER)).toBe(1)
    expect(liveReactionCountBy(row, OTHER)).toBe(1)
    expect(liveReactionCountBy(msg(), PEER)).toBe(0)
  })
})

describe('nextReactionSeq', () => {
  it('starts at 1 for a pair never reacted with', () => {
    expect(nextReactionSeq([reactable()], 'L1', ME, '👍')).toBe(1)
    expect(nextReactionSeq([], 'L1', ME, '👍')).toBe(1)
    expect(nextReactionSeq([reactable()], 'unknown', ME, '👍')).toBe(1)
  })

  it('reads the high-water for THAT pair only', () => {
    const rows = [reactable({ reactions: [
      { by: ME, emoji: '👍', seq: 4, at: 1 },
      { by: PEER, emoji: '👍', seq: 9, at: 1 },
    ] })]
    expect(nextReactionSeq(rows, 'L1', ME, '👍')).toBe(5)
    expect(nextReactionSeq(rows, 'L1', ME, '❤️')).toBe(1)     // a different emoji is a different pair
  })

  it('counts a TOMBSTONED row — this is why removal keeps it', () => {
    let rows = react([reactable()], ME, '👍', 'add', 1)
    rows = react(rows, ME, '👍', 'remove', 2)
    // If removal deleted the row this would answer 1, every peer still holding seq 2 would reject
    // the re-add, and the reaction would be silently un-re-addable forever.
    expect(nextReactionSeq(rows, 'L1', ME, '👍')).toBe(3)
  })

  it('is STABLE across a retry — a send that failed recomputes the same number', () => {
    const rows = [reactable()]
    expect(nextReactionSeq(rows, 'L1', ME, '👍')).toBe(1)
    expect(nextReactionSeq(rows, 'L1', ME, '👍')).toBe(1)      // send failed, nothing applied, retry
  })
})

describe('reactions on group rows', () => {
  it('applies to the row carrying the shared logical id, from any member', () => {
    const rows = [msg({ id: 'grp-1', groupId: 'g1', logicalId: 'L1', recipientPubkeyHex: '' })]
    const next = react(rows, OTHER, '👍', 'add', 1)

    expect(next[0].groupId).toBe('g1')
    expect(reactionsOf(next)[0].by).toBe(OTHER)
  })
})

describe('existing behaviour is unchanged', () => {
  it('still dedups by id and still keeps a peer message', () => {
    const first = addReceivedMessage(ME, [], msg({ id: 'e1', senderPubkeyHex: PEER, direction: 'received' }))
    expect(first).toHaveLength(1)

    // same id → first-write-wins
    const again = addReceivedMessage(ME, first, msg({ id: 'e1', senderPubkeyHex: PEER, direction: 'received', plaintext: 'different' }))
    expect(again).toBe(first)
    expect(again[0].plaintext).toBe('original')
  })
})


// ── At rest (stage 3) ─────────────────────────────────────────────────────────

describe('messages: encryption at rest', () => {
  const MSG_KEY = 'caravel.messages.v1.' + ME

  it('writes ciphertext, not readable JSON', () => {
    addSentMessage(ME, [], msg({ plaintext: 'meet me at the harbour' }))
    const stored = localStorage.getItem(MSG_KEY)!
    expect(stored).not.toContain('meet me at the harbour')
    expect(JSON.parse(stored).v).toBe(2)
  })

  it('hides a chat payment amount and an attachment key', () => {
    // The two fields that make this store tier-1: an amount the wire cannot carry, and the AES key
    // for an image attachment.
    addSentMessage(ME, [], msg({
      plaintext: 'for lunch',
      localPayment: { amountMicrotari: '1500000', txId: 'txabc' },
    }))
    const stored = localStorage.getItem(MSG_KEY)!
    expect(stored).not.toContain('1500000')
    expect(stored).not.toContain('txabc')
  })

  it('reads back everything it sealed', () => {
    const sent = msg({ id: 'a', plaintext: 'one' })
    addSentMessage(ME, addSentMessage(ME, [], sent), msg({ id: 'b', plaintext: 'two' }))
    const loaded = loadMessages(ME)
    expect(loaded.map(m => m.plaintext).sort()).toEqual(['one', 'two'])
  })

  it('cannot be read with a different key, or with none', () => {
    addSentMessage(ME, [], msg())
    setStoreKey(new Uint8Array(32).fill(7))
    expect(loadMessages(ME)).toEqual([])
    clearStoreKey()
    expect(loadMessages(ME)).toEqual([])
  })
})

describe('messages: migration from plaintext', () => {
  const MSG_KEY = 'caravel.messages.v1.' + ME

  function seedLegacy() {
    localStorage.setItem(MSG_KEY, JSON.stringify([
      { id: 'legacy-1', senderPubkeyHex: PEER, recipientPubkeyHex: ME, plaintext: 'older message', timestamp: 900, direction: 'received' },
    ]))
  }

  it('reads a plaintext store written before encryption existed', () => {
    seedLegacy()
    const [m] = loadMessages(ME)
    expect(m.id).toBe('legacy-1')
    expect(m.plaintext).toBe('older message')
  })

  it('re-emits the whole store SEALED on the next write, losing nothing', () => {
    seedLegacy()
    expect(Array.isArray(JSON.parse(localStorage.getItem(MSG_KEY)!))).toBe(true)

    addReceivedMessage(ME, loadMessages(ME), msg({ id: 'new-1', plaintext: 'newer', direction: 'received', senderPubkeyHex: PEER, recipientPubkeyHex: ME }))

    expect(JSON.parse(localStorage.getItem(MSG_KEY)!).v).toBe(2)
    const ids = loadMessages(ME).map(m => m.id).sort()
    expect(ids).toEqual(['legacy-1', 'new-1'])
    expect(loadMessages(ME).find(m => m.id === 'legacy-1')!.plaintext).toBe('older message')
  })
})

describe('messages: refusing to write', () => {
  const MSG_KEY = 'caravel.messages.v1.' + ME

  it('will not write with no store key', () => {
    clearStoreKey()
    addSentMessage(ME, [], msg())
    expect(localStorage.getItem(MSG_KEY)).toBeNull()
  })

  it('NEVER OVERWRITES A HISTORY IT COULD NOT READ', () => {
    addSentMessage(ME, [], msg({ id: 'keep', plaintext: 'the history that must survive' }))
    const original = localStorage.getItem(MSG_KEY)!

    setStoreKey(new Uint8Array(32).fill(7))       // wrong key
    expect(loadMessages(ME)).toEqual([])           // reads empty...

    addReceivedMessage(ME, [], msg({ id: 'new', direction: 'received' }))
    expect(localStorage.getItem(MSG_KEY)).toBe(original)   // ...and did not clobber

    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadMessages(ME)[0].plaintext).toBe('the history that must survive')
  })

  it('will not let a DELETE clobber an unreadable history either', () => {
    addSentMessage(ME, [], msg({ id: 'keep' }))
    const original = localStorage.getItem(MSG_KEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    deletePeerMessages(ME, [msg({ id: 'keep' })], PEER)
    expect(localStorage.getItem(MSG_KEY)).toBe(original)
  })

  it('still writes normally over an EMPTY store', () => {
    expect(localStorage.getItem(MSG_KEY)).toBeNull()
    addSentMessage(ME, [], msg())
    expect(loadMessages(ME)).toHaveLength(1)
  })
})
