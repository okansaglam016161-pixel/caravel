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
//   ── zIndex IS SETTLED (stage 7) ──────────────────────────────────────────────
//
//   The ladder used to be 40/41 popovers, 60 chat modals, 100 lightbox, 150/151 relay panel and
//   200/201 group modals — which put the relay panel above the lightbox for no reason anyone chose.
//   Stage 7 decided it: 100 popovers, 200 panels, 300 modals, 400 sheets, 500 lightbox. Every
//   caller of this component is a modal, so the tier is a constant here rather than a prop; the
//   prop only ever existed because the ladder was unsettled, and nothing is left for it to say.

import type { ReactNode } from 'react'

const MODAL_Z = 300

export default function ModalCard({ title, subtitle, onClose, maxWidth = 420, children }: {
  title: string
  /**
   * A second line under the title, inside the header. Re-invite names its group here.
   *
   * NOT THE SAME AS A BODY INSTRUCTION LINE, which is why New conversation's "Enter an npub or an
   * @name" is a child rather than this prop: that one is full width, below the header, and reads as
   * the first thing you do. This one sits beside the close button and says what the modal is about.
   */
  subtitle?: string
  onClose: () => void
  maxWidth?: number
  children: ReactNode
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: MODAL_Z,
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
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>
            )}
          </div>
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
