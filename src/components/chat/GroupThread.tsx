//   Phase 1 group thread — a sibling of the DM view, built on the shared Stage 1 primitives
//   (Avatar, MessageBubble, chatDisplay). The ONLY group-specific differences vs a DM thread:
//   a group-glyph avatar + "N members" subtitle in the header, and a per-sender identity
//   (avatar + label, grouped by run) on received bubbles. No logic changes; no payments.
//   Fan-out / routing / gate are unchanged from the committed behavior.
//
//   B-M1: the ⋯ menu's exit action is LEAVE (was Delete) — two-step, confirmed inline in the menu.
//   Leave is local-only here; the outbound "X has left the chat" notice is B-M2.
//
//   EDIT M4: this thread now offers the DM's per-message edit — hover pencil on my own sent bubbles,
//   "edited" label on any edited bubble (mine or a member's), and the composer's fourth state. The
//   state is split deliberately: the optimistic FLIGHT map is ChatApp's (shared with the DM thread,
//   keyed by logicalId, must survive a thread switch), while which bubble is loaded into the
//   composer is local, because the composer itself is local.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CaravelMessage, Group } from '../../messaging/types'
import Avatar from './Avatar'
import MessageBubble from './MessageBubble'
import QuotedPreview from './QuotedPreview'
import { canBeginEdit, canBeginReply, canReplyTo, quotedAuthorLabel } from './replyCompose'
import { aggregateReactions, atReactionLimit, canReactTo, myReactions } from './reactionDisplay'
import MessageActionRow from './MessageActionRow'
import ReactionPills from './ReactionPills'
import ReactionQuickSet from './ReactionQuickSet'
import MediaMessageCard from './MediaMessageCard'
import { mergeThreadItems, threadContentKey, MONO } from './chatDisplay'
import { groupGlyph } from './groupGlyph'
import { useScrollToBottom } from './useScrollToBottom'
import { useJumpToMessage } from './useJumpToMessage'
import PendingBubble, { type PendingSend } from './PendingBubble'
import { canEditMessage, displayTextFor, flightFor, isEditSubmittable, type EditFlightMap } from './messageEdit'
import AttachPreview from './AttachPreview'
import EmojiPicker from './EmojiPicker'
import { insertAtCursor } from './composerInsert'

// A group with no real name yet (a lazy placeholder learned from a message before its definition).
function groupTitle(g: Group): string {
  return g.name?.trim() ? g.name : `Group ${g.id.slice(0, 6)}…`
}

export default function GroupThread({
  group, messages, pending, nameFor, onSend, onRetryPending, onDismissPending, onLeave, onReinvite, sendNote, onSendImage, imageStageLabel,
  editFlights, onSaveEdit, onRetryEdit, onDismissEdit, mePubkeyHex, onReact,
}: {
  group: Group
  messages: CaravelMessage[]        // this group's messages, oldest-first
  pending: PendingSend[]            // provisional sends for THIS group (already filtered)
  nameFor: (hex: string) => string  // sender display name (nickname ?? truncated npub)
  onSend: (text: string, replyTo?: string) => Promise<void>
  onRetryPending: (id: string) => void
  // Clears a failed provisional bubble — the only way out of a terminal failure, which shows no Retry.
  onDismissPending: (id: string) => void
  onLeave: () => void
  onReinvite: () => void   // opens the member picker (C-M2); does not send on its own
  // Honest partial-fan-out note for the composer footer, or null. Never claims delivery.
  // `kind` says whether the shortfall was the last MESSAGE or the last EDIT — both fan out the same
  // way, and both share this one slot (M4).
  sendNote: { kind: 'send' | 'edit'; reached: number; total: number } | null
  // ── Editing (M4) ──
  // The in-flight map is OWNED BY ChatApp and shared with the DM thread: it is keyed by logicalId,
  // so it must outlive this component's per-group state (switching threads mid-save must not lose
  // the flight). What lives here is only which bubble is loaded into THIS composer.
  editFlights: EditFlightMap
  onSaveEdit: (logicalId: string, text: string) => Promise<void>
  // MY Nostr pubkey — needed to tell my own reactions from a member's, which is what makes a pill
  // tappable-to-remove. Passed rather than read from context so this component stays presentational,
  // the same way nameFor and the edit callbacks are.
  mePubkeyHex: string
  // Publish one of my reactions (add or remove). ChatApp owns the provider, exactly as it owns the
  // edit and image sends; this resolves when the round trip settles, so the popover knows when to
  // stop dimming.
  onReact: (logicalId: string, emoji: string, action: 'add' | 'remove') => Promise<void>
  onRetryEdit: (logicalId: string) => void
  onDismissEdit: (logicalId: string) => void
  // ChatApp owns the messaging provider, so the CONFIRMED file (post-preview) goes back up to it to
  // be sent. Resolves when the send settles, so this composer can clear its preview.
  onSendImage: (file: File, caption: string | undefined) => Promise<void>
  // Which pipeline stage a running image send is in ("Preparing…" etc), or null. Owned by ChatApp,
  // which runs the send, so both composers show the identical progress wording.
  imageStageLabel: string | null
}) {
  const [draft, setDraft] = useState('')
  // ATTACH MODE (images M5) — this composer's fourth state, alongside draft/sending/menu. The picked
  // image waits here until Send; the textarea doubles as its caption field.
  const [attachment, setAttachment] = useState<File | null>(null)
  const [imageBusy, setImageBusy] = useState(false)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  // ── Emoji picker (B) ──
  // The textarea REF is new here. This composer never had one — it had no auto-grow and nothing
  // else needed to read the caret — so without it the picker could only ever append, while the DM
  // composer inserted at the cursor. Two composers that behave differently for the same button is
  // the asymmetry this closes (F8); everything below is deliberately identical to ChatApp's copy.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  // Where the caret goes after React commits an inserted draft. A CONTROLLED textarea drops the
  // caret at the end on every re-render, so without this an insert into the middle of a half-typed
  // message would silently become an append — see the fuller note in ChatApp.
  const pendingCaretRef = useRef<number | null>(null)
  const [sending, setSending] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // EDIT MODE (M4) — the group mirror of ChatApp's fourth composer state, minus the payment
  // interlocks this composer doesn't have. `stashedDraft` holds whatever was half-typed, restored
  // verbatim on cancel: starting an edit must never destroy an unsent message.
  const [editing, setEditing] = useState<{ logicalId: string; original: string } | null>(null)
  const [stashedDraft, setStashedDraft] = useState('')
  // REPLY MODE (replies v1) — the group mirror of the DM chip. Does NOT own the draft; interlocked
  // with edit through the shared predicates so the two composers cannot diverge on the rule.
  const [replying, setReplying] = useState<{ logicalId: string } | null>(null)
  // Two-step leave (B-M1): the ⋯ item swaps the menu panel to an inline confirm rather than opening
  // a modal. Leave hides a history the user has been reading and is irreversible until Phase C, so
  // it is guarded — Delete never was, but Delete was the weaker "forget until re-invited".
  const [confirmLeave, setConfirmLeave] = useState(false)
  const canSend = draft.trim().length > 0 && !sending
  // Save is live only when the text is both non-empty and actually different — an unchanged save
  // would burn a revision for nothing.
  const editSubmittable = !!editing && isEditSubmittable(editing.original, draft)
  // A roster of just me (or a placeholder with no roster yet) has nobody to re-invite.
  const canReinvite = group.members.length > 1
  // Same auto-scroll as the DM thread, from the shared hook. Keyed on group.id because this
  // component is reused (not remounted) when switching groups; the content key covers send and
  // receive alike, including system notices, which are new rows at the bottom like any other.
  // Pending sends are in the key so the provisional bubble is scrolled into view the instant it
  // appears — and so the swap to the real row re-fires, which a bare count never did.
  const bottomRef = useScrollToBottom(group.id, threadContentKey(messages, pending))

  // logicalId → message for this group's thread, built once per render pass (see QuotedPreview for
  // why a Map rather than a find() per rendered reply).
  const quotedIndex = useMemo(() => {
    const map = new Map<string, CaravelMessage>()
    for (const m of messages) if (m.logicalId) map.set(m.logicalId, m)
    return map
  }, [messages])

  // Who the pending reply quotes. Unlike the DM chip, a group names the MEMBER — with N participants
  // "Replying to a message" would not say which conversation you are answering.
  // Tap-to-jump (replies v1), keyed on group.id for the same reason useScrollToBottom is: this
  // component is REUSED across group switches, so a flash would otherwise outlive its thread.
  const { containerRef: threadRef, flashedId, jumpTo } = useJumpToMessage(group.id)

  const replyTarget = replying ? quotedIndex.get(replying.logicalId) : undefined
  // Same helper the rendered quote uses, so the chip and the bubble can never disagree about who
  // authored the quoted message. 'yourself' rather than the default 'You' purely for grammar: this
  // reads "Replying to yourself", while the quote's byline stands alone as "You".
  const replyChipLabel = !replyTarget ? 'a message' : quotedAuthorLabel(replyTarget, nameFor, 'yourself')

  // MANDATORY reset on group switch (images M5). This component is REUSED, not remounted, when the
  // selected group changes — the same reason useScrollToBottom is keyed on group.id — so without this
  // a picked photo would stay in the composer and Send would fan it out TO THE WRONG ROSTER. That is
  // a privacy failure, not a UI wrinkle, which is why it sits beside the group id rather than being
  // left to the component's lifecycle. Clearing `attachment` unmounts AttachPreview, which is also
  // what revokes its object URL.
  useEffect(() => { setAttachment(null) }, [group.id])

  // ── Emoji picker (B) — deliberately identical to ChatApp's copy ─────────────
  // Restore the caret AFTER the commit and BEFORE paint, or the controlled textarea leaves it at
  // the end and the insert reads as an append. useLayoutEffect (not useEffect) is what keeps the
  // jump from being visible.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    const el = composerRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(caret, caret)
  }, [draft])

  // 2000 is this composer's own limit, matching the textarea's maxLength below — which does NOT
  // gate a programmatic write, so the cap has to be passed in explicitly (F9).
  function insertEmoji(char: string) {
    const el = composerRef.current
    const { text, caret } = insertAtCursor(draft, el?.selectionStart, el?.selectionEnd, char, 2000)
    if (text === draft) return
    pendingCaretRef.current = caret
    setDraft(text)
  }

  // The picker is anchored to a composer that is about to hold another group's draft.
  useEffect(() => { setEmojiOpen(false) }, [group.id])

  // ── Reactions (C) — the group mirror of ChatApp's block, on the same contract ───
  const [reactOpen, setReactOpen] = useState<string | null>(null)
  const [reactPending, setReactPending] = useState<{ logicalId: string; emoji: string } | null>(null)
  // Anchored to a bubble that is about to unmount when the group changes.
  useEffect(() => { setReactOpen(null) }, [group.id])

  // Not optimistic, deliberately (F7): the store is written only once a relay accepts, so the
  // dimmed control IS the feedback and a failed reaction is silently absent rather than snapping
  // back. See ChatApp.toggleReaction, which this mirrors exactly.
  async function toggleReaction(logicalId: string, emoji: string, action: 'add' | 'remove') {
    if (reactPending) return
    setReactPending({ logicalId, emoji })
    try { await onReact(logicalId, emoji, action) }
    finally {
      setReactPending(null)
      setReactOpen(null)
    }
  }

  // The two bubble branches below build identical reaction props; only the bubble side differs.
  // Kept as one helper so the sent and received strips cannot drift apart.
  function reactionProps(m: CaravelMessage, outboardLeft: boolean) {
    const summaries = aggregateReactions(m, mePubkeyHex)
    const pendingEmoji = reactPending && reactPending.logicalId === m.logicalId ? reactPending.emoji : null
    const held = myReactions(m, mePubkeyHex)
    const side = outboardLeft ? 'left' as const : 'right' as const
    return {
      reactable: canReactTo(m),
      pills: summaries.length > 0 ? (
        <ReactionPills
          summaries={summaries}
          pending={pendingEmoji}
          // A group names WHO reacted — with N participants an untitled pill says only "someone".
          labelFor={hex => (hex === mePubkeyHex ? 'You' : nameFor(hex))}
          onToggle={(emoji, action) => void toggleReaction(m.logicalId!, emoji, action)}
        />
      ) : undefined,
      popover: reactOpen === m.logicalId ? (
        <ReactionQuickSet
          align={side}
          mine={held}
          blocked={atReactionLimit(m, mePubkeyHex)}
          pending={pendingEmoji}
          onPick={emoji => void toggleReaction(m.logicalId!, emoji, held.includes(emoji) ? 'remove' : 'add')}
          onClose={() => setReactOpen(null)}
        />
      ) : undefined,
      onReactClick: () => setReactOpen(o => (o === m.logicalId ? null : m.logicalId!)),
      open: reactOpen === m.logicalId,
      side,
    }
  }

  // Any dismissal drops the confirm step too, so re-opening the menu always starts at step one.
  function closeMenu() { setMenuOpen(false); setConfirmLeave(false) }

  // ── Editing (M4) ────────────────────────────────────────────────────────────

  // MANDATORY reset on thread switch. This component is REUSED, not remounted, when the selected
  // group changes (the same reason useScrollToBottom is keyed on group.id) — so without this, leaving
  // mid-edit would keep the composer bound to a logicalId belonging to another group's thread, and
  // Save would silently edit a message you can no longer see.
  useEffect(() => { setEditing(null); setStashedDraft(''); setReplying(null) }, [group.id])

  // Load a message into the composer. Refused while a send is in flight — both bind this textarea.
  function beginReply(logicalId: string) {
    if (!canBeginReply({ editing: !!editing, replying: !!replying })) return
    if (sending) return
    setReplying({ logicalId })
  }

  function cancelReply() {
    setReplying(null)
  }

  function beginEdit(logicalId: string, currentText: string) {
    // `|| attachment` for the same reason as the DM composer: attach mode uses this textarea as the
    // image's CAPTION field and edit mode uses it as the EDIT field, both bound to `draft`.
    if (sending || attachment) return
    // Symmetric interlock, identical to the DM composer's — see replyCompose.ts.
    if (!canBeginEdit({ editing: !!editing, replying: !!replying })) return
    setStashedDraft(editing ? stashedDraft : draft)   // don't clobber the stash when re-targeting
    setEditing({ logicalId, original: currentText })
    setDraft(currentText)
  }

  // Put the composer back exactly as the user left it.
  function cancelEdit() {
    if (!editing) return
    setEditing(null)
    setDraft(stashedDraft)
    setStashedDraft('')
  }

  // Hand off to ChatApp's shared publish path, which owns the optimistic flight and the partial-reach
  // note. The composer is released immediately — the fan-out can take seconds and the user should not
  // be held in edit mode waiting for it.
  async function saveEdit() {
    if (!editing) return
    const next = draft.trim()
    // Unchanged or empty is a cancel, not a send.
    if (!isEditSubmittable(editing.original, next)) { cancelEdit(); return }
    const { logicalId } = editing
    setEditing(null)
    setDraft(stashedDraft)
    setStashedDraft('')
    await onSaveEdit(logicalId, next)
  }

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onSend(text, replying?.logicalId)
      setDraft('')   // success only — a failed send keeps the text, as the failed bubble promises
      setReplying(null)   // same rule as the draft: the quote survives a failed send, with the text
    } catch {
      // Swallowed deliberately: onSend has already logged the cause and turned the provisional
      // bubble into a failed one with Retry, which is the user-facing surface. Without this catch
      // the rejection escaped through `void send()` as an unhandled promise rejection.
    } finally {
      setSending(false)
    }
  }

  const memberLine = group.members.length > 0 ? `${group.members.length} members` : 'roster pending…'

  return (
    <>
      {/* Header — DM header tokens: group-glyph avatar + name + "N members · group chat" + E2E line;
          delete lives behind the DM-style ⋯ menu button. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
          <Avatar icon={groupGlyph} size={42} radius={12} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{groupTitle(group)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint-dim)' }}>{memberLine} · group chat</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.2}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              <span style={{ fontSize: 12, color: 'var(--teal-300)', fontWeight: 500 }}>End to end encrypted</span>
            </div>
          </div>
        </div>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            title="Group options"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border)', background: menuOpen ? 'rgba(var(--border-rgb),0.1)' : 'transparent', cursor: 'pointer', padding: 0 }}
          >
            <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round"><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} /><circle cx={5} cy={12} r={1.6} /></svg>
          </button>
          {menuOpen && (
            <>
              <div onClick={closeMenu} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={{ position: 'absolute', top: 42, right: 0, zIndex: 41, minWidth: confirmLeave ? 244 : 200, padding: 6, borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--e3)' }}>
                {confirmLeave ? (
                  /* Step 2 — inline confirm, in the same panel. Cancel/Leave reuse the invite card's
                     neutral/decisive button tokens, danger-toned for the destructive side. */
                  <div style={{ padding: '5px 6px 6px' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>Leave this group?</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', lineHeight: 1.45, marginTop: 4, marginBottom: 11 }}>
                      You'll stop seeing new messages and this chat is hidden for good.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={closeMenu}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 9, borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => { closeMenu(); onLeave() }}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 9, borderRadius: 9, border: '1px solid rgba(var(--danger-rgb),0.3)', background: 'rgba(var(--danger-rgb),0.08)', color: 'var(--danger-300)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                      >
                        Leave
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Step 1 — the menu items. Invite again (neutral) above Leave (danger). */
                  <>
                    {/* Opens the C-M2 picker rather than sending immediately — the menu closes and
                        the modal owns the choice + confirm. Disabled for a group with no one else
                        in the roster, where there is nobody to invite. */}
                    <button
                      onClick={() => { closeMenu(); onReinvite() }}
                      disabled={!canReinvite}
                      title={canReinvite ? "Choose members to re-send this group's invite to" : 'No other members in this group'}
                      style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 11px', borderRadius: 8, border: 'none', background: 'transparent', color: canReinvite ? 'var(--text-body)' : 'var(--text-disabled)', fontSize: 14, fontWeight: 600, cursor: canReinvite ? 'pointer' : 'default', fontFamily: 'inherit', textAlign: 'left' }}
                    >
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={canReinvite ? 'var(--text-muted-dim)' : 'var(--text-disabled)'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6" /></svg>
                      Invite again
                    </button>
                    <button
                      onClick={() => setConfirmLeave(true)}
                      style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 11px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--danger-300)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                    >
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--danger-300)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                      Leave group
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Message list — DM container tokens; received bubbles carry a per-run sender identity. */}
      {/* data-popover-bounds — see the note on the DM thread's scroller in ChatApp. */}
      <div ref={threadRef} data-popover-bounds style={{ flex: 1, overflowY: 'auto', padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 300 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-body-dim)', marginBottom: 6 }}>This is the start of {groupTitle(group)}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>Messages are sent to every member, end to end encrypted.</div>
          </div>
        )}
        {/* Real messages and provisional bubbles in ONE chronological pass — see mergeThreadItems.
            A failed send used to be pinned below every later message, forever. */}
        {mergeThreadItems(messages, pending).map((item, i, items) => {
          if (item.kind === 'pending') {
            const p = item.pending
            return (
              <PendingBubble
                key={p.id}
                text={p.text}
                status={p.status}
                failure={p.failure}
                onRetry={() => onRetryPending(p.id)}
                onDismiss={() => onDismissPending(p.id)}
              />
            )
          }
          const m = item.message
          // System NOTICE (B-M2) — an inline centered line, never a bubble. Visual only: the roster
          // is unchanged, so the header still counts the leaver among the members (Phase 1 has no
          // roster edit). Text is composed here; the stored row carries empty plaintext.
          if (m.system === 'group-leave') {
            return (
              <div key={m.id} style={{ padding: '2px 0', textAlign: 'center', fontSize: 11.5, color: 'var(--text-faint-dim)' }}>
                {nameFor(m.senderPubkeyHex)} has left the chat
              </div>
            )
          }
          // An encrypted image (images M4). Same component and same resolver as the DM thread, on
          // both sides — a group image is fetched and decrypted per member, from one upload.
          if (m.media) {
            return <MediaMessageCard key={m.id} message={m} lid={m.logicalId} flashed={!!m.logicalId && flashedId === m.logicalId} />
          }
          if (m.direction === 'sent') {
            // My own group message: the same edit affordance the DM thread offers, on the same
            // predicate. `flight` is the optimistic layer — the bubble reads the new text while the
            // fan-out is outstanding and snaps back if it reached NOBODY.
            const flight = flightFor(m, editFlights)
            // My own sent bubble sits right, so its action row is outboard on the LEFT.
            const rx = reactionProps(m, true)
            return (
              <Fragment key={m.id}>
                <MessageBubble
                  text={displayTextFor(m, editFlights)}
                  timestamp={m.timestamp}
                  variant="sent"
                  edited={!!m.editedAt}
                  highlighted={!!m.logicalId && editing?.logicalId === m.logicalId}
                  lid={m.logicalId}
                  flashed={!!m.logicalId && flashedId === m.logicalId}
                  quoted={m.replyTo ? <QuotedPreview replyTo={m.replyTo} byLogicalId={quotedIndex} nameFor={nameFor} onJump={jumpTo} tone="on-accent" /> : undefined}
                  reactions={rx.pills}
                  actions={(canEditMessage(m) || canReplyTo(m) || rx.reactable) ? (
                    <MessageActionRow
                      menuAlign={rx.side}
                      onReact={rx.reactable ? rx.onReactClick : undefined}
                      reactOpen={rx.open}
                      reactPopover={rx.popover}
                      onReply={canReplyTo(m) ? () => beginReply(m.logicalId!) : undefined}
                      onEdit={canEditMessage(m) ? () => beginEdit(m.logicalId!, m.plaintext) : undefined}
                    />
                  ) : undefined}
                />
                {/* In-flight + failed states. "Saving" says only that the fan-out is running; a
                    PARTIAL result is a success here and is reported in the footer instead. */}
                {flight?.status === 'saving' && (
                  <div style={{ alignSelf: 'flex-end', display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: -2, marginRight: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.2)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />Saving edit
                  </div>
                )}
                {flight?.status === 'failed' && (
                  <div style={{ alignSelf: 'flex-end', display: 'flex', alignItems: 'center', gap: 10, marginTop: -2, marginRight: 4 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--danger-300)' }}>
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.4} strokeLinecap="round"><circle cx={12} cy={12} r={9} /><path d="M12 8v5M12 16h.01" /></svg>Couldn’t save edit
                    </span>
                    <span onClick={() => onRetryEdit(m.logicalId!)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', fontSize: 11, fontWeight: 700, color: 'var(--danger-300)', cursor: 'pointer' }}>Retry</span>
                    <span onClick={() => onDismissEdit(m.logicalId!)} style={{ fontSize: 11, color: 'var(--text-muted-dim)', cursor: 'pointer' }}>Dismiss</span>
                  </div>
                )}
              </Fragment>
            )
          }
          // Group consecutive same-sender received messages: avatar + label once per run. A system
          // line BREAKS the run — otherwise the sender header would be wrongly suppressed after an
          // interruption, since prev.senderPubkeyHex still matches across the notice.
          //
          // A PENDING bubble breaks it too, and deliberately: it is a genuine visual interruption,
          // exactly as one of my own sent bubbles already is. Resolving `prev` to undefined for a
          // pending item is what does it — simpler and more honest than scanning backwards past
          // provisional rows to find the last real message.
          const prevItem = items[i - 1]
          const prev = prevItem?.kind === 'message' ? prevItem.message : undefined
          const firstOfRun = !prev || prev.system !== undefined || prev.direction !== 'received' || prev.senderPubkeyHex !== m.senderPubkeyHex
          // A member's bubble sits left, so its action row is outboard on the RIGHT.
          const rx = reactionProps(m, false)
          return (
            <MessageBubble
              key={m.id}
              text={m.plaintext}
              timestamp={m.timestamp}
              variant="received"
              // A member's corrected message is labelled here exactly as in the DM thread — the
              // edit is only visible as an edit if the label travels with it. No EDIT affordance:
              // only the author can edit, and applyEdit enforces that on every device. Reply,
              // however, is not authorship-gated, so a received bubble now carries an action row.
              edited={!!m.editedAt}
              lid={m.logicalId}
              flashed={!!m.logicalId && flashedId === m.logicalId}
              quoted={m.replyTo ? <QuotedPreview replyTo={m.replyTo} byLogicalId={quotedIndex} nameFor={nameFor} onJump={jumpTo} /> : undefined}
              reactions={rx.pills}
              // No Edit on a member's message — only the author may, and applyEdit enforces that on
              // every device, so there is nothing for the overflow menu to hold and it is omitted.
              actions={(canReplyTo(m) || rx.reactable) ? (
                <MessageActionRow
                  menuAlign={rx.side}
                  onReact={rx.reactable ? rx.onReactClick : undefined}
                  reactOpen={rx.open}
                  reactPopover={rx.popover}
                  onReply={canReplyTo(m) ? () => beginReply(m.logicalId!) : undefined}
                />
              ) : undefined}
              senderHeader={firstOfRun
                ? { avatar: <Avatar hex={m.senderPubkeyHex} size={28} radius={9} fontSize={11} />, label: nameFor(m.senderPubkeyHex) }
                : 'continuation'}
            />
          )
        })}
        {/* Auto-scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Composer — DM compose treatment, minus the $ payment toggle (deferred). */}
      <div style={{ padding: '16px 24px 20px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>

        {/* Replying-to chip (replies v1), matching the DM composer: same slot, same visual language,
            same explicit Cancel. Names the MEMBER being answered, which a group needs and a DM does
            not. Does not own the draft — whatever was half-typed stays put. */}
        {replying && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10, padding: '9px 13px', borderRadius: 11, background: 'rgba(var(--teal-500-rgb),0.06)', border: '1px solid rgba(var(--teal-500-rgb),0.28)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--teal-300)' }}>
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M9 17l-5-5 5-5" /><path d="M4 12h11a5 5 0 0 1 5 5v2" /></svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Replying to {replyChipLabel}</span>
            </span>
            <span onClick={cancelReply} style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0 }}>Cancel</span>
          </div>
        )}

        {/* Editing banner (M4), matching the DM composer: names the state and offers the explicit
            way out. The bubble being edited is ringed in the thread, so the pairing is visible. */}
        {editing && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10, padding: '9px 13px', borderRadius: 11, background: 'rgba(var(--teal-500-rgb),0.06)', border: '1px solid rgba(var(--teal-500-rgb),0.28)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--teal-300)' }}>
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              Editing message
            </span>
            <span onClick={cancelEdit} style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}>Cancel</span>
          </div>
        )}

        {attachment && (
          <AttachPreview
            file={attachment}
            busy={imageBusy}
            stageLabel={imageStageLabel}
            onSend={() => {
              const file = attachment
              const caption = draft.trim()
              setImageBusy(true)
              void onSendImage(file, caption || undefined)
                .then(() => { setAttachment(null); setDraft('') })
                .finally(() => setImageBusy(false))
            }}
            onCancel={() => setAttachment(null)}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          {/* accept="image/*" and NEVER image/heic — see the DM composer for why. */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => { const picked = e.target.files?.[0]; if (picked) setAttachment(picked); e.target.value = '' }}
          />
          <button
            onClick={() => imageInputRef.current?.click()}
            disabled={imageBusy}
            title="Attach an image"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, flexShrink: 0, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-inset)', cursor: imageBusy ? 'default' : 'pointer', opacity: imageBusy ? 0.5 : 1, padding: 0 }}
          >
            <svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={3} width={18} height={18} rx={2} /><circle cx={8.5} cy={8.5} r={1.5} /><path d="M21 15l-5-5L5 21" /></svg>
          </button>
          {/* Emoji (B) — the DM composer's button, verbatim. `position: relative` anchors the panel. */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              onClick={() => setEmojiOpen(o => !o)}
              disabled={sending}
              title="Insert emoji"
              aria-label="Insert emoji"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, flexShrink: 0, borderRadius: 12, border: '1px solid var(--border)', background: emojiOpen ? 'rgba(var(--border-rgb),0.1)' : 'var(--surface-inset)', cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.5 : 1, padding: 0 }}
            >
              <svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><circle cx={12} cy={12} r={9} /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" /></svg>
            </button>
            {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '13px 17px', borderRadius: 13, background: 'var(--surface-raised)', border: '1px solid var(--border)' }}>
            <textarea
              ref={composerRef}
              className="cv-composer"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape' && editing) { e.preventDefault(); cancelEdit(); return }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (editing) void saveEdit(); else void send()
                }
              }}
                  placeholder={editing ? 'Edit your message…' : attachment ? 'Add a caption…' : 'Message the group…'}
              rows={1}
              maxLength={2000}
              disabled={sending}
              style={{ flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 15, fontFamily: 'inherit', lineHeight: 1.4, maxHeight: 120, overflowY: 'auto', padding: 0, display: 'block' }}
            />
          </div>
          {/* Send doubles as Save in edit mode — one button, one enabled rule per mode (M4). */}
          {(() => {
            const active = editing ? editSubmittable : canSend
            return (
              <button
                onClick={() => (editing ? void saveEdit() : void send())}
                disabled={!active}
                title={editing ? 'Save edit' : 'Send to group'}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, flexShrink: 0, borderRadius: 12, background: 'var(--surface-inset)', border: '1px solid var(--border)', cursor: active ? 'pointer' : 'default', opacity: active ? 1 : 0.5, padding: 0 }}
              >
                {sending && !editing
                  ? <span style={{ width: 20, height: 20, borderRadius: '50%', border: '2.5px solid rgba(var(--border-rgb),0.25)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />
                  : editing
                    ? <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--teal-500)' : 'var(--text-muted-dim)'} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                    : <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--teal-500)' : 'var(--text-muted-dim)'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>}
              </button>
            )
          })()}
        </div>
        {/* Footer: the standing best-effort line, replaced after a PARTIAL fan-out by an honest
            tally. "Reached" is deliberate — membersReached counts relay acceptance, not receipt, so
            this must never read as "delivered". Ephemeral: cleared on the next send.
            An EDIT (M4) reuses this line: a partial edit fan-out leaves some members reading the new
            text and some the old, with no way for anyone to tell — the sender at least sees that. */}
        {sendNote ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--warn-300)', marginTop: 8, marginLeft: 2 }}>
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
            Last {sendNote.kind === 'edit' ? 'edit' : 'message'} reached {sendNote.reached} of {sendNote.total} member(s)
          </div>
        ) : (
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 8, marginLeft: 2 }}>
            Sent to {Math.max(group.members.length - 1, 0)} member(s) · end-to-end encrypted · best-effort delivery
          </div>
        )}
      </div>
    </>
  )
}
