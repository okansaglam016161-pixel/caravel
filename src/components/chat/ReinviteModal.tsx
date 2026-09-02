//   C-M2 re-invite picker: choose WHICH members of a group to re-send the invite to.
//
//   Deliberately a sibling of CreateGroupModal rather than a mode of it — same frame and rows,
//   different subject (a fixed roster with per-member status vs a contact list plus a name field).
//   Merging them would put two flows that are already diverging behind one component. They share
//   what is genuinely shared: ModalCard for the frame, PickRow for the rows.
//
//   The list is the FULL roster, always. `leftAt` is a HINT derived from received leave notices, and
//   it drives ordering, the subtitle and the initial selection — never who is reachable. A member
//   whose leave notice was lost (best-effort delivery) must still be selectable, and re-inviting a
//   member who never left is a genuine no-op on their side (first-def-wins), not an error. That last
//   fact is why the body line survives the reskin: the roster shows current members too, and ticking
//   one has to look as harmless as it actually is.

import { useEffect, useState } from 'react'
import ModalCard from './ModalCard'
import PickRow from './PickRow'

export interface ReinviteMemberOption {
  hex: string
  name: string           // nickname or truncated npub (resolved by the caller)
  leftAt: number | null  // ms epoch of the leave notice we believe is current, else null
}

// Relative age of a leave notice. STAYS LOCAL: one caller, and no sibling implementation to drift
// against. chatDisplay.ts earns its name by holding what two or more surfaces share; the day a
// second surface wants relative ages, this moves there with a test.
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
    <ModalCard
      title="Re-invite members"
      subtitle={`Invite people back into ${groupName}`}
      onClose={onClose}
      zIndex={200}
      maxWidth={440}
    >
      <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', lineHeight: 1.5, flexShrink: 0 }}>
        Members who are still in the group won’t see anything.
      </div>

      {members.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '22px 16px', borderRadius: 12, border: '1px dashed var(--border-strong)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>This group has no other members</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 3, lineHeight: 1.45, textWrap: 'pretty' }}>
            There is no one to invite back.
          </div>
        </div>
      ) : (
        /* Only the rows scroll — the subtitle, the body line and the action stay put. */
        <div style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', margin: '-2px -6px 0' }}>
          {members.map(m => (
            <PickRow
              key={m.hex}
              hex={m.hex}
              name={m.name}
              checked={selected.has(m.hex)}
              onToggle={() => toggle(m.hex)}
              sub={m.leftAt !== null ? `Left the chat · ${agoLabel(m.leftAt)}` : 'In the group'}
              subInk={m.leftAt !== null ? 'var(--warn)' : undefined}
            />
          ))}
        </div>
      )}

      {/* OUR LABEL, not the design's flat "Send invites". It carries the count that the dropped
          MEMBERS header used to show, and the disabled state says what to do rather than sitting
          there dead. */}
      <button
        onClick={() => { if (canSend) { onConfirm([...selected]); onClose() } }}
        disabled={!canSend}
        className={canSend ? 'cv-btn-primary' : undefined}
        style={{
          width: '100%', flexShrink: 0, padding: 11, borderRadius: 11, border: 'none',
          background: canSend ? 'var(--accent-400)' : 'var(--msg-received)',
          color: canSend ? 'var(--ink-on-accent)' : 'var(--text-muted-dim)',
          fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit',
          cursor: canSend ? 'pointer' : 'default',
        }}
      >
        {canSend ? `Send invite to ${selected.size}` : 'Select members'}
      </button>
    </ModalCard>
  )
}
