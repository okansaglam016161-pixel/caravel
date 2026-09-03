// The quick-set popover (C): six common reactions plus a "+" that opens the shared picker from B.
//
// LIVES INSIDE THE MESSAGE SCROLLER, which is the whole difficulty and the reason this is not just
// EmojiPicker with a shorter list. Both threads scroll with `overflowY: 'auto'` on a padded flex
// column, and CSS resolves the other axis to `auto` alongside it — so a panel that runs past the
// container's padding edge either clips or spawns a horizontal scrollbar across the whole thread.
// Two things keep it inside (F17):
//   - it opens INBOARD, over the bubble rather than out toward the thread edge. The action row sits
//     outboard of its bubble, so inboard is rightward for a sent bubble and leftward for a received
//     one; the caller passes which.
//   - it FLIPS below its anchor when there is not room above, measured after layout and before
//     paint, so the first message in a thread does not get a panel hanging off the top.
// Deliberately NOT solved with a portal or by setting overflow-x on the scroller: a portal would
// detach the panel from a message that scrolls, and the overflow change is global to both threads.

import { useState } from 'react'
import EmojiPicker from './EmojiPicker'
import { QUICK_SET } from './emojiData'
import { useAnchoredPopover } from './popoverFit'

const CELL = 30
// Anchor height (26px action button) plus a small gap.
const OFFSET = CELL + 6

export default function ReactionQuickSet({ mine, blocked, pending, align, onPick, onClose }: {
  // Emoji I already hold on this message — shown pressed, and picking one again removes it.
  mine: readonly string[]
  // Would a NEW emoji exceed my two-reaction allowance? Disables everything I am not already
  // holding, so the limit is visible rather than a silent refusal after a round trip.
  blocked: boolean
  // The emoji whose add/remove is in flight, dimmed until it settles. There is no optimistic layer
  // and no rollback (F7): the store is written only once a relay accepts, so this is the only
  // feedback between tap and pill, and it is honest about which one is waiting.
  pending: string | null
  // Which way the panel opens. 'left' anchors its left edge to the button (extends rightward).
  align: 'left' | 'right'
  onPick: (emoji: string) => void
  onClose: () => void
}) {
  const [full, setFull] = useState(false)
  // Placement, the vertical flip and the stay-inside-the-thread correction all come from here — see
  // popoverFit.ts for why a fixed side could not work on a received bubble. The picker behind "+"
  // gets its own measurement, since it is several times taller than this row.
  const { ref: rowRef, style: rowStyle } = useAnchoredPopover({ placement: 'above', align, offset: OFFSET })

  return (
    <>
      {/* Click-away, the same scrim shape the conversation ⋯ menu and the composer picker use. */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100 }} />

      {full ? (
        <EmojiPicker onPick={onPick} onClose={onClose} placement="above" align={align} offset={OFFSET} />
      ) : (
        <div
          ref={rowRef}
          style={{
            ...rowStyle,
            zIndex: 101,
            // max-content, NOT the default shrink-to-fit. An absolutely positioned box sizes against
            // `containing block width − offsets`, and the containing block here is the 26px action
            // button — so `auto` would squeeze the row toward its min-content width and crush the
            // emoji. The explicit keyword also makes the width this row reports to fitPopover the
            // width it will actually have.
            width: 'max-content',
            display: 'flex', alignItems: 'center', gap: 1, padding: 4,
            borderRadius: 999, background: 'var(--surface-raised)',
            border: '1px solid var(--border)', boxShadow: 'var(--e2)',
            // The strip must not wrap or shrink inside the bubble row it overlays.
            whiteSpace: 'nowrap',
          }}
        >
          {QUICK_SET.map(e => {
            const held = mine.includes(e)
            const waiting = pending === e
            const disabled = pending !== null || (blocked && !held)
            return (
              <button
                key={e}
                type="button"
                onClick={() => { if (!disabled) onPick(e) }}
                disabled={disabled}
                title={held ? 'Remove reaction' : blocked ? 'Two reactions per message' : `React ${e}`}
                aria-label={held ? `Remove ${e} reaction` : `React with ${e}`}
                aria-pressed={held}
                className="cv-emoji-cell"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: CELL, height: CELL, flexShrink: 0, padding: 0, borderRadius: '50%',
                  border: 'none', background: held ? 'var(--accent-wash)' : 'transparent',
                  cursor: disabled ? 'default' : 'pointer',
                  opacity: waiting ? 0.4 : disabled ? 0.35 : 1,
                  fontSize: 18, lineHeight: 1,
                  fontFamily: "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif",
                }}
              >
                {e}
              </button>
            )
          })}
          {/* "+" swaps this row for the full picker in place, rather than opening a second popover
              on top of it — one panel at a time, one scrim, one Esc. */}
          <button
            type="button"
            onClick={() => setFull(true)}
            title="More emoji"
            aria-label="More emoji"
            className="cv-emoji-cell"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: CELL, height: CELL, padding: 0, borderRadius: '50%',
              border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)',
              marginLeft: 2,
            }}
          >
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      )}
    </>
  )
}
