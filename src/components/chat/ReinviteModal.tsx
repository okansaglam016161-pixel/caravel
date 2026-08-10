//   C-M2 re-invite picker: choose WHICH members of a group to re-send the invite to.
//
//   Deliberately a sibling of CreateGroupModal rather than a mode of it — same frame/row/checkbox
//   tokens, different subject (a fixed roster with per-member status vs a contact list plus a name
//   field). Merging them would put two flows that are already diverging behind one component.
//
//   The list is the FULL roster, always. `leftAt` is a HINT derived from received leave notices, and
//   it drives ordering, the subtitle and the initial selection — never who is reachable. A member
//   whose leave notice was lost (best-effort delivery) must still be selectable, and re-inviting a
//   member who never left is a genuine no-op on their side (first-def-wins), not an error.

import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import { groupGlyph } from './groupGlyph'
import { MONO } from './chatDisplay'

export interface ReinviteMemberOption {
  hex: string
  name: string           // nickname or truncated npub (resolved by the caller)
  leftAt: number | null  // ms epoch of the leave notice we believe is current, else null
}

function agoLabel(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function ReinviteModal({
  groupName, members, onConfirm, onClose,
}: {
  groupName: string
  members: ReinviteMemberOption[]   // full roster minus self, believed-left first
  onConfirm: (memberHexes: string[]) => void
  onClose: () => void
}) {
  // Pre-select whoever we believe has left — the common case is "bring back the person who left",
  // and a single-left-member group then needs one click. Never auto-send: the confirm step is the
  // point of C-M2, replacing C-M1's silent full-roster blast.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(members.filter(m => m.leftAt !== null).map(m => m.hex))
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const canSend = selected.size > 0
  function toggle(hex: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(hex)) next.delete(hex); else next.add(hex)
      return next
    })
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,14,0.78)', backdropFilter: 'blur(3px)', zIndex: 200 }} />
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(440px, 94vw)', maxHeight: '88vh', background: 'var(--surface)', borderRadius: 20, border: '1px solid rgba(var(--border-rgb),0.2)', boxShadow: '0 30px 90px rgba(0,0,0,0.65)', zIndex: 201, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <Avatar icon={groupGlyph} size={26} radius={8} />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Invite again</span>
          </div>
          <span onClick={onClose} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(var(--border-rgb),0.16)', cursor: 'pointer', flexShrink: 0 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 16 }}>
            Re-send the invite to <span style={{ color: 'var(--text-body)', fontWeight: 600 }}>{groupName}</span>. Members who are still in the group won't see anything.
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-faint-dim)', marginBottom: 10 }}>
            MEMBERS {selected.size > 0 && <span style={{ color: 'var(--text-teal-dim)' }}>· {selected.size} selected</span>}
          </div>

          {members.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.5, padding: '4px 0' }}>This group has no other members to invite.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {members.map(m => {
                const on = selected.has(m.hex)
                return (
                  <div key={m.hex} onClick={() => toggle(m.hex)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', borderRadius: 11, cursor: 'pointer', background: on ? 'rgba(var(--teal-500-rgb),0.08)' : 'var(--surface-raised)', border: `1px solid ${on ? 'rgba(var(--teal-500-rgb),0.3)' : 'rgba(var(--border-rgb),0.12)'}` }}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 6, flexShrink: 0, border: `1.5px solid ${on ? 'var(--teal-500)' : 'rgba(var(--border-rgb),0.3)'}`, background: on ? 'var(--teal-500)' : 'transparent' }}>
                      {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
                    </span>
                    <Avatar hex={m.hex} size={30} radius={10} fontSize={12} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, color: 'var(--text-body)', fontFamily: m.name.startsWith('npub') ? MONO : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                      <div style={{ fontSize: 11, color: m.leftAt !== null ? 'var(--text-muted)' : 'var(--text-faint-dim)', marginTop: 2 }}>
                        {m.leftAt !== null ? `Left the chat · ${agoLabel(m.leftAt)}` : 'In the group'}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ padding: 18, borderTop: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
          <div
            onClick={() => { if (canSend) { onConfirm([...selected]); onClose() } }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: canSend ? 'pointer' : 'default', background: canSend ? 'var(--teal-grad)' : 'rgba(16,21,31,0.6)', border: canSend ? 'none' : '1px solid rgba(var(--border-rgb),0.12)', color: canSend ? 'var(--ink-on-accent)' : 'var(--text-disabled)' }}
          >
            {canSend ? `Send invite to ${selected.size}` : 'Select members'}
          </div>
        </div>
      </div>
    </>
  )
}
