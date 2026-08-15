// Unit tests for the message store's EDIT path (M1) — the first mutation in a store that is
// otherwise append-only / first-write-wins / dedup-by-id. applyEdit's guards are what keep that
// contract honest, and a bug here corrupts stored messages, so each guard is covered explicitly.

import { beforeEach, describe, expect, it } from 'vitest'
import { addReceivedMessage, addSentMessage, applyEdit, applyEditByLogicalId, editReachOk, editTargetsLeftGroup, loadMessages, nextRevision } from './messageStore'
import type { CaravelMessage } from './types'

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

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
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

describe('editTargetsLeftGroup (M4)', () => {
  const LEFT = new Set(['g-left'])

  it('drops an edit whose target belongs to a group I have LEFT', () => {
    // Leave/decline are NON-destructive: the rows are kept and hidden by state, so without this gate
    // an edit would keep rewriting history inside a group that should never be touched again.
    const current = [groupSent({ groupId: 'g-left' })]
    expect(editTargetsLeftGroup(current, 'L1', LEFT)).toBe(true)
  })

  it('allows a live group, a pending group, and a DM', () => {
    expect(editTargetsLeftGroup([groupSent()], 'L1', LEFT)).toBe(false)
    // A pending (invite-gated) group stores its messages; an edit should land so the corrected text
    // is what you read on accept.
    expect(editTargetsLeftGroup([groupSent({ groupId: 'g-pending' })], 'L1', LEFT)).toBe(false)
    expect(editTargetsLeftGroup([msg({ logicalId: 'L1' })], 'L1', LEFT)).toBe(false)
  })

  it('allows an unknown or empty logical id — deletion already resolves to a store no-op', () => {
    expect(editTargetsLeftGroup([groupSent({ groupId: 'g-left' })], 'unknown', LEFT)).toBe(false)
    expect(editTargetsLeftGroup([groupSent({ groupId: 'g-left' })], '', LEFT)).toBe(false)
    expect(editTargetsLeftGroup([], 'L1', LEFT)).toBe(false)
  })

  it('allows everything when no group has been left', () => {
    expect(editTargetsLeftGroup([groupSent({ groupId: 'g-left' })], 'L1', new Set())).toBe(false)
  })
})

describe('nextRevision — group rows (M4)', () => {
  it('derives from the sender\'s own group row, so a retried fan-out cannot drift', () => {
    expect(nextRevision([groupSent()], 'L1')).toBe(1)
    expect(nextRevision([groupSent({ revision: 2 })], 'L1')).toBe(3)
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
