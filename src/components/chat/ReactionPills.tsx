// The reaction strip drawn under a bubble (C).
//
// Rendered by the CALL SITE and handed to MessageBubble as a prebuilt node, exactly as `quoted` and
// `actions` already are. That split is what keeps MessageBubble free of the store and of display
// names: a group tooltip needs nameFor, a DM's does not, and neither belongs in a component whose
// job is bubble markup and alignment.

import type { ReactionSummary } from './reactionDisplay'
import { MONO } from './chatDisplay'

export default function ReactionPills({ summaries, pending, labelFor, onToggle }: {
  summaries: ReactionSummary[]
  // The emoji whose add/remove is in flight, dimmed until it settles (F7 — no optimistic layer, so
  // a pill only appears once a relay has accepted).
  pending: string | null
  // Reactor hex → display name, for the "who reacted" tooltip. Omitted in a DM, where the answer is
  // one of two people and a tooltip listing npubs would be noise.
  labelFor?: (hex: string) => string
  // Tap to toggle: my own pill removes, anyone else's adds mine to it.
  onToggle: (emoji: string, action: 'add' | 'remove') => void
}) {
  if (summaries.length === 0) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
      {summaries.map(s => {
        const waiting = pending === s.emoji
        const title = labelFor ? s.who.map(labelFor).join(', ') : undefined
        return (
          <button
            key={s.emoji}
            type="button"
            onClick={() => onToggle(s.emoji, s.mine ? 'remove' : 'add')}
            disabled={pending !== null}
            title={title}
            aria-label={s.mine ? `Remove ${s.emoji} reaction` : `React with ${s.emoji}`}
            aria-pressed={s.mine}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: s.count > 1 ? '2px 7px 2px 5px' : '2px 5px',
              height: 22, borderRadius: 999,
              // My own pill is tinted and outlined, so "which of these is mine" survives a strip of
              // several — the tap target that REMOVES has to be unmistakable.
              background: s.mine ? 'rgba(var(--teal-500-rgb),0.16)' : 'var(--surface-inset)',
              border: `1px solid ${s.mine ? 'rgba(var(--teal-500-rgb),0.45)' : 'rgba(var(--border-rgb),0.16)'}`,
              cursor: pending !== null ? 'default' : 'pointer',
              opacity: waiting ? 0.45 : 1,
            }}
          >
            <span style={{ fontSize: 13, lineHeight: 1, fontFamily: "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif" }}>{s.emoji}</span>
            {s.count > 1 && (
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: s.mine ? 'var(--teal-300)' : 'var(--text-muted-dim)' }}>{s.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
