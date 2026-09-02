//   The frame every chat entry modal shares — New conversation, New group, Re-invite.
//
//   ── WHY IT EXISTS ────────────────────────────────────────────────────────────
//
//   The design draws all three as one card (§6A/6B/6C): the same surface, hairline, radius,
//   elevation and 13px rhythm; the same header row with a 26px close; the same single full-width
//   action at the foot. They were three hand-written copies of that, and the two that already
//   existed had already drifted — one centred itself with a flex overlay, the other with
//   `top/left: 50%` and a transform, for the identical job.
//
//   FLEX CENTRING, NOT A TRANSFORM. Both work, but a transform establishes a containing block for
//   every absolutely-positioned descendant, which is a trap to leave lying inside a component whose
//   whole purpose is to hold arbitrary content. Nothing in these three modals is absolutely
//   positioned today; the point is that nothing has to think about it tomorrow.
//
//   ── zIndex IS A PROP, DELIBERATELY ───────────────────────────────────────────
//
//   The app's stacking ladder is currently 40/41 for popovers, 60 for the chat modals, 100 for the
//   lightbox, 150/151 for the relay panel and 200/201 for the group modals. Nothing is broken, but
//   the relay panel sitting above the lightbox is arbitrary rather than decided. Rationalising it is
//   its own change; until then this component CARRIES the difference rather than hiding it behind a
//   constant that would quietly pick a winner.

import type { ReactNode } from 'react'

export default function ModalCard({ title, onClose, zIndex, maxWidth = 420, children }: {
  title: string
  onClose: () => void
  /** See the note above — the ladder is not settled, so each caller states its own. */
  zIndex: number
  maxWidth?: number
  children: ReactNode
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        background: 'rgba(5,8,14,0.78)', backdropFilter: 'blur(3px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth, maxHeight: '88vh',
          display: 'flex', flexDirection: 'column', gap: 13,
          borderRadius: 16, padding: 20,
          background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--e3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>{title}</div>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="cv-icon-btn"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, flexShrink: 0, padding: 0,
              borderRadius: 8, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-muted-dim)', cursor: 'pointer',
            }}
          >
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
