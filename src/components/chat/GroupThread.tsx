//   Phase 1 group thread — a sibling of the DM view, built on the shared Stage 1 primitives
//   (Avatar, MessageBubble, chatDisplay). The ONLY group-specific differences vs a DM thread:
//   a group-glyph avatar + "N members" subtitle in the header, and a per-sender identity
//   (avatar + label, grouped by run) on received bubbles. No logic changes; no payments.
//   Fan-out / routing / gate are unchanged from the committed behavior.
//
//   B-M1: the ⋯ menu's exit action is LEAVE (was Delete) — two-step, confirmed inline in the menu.
//   Leave is local-only here; the outbound "X has left the chat" notice is B-M2.

import { useRef, useState } from 'react'
import type { CaravelMessage, Group } from '../../messaging/types'
import Avatar from './Avatar'
import MessageBubble from './MessageBubble'
import MediaMessageCard from './MediaMessageCard'
import { mergeThreadItems, threadContentKey, MONO } from './chatDisplay'
import { groupGlyph } from './groupGlyph'
import { useScrollToBottom } from './useScrollToBottom'
import PendingBubble, { type PendingSend } from './PendingBubble'

// A group with no real name yet (a lazy placeholder learned from a message before its definition).
function groupTitle(g: Group): string {
  return g.name?.trim() ? g.name : `Group ${g.id.slice(0, 6)}…`
}

export default function GroupThread({
  group, messages, pending, nameFor, onSend, onRetryPending, onDismissPending, onLeave, onReinvite, sendNote, onPickImage,
}: {
  group: Group
  messages: CaravelMessage[]        // this group's messages, oldest-first
  pending: PendingSend[]            // provisional sends for THIS group (already filtered)
  nameFor: (hex: string) => string  // sender display name (nickname ?? truncated npub)
  onSend: (text: string) => Promise<void>
  onRetryPending: (id: string) => void
  // Clears a failed provisional bubble — the only way out of a terminal failure, which shows no Retry.
  onDismissPending: (id: string) => void
  onLeave: () => void
  onReinvite: () => void   // opens the member picker (C-M2); does not send on its own
  // Honest partial-fan-out note for the composer footer, or null. Never claims delivery.
  sendNote: { reached: number; total: number } | null
  // ⚠️ TEMPORARY TEST HARNESS (images M4) — DELETE IN M5, along with this prop. ChatApp owns the
  // provider, so the picked file goes back up to it; see handlePickedImage there for why this exists
  // and what a real attach flow still needs.
  onPickImage: (file: File | undefined) => void
}) {
  const [draft, setDraft] = useState('')
  // ⚠️ TEMPORARY TEST HARNESS (images M4) — DELETE IN M5.
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const [sending, setSending] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Two-step leave (B-M1): the ⋯ item swaps the menu panel to an inline confirm rather than opening
  // a modal. Leave hides a history the user has been reading and is irreversible until Phase C, so
  // it is guarded — Delete never was, but Delete was the weaker "forget until re-invited".
  const [confirmLeave, setConfirmLeave] = useState(false)
  const canSend = draft.trim().length > 0 && !sending
  // A roster of just me (or a placeholder with no roster yet) has nobody to re-invite.
  const canReinvite = group.members.length > 1
  // Same auto-scroll as the DM thread, from the shared hook. Keyed on group.id because this
  // component is reused (not remounted) when switching groups; the content key covers send and
  // receive alike, including system notices, which are new rows at the bottom like any other.
  // Pending sends are in the key so the provisional bubble is scrolled into view the instant it
  // appears — and so the swap to the real row re-fires, which a bare count never did.
  const bottomRef = useScrollToBottom(group.id, threadContentKey(messages, pending))

  // Any dismissal drops the confirm step too, so re-opening the menu always starts at step one.
  function closeMenu() { setMenuOpen(false); setConfirmLeave(false) }

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onSend(text)
      setDraft('')   // success only — a failed send keeps the text, as the failed bubble promises
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
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
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, border: '1px solid rgba(var(--border-rgb),0.16)', background: menuOpen ? 'rgba(var(--border-rgb),0.1)' : 'transparent', cursor: 'pointer', padding: 0 }}
          >
            <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round"><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} /><circle cx={5} cy={12} r={1.6} /></svg>
          </button>
          {menuOpen && (
            <>
              <div onClick={closeMenu} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={{ position: 'absolute', top: 42, right: 0, zIndex: 41, minWidth: confirmLeave ? 244 : 200, padding: 6, borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.18)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
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
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 9, borderRadius: 9, border: '1px solid rgba(var(--border-rgb),0.2)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
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
      <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            return <MediaMessageCard key={m.id} message={m} />
          }
          if (m.direction === 'sent') {
            return <MessageBubble key={m.id} text={m.plaintext} timestamp={m.timestamp} variant="sent" />
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
          return (
            <MessageBubble
              key={m.id}
              text={m.plaintext}
              timestamp={m.timestamp}
              variant="received"
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
      <div style={{ padding: '16px 24px 20px', borderTop: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          {/* ⚠️ TEMPORARY TEST HARNESS (images M4) — DELETE IN M5, with the onPickImage prop. */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => { onPickImage(e.target.files?.[0]); if (imageInputRef.current) imageInputRef.current.value = '' }}
          />
          <button
            onClick={() => imageInputRef.current?.click()}
            title="Attach image (temporary test harness)"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, flexShrink: 0, borderRadius: 12, border: '1px solid rgba(var(--border-rgb),0.16)', background: 'var(--surface-inset)', cursor: 'pointer', padding: 0 }}
          >
            <svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={3} width={18} height={18} rx={2} /><circle cx={8.5} cy={8.5} r={1.5} /><path d="M21 15l-5-5L5 21" /></svg>
          </button>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '13px 17px', borderRadius: 13, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)' }}>
            <textarea
              className="cv-composer"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              placeholder="Message the group…"
              rows={1}
              maxLength={2000}
              disabled={sending}
              style={{ flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 15, fontFamily: 'inherit', lineHeight: 1.4, maxHeight: 120, overflowY: 'auto', padding: 0, display: 'block' }}
            />
          </div>
          <button onClick={() => void send()} disabled={!canSend} title="Send to group" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, flexShrink: 0, borderRadius: 12, background: 'var(--surface-inset)', border: '1px solid rgba(var(--border-rgb),0.16)', cursor: canSend ? 'pointer' : 'default', opacity: canSend ? 1 : 0.5, padding: 0 }}>
            {sending
              ? <span style={{ width: 20, height: 20, borderRadius: '50%', border: '2.5px solid rgba(var(--border-rgb),0.25)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />
              : <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={canSend ? 'var(--teal-500)' : 'var(--text-muted-dim)'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>}
          </button>
        </div>
        {/* Footer: the standing best-effort line, replaced after a PARTIAL fan-out by an honest
            tally. "Reached" is deliberate — membersReached counts relay acceptance, not receipt, so
            this must never read as "delivered". Ephemeral: cleared on the next send. */}
        {sendNote ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--warn-300)', marginTop: 8, marginLeft: 2 }}>
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
            Last message reached {sendNote.reached} of {sendNote.total} member(s)
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
