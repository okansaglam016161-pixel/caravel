//   Phase 1 group thread — minimal by design: a shared fan-out channel. Reuses the same visual
//   tokens as the DM thread, but a group has MANY senders, so received bubbles carry a sender label.
//   No payments, no nickname editor, no address exchange (all deferred). DM thread is untouched.

import { useState } from 'react'
import type { CaravelMessage, Group } from '../../messaging/types'

const MONO = "'IBM Plex Mono', monospace"

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
  const [confirmDelete, setConfirmDelete] = useState(false)
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

  return (
    <>
      {/* Header: group identity + member count + delete */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--teal-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx={9} cy={7} r={4} /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{groupTitle(group)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint-dim)' }}>
              {group.members.length > 0 ? `${group.members.length} members` : 'roster pending…'} · group chat
            </div>
          </div>
        </div>
        {confirmDelete ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setConfirmDelete(false)} style={{ padding: '7px 12px', borderRadius: 9, border: '1px solid rgba(var(--border-rgb),0.2)', background: 'transparent', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
            <button onClick={onDelete} style={{ padding: '7px 12px', borderRadius: 9, border: '1px solid rgba(var(--danger-rgb),0.3)', background: 'rgba(var(--danger-rgb),0.08)', color: 'var(--danger-300)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Delete group</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} title="Delete group (local)" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: '1px solid rgba(var(--border-rgb),0.16)', background: 'transparent', color: 'var(--text-muted-dim)', cursor: 'pointer' }}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
          </button>
        )}
      </div>

      {/* Message list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, lineHeight: 1.6, maxWidth: 300 }}>
            No messages yet. Say hello — it's sent to every member, end-to-end encrypted.
          </div>
        )}
        {messages.map(m => {
          const mine = m.direction === 'sent'
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
              {!mine && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-teal-dim)', marginBottom: 3, marginLeft: 4, fontFamily: MONO }}>{nameFor(m.senderPubkeyHex)}</span>}
              <div style={{ maxWidth: '72%', padding: '10px 14px', borderRadius: 14, fontSize: 15, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: mine ? 'var(--ink-on-accent)' : 'var(--text-body)', background: mine ? 'var(--teal-grad)' : 'var(--surface-raised)', border: mine ? 'none' : '1px solid rgba(var(--border-rgb),0.14)' }}>
                {m.plaintext}
              </div>
            </div>
          )
        })}
      </div>

      {/* Composer (text only — payments are hard-off in Phase 1 group compose) */}
      <div style={{ padding: '14px 24px 20px', borderTop: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '13px 17px', borderRadius: 13, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)' }}>
            <textarea
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
        <div style={{ fontSize: 11, color: 'var(--text-faint-dim)', marginTop: 8, marginLeft: 2 }}>Sent to {Math.max(group.members.length - 1, 0)} member(s), end-to-end encrypted. Delivery is best-effort.</div>
      </div>
    </>
  )
}
