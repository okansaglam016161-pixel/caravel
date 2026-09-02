//   A selectable person: checkbox, avatar, name, optional sub-line.
//
//   Shared by the two modals that pick people — New group picks contacts to add, Re-invite picks
//   members to re-send an invite to. The design makes it a shared part for the same reason
//   (parts/PickRow.dc.html, imported by §6B and §6C); the two files had near-identical rows written
//   out twice, differing only in whether a sub-line was present.
//
//   THE AVATAR IS THE GENERATED ONE, not the design's flat --recv disc. These rows exist to be
//   scanned — you are looking for a particular person in a list — and a column of identical grey
//   circles helps with that exactly as much as no avatar at all, which is what New group had before.
//   Same reasoning as the resolved card in §6A, and Re-invite already drew it this way.
//
//   `subInk` exists for Re-invite, whose sub-line is a status rather than a detail: "Left the chat"
//   is warn-toned, "In the group" is not. New group passes no sub-line at all.

import Avatar from './Avatar'

export default function PickRow({ hex, name, checked, onToggle, sub, subInk = 'var(--text-muted-dim)' }: {
  hex: string
  name: string
  checked: boolean
  onToggle: () => void
  sub?: string
  subInk?: string
}) {
  return (
    <div
      onClick={onToggle}
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggle() } }}
      className="cv-pick-row"
      style={{
        display: 'flex', alignItems: 'center', gap: 11,
        padding: '9px 10px', borderRadius: 10, cursor: 'pointer',
      }}
    >
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 18, flexShrink: 0, borderRadius: 6, boxSizing: 'border-box',
        background: checked ? 'var(--accent-400)' : 'transparent',
        border: `1.5px solid ${checked ? 'var(--accent-400)' : 'var(--border-strong)'}`,
      }}>
        {checked && (
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        )}
      </span>
      <Avatar hex={hex} nickname={name.startsWith('npub') ? undefined : name} size={30} radius={99} fontSize={11.5} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-name)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        {sub && (
          <div style={{ fontSize: 11.5, color: subInk, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
        )}
      </div>
    </div>
  )
}
