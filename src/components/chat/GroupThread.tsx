//   Phase 1 group thread — a sibling of the DM view, built on the shared Stage 1 primitives
//   (Avatar, MessageBubble, chatDisplay). The ONLY group-specific differences vs a DM thread:
//   a group-glyph avatar + "N members" subtitle in the header, and a per-sender identity
//   (avatar + label, grouped by run) on received bubbles. No logic changes; no payments; no
//   leave/join. Fan-out / routing / gate / delete are unchanged from the committed behavior.

import { useState } from 'react'
import type { CaravelMessage, Group } from '../../messaging/types'
import Avatar from './Avatar'
import MessageBubble from './MessageBubble'
import { MONO } from './chatDisplay'
import { groupGlyph } from './groupGlyph'

// A group with no real name yet (a lazy placeholder learned from a message before its definition).
function groupTitle(g: Group): string {
  return g.name?.trim() ? g.name : `Group ${g.id.slice(0, 6)}…`
}

export default function GroupThread({
  group, messages, nameFor, onSend, onDelete,
}: {
  group: Group
  messages: CaravelMessage[]        // this group's messages, oldest-first
  nameFor: (hex: string) => string  // sender display name (nickname ?? truncated npub)
  onSend: (text: string) => Promise<void>
  onDelete: () => void
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const canSend = draft.trim().length > 0 && !sending

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onSend(text)
      setDraft('')
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
            onClick={() => setMenuOpen(o => !o)}
            title="Group options"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, border: '1px solid rgba(var(--border-rgb),0.16)', background: menuOpen ? 'rgba(var(--border-rgb),0.1)' : 'transparent', cursor: 'pointer', padding: 0 }}
          >
            <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round"><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} /><circle cx={5} cy={12} r={1.6} /></svg>
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={{ position: 'absolute', top: 42, right: 0, zIndex: 41, minWidth: 200, padding: 6, borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.18)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
                <button
                  onClick={() => { setMenuOpen(false); onDelete() }}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 11px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--danger-300)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                >
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--danger-300)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                  Delete group
                </button>
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
        {messages.map((m, i) => {
          if (m.direction === 'sent') {
            return <MessageBubble key={m.id} text={m.plaintext} timestamp={m.timestamp} variant="sent" />
          }
          // Group consecutive same-sender received messages: avatar + label once per run.
          const prev = messages[i - 1]
          const firstOfRun = !prev || prev.direction !== 'received' || prev.senderPubkeyHex !== m.senderPubkeyHex
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
      </div>

      {/* Composer — DM compose treatment, minus the $ payment toggle (deferred). */}
      <div style={{ padding: '16px 24px 20px', borderTop: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
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
        <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 8, marginLeft: 2 }}>
          Sent to {Math.max(group.members.length - 1, 0)} member(s) · end-to-end encrypted · best-effort delivery
        </div>
      </div>
    </>
  )
}
