//   Phase 1 create-group modal: name + multi-select from existing contacts. The creator is added to
//   the roster automatically (in WalletContext.createGroup), so only OTHER members are selected here.
//
//   ONE STEP, AND NO npub ENTRY. You pick from people you already have a conversation with. Adding a
//   stranger to a group would be a feature — a second resolution flow, and a decision about whether
//   an unaccepted contact can be enrolled — not a thing this screen quietly grew.
//
//   The frame and the rows are shared: ModalCard with New conversation and Re-invite, PickRow with
//   Re-invite. See those files for why.

import { useEffect, useState } from 'react'
import ModalCard from './ModalCard'
import PickRow from './PickRow'
import { MONO } from './chatDisplay'

const MAX_NAME = 48

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

  const named = name.length > 0

  return (
    <ModalCard title="New group" onClose={onClose} maxWidth={440}>
      {/* Name + a live character count. maxLength has always been 48; it used to enforce that
          silently, so a name stopped growing with no explanation. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        padding: '11px 13px', borderRadius: 11,
        border: `1px solid ${named ? 'var(--accent-400)' : 'var(--border)'}`,
        boxShadow: named ? '0 0 0 3px rgba(var(--accent-400-rgb),0.14)' : 'none',
      }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Group name"
          maxLength={MAX_NAME}
          autoFocus
          className="cv-composer"
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 13.5, fontFamily: 'inherit', padding: 0 }}
        />
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--text-muted-dim)', flexShrink: 0 }}>{name.length}/{MAX_NAME}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2, flexShrink: 0 }}>
        <span style={{ flex: 1, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-muted-dim)' }}>MEMBERS</span>
        {selected.size > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-ink)' }}>{selected.size} selected</span>
        )}
      </div>

      {contacts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '22px 16px', borderRadius: 12, border: '1px dashed var(--border-strong)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>No contacts yet</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 3, lineHeight: 1.45, textWrap: 'pretty' }}>
            Start a conversation first, then add people to a group.
          </div>
        </div>
      ) : (
        /* ONLY THE ROWS SCROLL. The design draws three contacts in a plain column; a real list is
           longer, and the name field, this header and the action all have to stay put while it is
           scrolled. The negative margin lets a row's hover fill reach the card's padding. */
        <div style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', margin: '-4px -6px 0' }}>
          {contacts.map(c => (
            <PickRow
              key={c.hex}
              hex={c.hex}
              name={c.name}
              checked={selected.has(c.hex)}
              onToggle={() => toggle(c.hex)}
            />
          ))}
        </div>
      )}

      <button
        onClick={() => { if (canCreate) { onCreate(name.trim(), [...selected]); onClose() } }}
        disabled={!canCreate}
        className={canCreate ? 'cv-btn-primary' : undefined}
        style={{
          width: '100%', flexShrink: 0, padding: 11, borderRadius: 11, border: 'none',
          background: canCreate ? 'var(--accent-400)' : 'var(--msg-received)',
          color: canCreate ? 'var(--ink-on-accent)' : 'var(--text-muted-dim)',
          fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit',
          cursor: canCreate ? 'pointer' : 'default',
        }}
      >
        Create group
      </button>
    </ModalCard>
  )
}
