//   Phase 1 create-group modal: name + multi-select from existing contacts. The creator is added to
//   the roster automatically (in WalletContext.createGroup), so only OTHER members are selected here.

import { useEffect, useState } from 'react'

const MONO = "'IBM Plex Mono', monospace"

export interface GroupContactOption {
  hex: string
  name: string   // nickname or truncated npub (resolved by the caller)
}

export default function CreateGroupModal({
  contacts, onCreate, onClose,
}: {
  contacts: GroupContactOption[]
  onCreate: (name: string, memberHexes: string[]) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const canCreate = name.trim().length > 0 && selected.size > 0
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
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>New group</span>
          <span onClick={onClose} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(var(--border-rgb),0.16)', cursor: 'pointer' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-faint-dim)', marginBottom: 10 }}>GROUP NAME</div>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Weekend plans"
            maxLength={48}
            autoFocus
            style={{ width: '100%', boxSizing: 'border-box', padding: '13px 15px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)', fontSize: 14, color: 'var(--text-body)', outline: 'none', fontFamily: 'inherit', marginBottom: 18 }}
          />

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-faint-dim)', marginBottom: 10 }}>
            MEMBERS {selected.size > 0 && <span style={{ color: 'var(--text-teal-dim)' }}>· {selected.size} selected</span>}
          </div>
          {contacts.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.5, padding: '4px 0' }}>No contacts yet. Start a 1-to-1 conversation first, then you can add them to a group.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {contacts.map(c => {
                const on = selected.has(c.hex)
                return (
                  <div key={c.hex} onClick={() => toggle(c.hex)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', borderRadius: 11, cursor: 'pointer', background: on ? 'rgba(var(--teal-500-rgb),0.08)' : 'var(--surface-raised)', border: `1px solid ${on ? 'rgba(var(--teal-500-rgb),0.3)' : 'rgba(var(--border-rgb),0.12)'}` }}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 6, flexShrink: 0, border: `1.5px solid ${on ? 'var(--teal-500)' : 'rgba(var(--border-rgb),0.3)'}`, background: on ? 'var(--teal-500)' : 'transparent' }}>
                      {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
                    </span>
                    <span style={{ fontSize: 14, color: 'var(--text-body)', fontFamily: c.name.startsWith('npub') ? MONO : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ padding: 18, borderTop: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
          <div
            onClick={() => { if (canCreate) { onCreate(name.trim(), [...selected]); onClose() } }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: canCreate ? 'pointer' : 'default', background: canCreate ? 'var(--teal-grad)' : 'rgba(16,21,31,0.6)', border: canCreate ? 'none' : '1px solid rgba(var(--border-rgb),0.12)', color: canCreate ? 'var(--ink-on-accent)' : 'var(--text-disabled)' }}
          >
            Create group
          </div>
        </div>
      </div>
    </>
  )
}
