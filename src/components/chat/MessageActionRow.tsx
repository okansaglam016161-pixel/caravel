// The per-message hover affordances (C) — React, Reply, and an overflow menu holding Edit.
//
// ONE COMPONENT, THREE CALL SITES. The DM thread, the group thread's sent branch and its received
// branch had each spelled this row out inline; adding a third button and a menu to all three would
// have made three copies of forty lines that must agree. They are the same row and now say so once.
//
// WHY EDIT MOVED INTO A "⋯". Reply and Edit already crowded the gutter at 2 × 26px + gap; a third
// visible button makes it 94px of furniture sitting outboard of a bubble that is capped at 62% of
// an already-inset thread column. React is the one people reach for most and Edit the least, so the
// two that stay visible are React and Reply and Edit takes one extra click — the arrangement Signal
// settled on, for the same reason. The row is hover-only, so none of this is visible at rest.
//
// The menu holds only Edit today and is therefore rendered only when editing is offered — an empty
// "⋯" that opens an empty panel would be worse than no button at all.

import { useState, type ReactNode } from 'react'
import { ACTION_BTN } from './chatDisplay'

export default function MessageActionRow({ onReact, reactOpen, reactPopover, onReply, onEdit, menuAlign }: {
  // Each callback is optional; an omitted one drops its button. That is how a received bubble loses
  // Edit, a self-thread bubble loses React (WalletContext.reactMessage has no one to publish to —
  // see its DM branch), and a pre-M2 row with no logical id loses all three.
  onReact?: () => void
  reactOpen?: boolean
  // The quick-set popover, prebuilt by the caller and rendered inside this button's positioning
  // context. Passed as a node for the same reason MessageBubble takes `quoted` and `actions` that
  // way: the caller owns the message, the store and the in-flight state; this owns the layout.
  reactPopover?: ReactNode
  onReply?: () => void
  onEdit?: () => void
  // Which way the overflow menu opens — away from the thread edge, i.e. the same inboard rule the
  // quick-set follows.
  menuAlign: 'left' | 'right'
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  if (!onReact && !onReply && !onEdit) return null

  return (
    <>
      {onReact && (
        // `position: relative` is load-bearing: it is what the quick-set anchors to.
        <div style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
          <button
            className="cv-msg-react"
            onClick={onReact}
            title="React"
            aria-label="React to message"
            aria-expanded={!!reactOpen}
            style={{ ...ACTION_BTN, ...(reactOpen ? { opacity: 1, background: 'rgba(var(--border-rgb),0.14)' } : null) }}
          >
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx={12} cy={12} r={9} /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" /></svg>
          </button>
          {reactPopover}
        </div>
      )}

      {onReply && (
        <button className="cv-msg-reply" onClick={onReply} title="Reply" aria-label="Reply to message" style={ACTION_BTN}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 17l-5-5 5-5" /><path d="M4 12h11a5 5 0 0 1 5 5v2" /></svg>
        </button>
      )}

      {onEdit && (
        <div style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
          <button
            className="cv-msg-more"
            onClick={() => setMenuOpen(o => !o)}
            title="More"
            aria-label="More message actions"
            aria-expanded={menuOpen}
            style={{ ...ACTION_BTN, ...(menuOpen ? { opacity: 1, background: 'rgba(var(--border-rgb),0.14)' } : null) }}
          >
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx={12} cy={5} r={1.7} /><circle cx={12} cy={12} r={1.7} /><circle cx={12} cy={19} r={1.7} /></svg>
          </button>
          {menuOpen && (
            <>
              {/* Same scrim shape as the conversation ⋯ menu and both pickers, so every popover in
                  the app dismisses identically. */}
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div
                style={{
                  position: 'absolute', top: 30, zIndex: 41, minWidth: 150, padding: 5,
                  ...(menuAlign === 'left' ? { left: 0 } : { right: 0 }),
                  borderRadius: 10, background: 'var(--surface-raised)',
                  border: '1px solid rgba(var(--border-rgb),0.18)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                }}
              >
                <button
                  onClick={() => { setMenuOpen(false); onEdit() }}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-body)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', whiteSpace: 'nowrap' }}
                >
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                  Edit message
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}
