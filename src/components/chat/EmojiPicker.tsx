// The offline emoji picker (B) — a search box over a scrollable, category-labelled grid.
//
// HAND-BUILT AND DEPENDENCY-FREE. See emojiData.ts for why: a packaged picker would pull a
// multi-megabyte index and, in the usual setup, sprite sheets from a CDN — a third party learning
// that this browser opened a chat composer, inside an app whose whole premise is that no third
// party learns anything. Nothing here fetches, and the glyphs come from the OS font.
//
// NO TEST, deliberately, and consistent with MessageBubble: there is no component harness in this
// repo and one is not being added for a grid of buttons. What is worth testing was pulled out into
// emojiSearch.ts and composerInsert.ts, which are pure and covered.
//
// POSITIONING IS THE CALLER'S. This renders a scrim + an absolutely-positioned panel and expects to
// sit inside a `position: relative` wrapper — the same shape the conversation ⋯ menu uses, so both
// popovers dismiss identically. Both composers mount it above their picker button, which is OUTSIDE
// the message scroller; a popover inside that scroller would clip against its padding edge (that
// problem belongs to Checkpoint C's hover-row popover, not to this one).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAnchoredPopover } from './popoverFit'
import { ALL_EMOJI, EMOJI_CATEGORIES } from './emojiData'
import { searchEmoji } from './emojiSearch'
import { MONO } from './chatDisplay'
import { pushEscape } from './escapeStack'

const COLUMNS = 8
const CELL = 34

// One tappable emoji. `title` gives the first keyword as a tooltip, which doubles as the accessible
// name — the character alone is announced inconsistently by screen readers.
function EmojiButton({ char, label, onPick }: { char: string; label: string; onPick: (c: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(char)}
      title={label}
      aria-label={label}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: CELL, height: CELL, padding: 0, borderRadius: 8,
        border: 'none', background: 'transparent', cursor: 'pointer',
        fontSize: 21, lineHeight: 1,
        // Emoji render from the OS font; naming the system emoji families keeps a stray webfont
        // from being asked for a glyph it does not have and answering with tofu.
        fontFamily: "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif",
      }}
      className="cv-emoji-cell"
    >
      {char}
    </button>
  )
}

function Grid({ entries, onPick }: { entries: { char: string; keywords: string[] }[]; onPick: (c: string) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`, gap: 2 }}>
      {entries.map(e => <EmojiButton key={e.char} char={e.char} label={e.keywords[0]} onPick={onPick} />)}
    </div>
  )
}

export default function EmojiPicker({ onPick, onClose, placement = 'above', align = 'left', offset = 54 }: {
  // Called with the chosen character. The picker does NOT close on pick — see the note below.
  onPick: (char: string) => void
  onClose: () => void
  // Where the panel sits relative to its anchor. The defaults reproduce the composer placement this
  // component shipped with in B exactly, so that call site passes none of them. Checkpoint C's
  // quick-set needs the other combinations: its anchor is a 26px action button rather than a 46px
  // composer button (hence `offset`), it sits INSIDE the message scroller where a panel can run off
  // the top (hence `placement`), and it opens INBOARD — over the bubble rather than off the thread
  // edge — which is leftward for a received bubble and rightward for a sent one (hence `align`).
  placement?: 'above' | 'below'
  align?: 'left' | 'right'
  offset?: number
}) {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // Measured against the container the panel must stay inside — the message thread when the picker
  // is opened from a reaction quick-set, the viewport when it is opened from a composer (which sits
  // outside the scroller and has always fitted, so nothing changes there).
  const { ref: panelRef, style: panelStyle } = useAnchoredPopover({ placement, align, offset })

  // Esc closes, wherever focus happens to be — the same contract ImageLightbox offers, and it must
  // hold even after a pick has moved focus into the composer.
  useEffect(() => {
    searchRef.current?.focus()
    // Escape is claimed through the shared stack — see escapeStack.ts. Unchanged when this is the
    // only thing open; what it adds is that the thread underneath no longer closes as well.
    return pushEscape(onClose)
  }, [onClose])

  // Recomputed per keystroke over ~170 entries, which is nothing; memoised anyway so the grid's
  // children keep their identity while the user types nothing new.
  const results = useMemo(() => (query.trim() === '' ? null : searchEmoji(ALL_EMOJI, query)), [query])

  return (
    <>
      {/* Click-away, matching the conversation ⋯ menu: a full-screen scrim under the panel. It also
          swallows the first click on the composer, which is the established behaviour here. */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100 }} />
      <div
        ref={panelRef}
        style={{
          ...panelStyle,
          zIndex: 101,
          width: COLUMNS * CELL + 24, padding: 10, borderRadius: 13,
          background: 'var(--surface-raised)', border: '1px solid var(--border)',
          boxShadow: 'var(--e3)',
        }}
      >
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          // Enter must not reach the composer's send handler from in here.
          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
          placeholder="Search emoji…"
          maxLength={40}
          style={{
            width: '100%', boxSizing: 'border-box', marginBottom: 8,
            padding: '8px 10px', borderRadius: 9,
            background: 'var(--surface-inset)', border: '1px solid var(--border)',
            outline: 'none', color: 'var(--text-body)', fontFamily: MONO, fontSize: 12,
          }}
        />

        <div style={{ maxHeight: 232, overflowY: 'auto', overflowX: 'hidden' }}>
          {results === null ? (
            EMOJI_CATEGORIES.map(cat => (
              <div key={cat.name} style={{ marginBottom: 8 }}>
                <div style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-faint)', margin: '2px 0 5px 3px' }}>
                  {cat.name}
                </div>
                <Grid entries={cat.emoji} onPick={onPick} />
              </div>
            ))
          ) : results.length === 0 ? (
            <div style={{ padding: '18px 6px', textAlign: 'center', fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)' }}>
              No emoji match “{query.trim()}”
            </div>
          ) : (
            <Grid entries={results} onPick={onPick} />
          )}
        </div>
      </div>
    </>
  )
}
