//   The thread frame's components. Its measurements are in threadChrome.ts — see that file for
//   why the two are split, and for what this frame is unifying between the DM and group views.
//
//   PRESENTATION ONLY. Everything these render arrives as props; nothing here holds state, reads
//   data, or asks what a message is. Anything that has to answer that belongs in chatDisplay.ts
//   or in the view.

import type { ReactNode } from 'react'
import { MONO } from './chatDisplay'
import { MENU_BTN, COMPOSER_CHIP_RADIUS } from './threadChrome'

/**
 * "End-to-end encrypted", stated calmly.
 *
 * IT IS A SUBTITLE, NOT A BADGE. The teal era drew this in accent ink at 12px with a heavy lock,
 * and then repeated it on a pill above the first message of every conversation. That is a privacy
 * product shouting its own claim, and shouting reads as insecurity — the confident register is
 * the one Signal and iMessage use, where encryption is stated once, quietly, and permanently.
 * "Of course it is."
 *
 * `suffix` is how the group says "· 5 members" without inventing a second line. The group header
 * used to carry a THIRD row for the member count, which made the two threads different heights
 * for no reason anyone chose.
 */
export function E2ELine({ suffix }: { suffix?: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 2, fontSize: 11, color: 'var(--text-muted-dim)', minWidth: 0 }}>
      <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0 }}>
        <rect x={5} y={11} width={14} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        End-to-end encrypted{suffix ? ` · ${suffix}` : ''}
      </span>
    </div>
  )
}

/** The header's ⋯ control. Its height is MENU_BTN, which is also what MENU_PANEL's offset is built from. */
export function ThreadMenuButton({ open, title, onClick }: {
  open: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-expanded={open}
      className="cv-icon-btn"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: MENU_BTN, height: MENU_BTN, flexShrink: 0, padding: 0,
        borderRadius: 8, border: '1px solid var(--border)',
        background: open ? 'var(--surface-inset)' : 'transparent',
        color: 'var(--text-muted-dim)', cursor: 'pointer',
      }}
    >
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
        <circle cx={5} cy={12} r={1.6} /><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} />
      </svg>
    </button>
  )
}

/**
 * The first-message state. A lock on an accent tile, a title, a sentence.
 *
 * THIS IS WHERE THE ENCRYPTION PILL WENT. Taking the pill off every thread left one place where
 * the claim still earns its space: a conversation with no history, where there is nothing else to
 * read and the reassurance is the entire point of the screen.
 */
export function ThreadEmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center' }}>
      <span style={{
        width: 44, height: 44, borderRadius: 13, flexShrink: 0,
        background: 'var(--accent-wash)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
          <rect x={5} y={11} width={14} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      </span>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', maxWidth: 280, lineHeight: 1.55, textWrap: 'pretty' }}>{body}</div>
    </div>
  )
}

/**
 * The date separator between runs of messages (§3B).
 *
 * ITS PLACE IN THE LIST IS DECIDED AT RENDER TIME, not stored: each view walks its own item array
 * and compares neighbours with chatDisplay's isNewDay. Nothing is inserted into the merged list, so
 * mergeThreadItems and the ThreadItem union stay exactly as they were — and so do their tests.
 */
export function DayDivider({ label }: { label: string }) {
  return (
    <div style={{
      alignSelf: 'center', padding: '6px 0 2px',
      fontFamily: MONO, fontSize: 10, letterSpacing: '0.08em',
      color: 'var(--text-muted-dim)',
    }}>{label}</div>
  )
}

/**
 * The reply chip and the editing banner — one shape, two sets of contents.
 *
 * IT LIVES INSIDE THE COMPOSER CARD, above the input row, divided by its own border-bottom. Both
 * states are the composer being in a mode, not a notice sitting near it, and V3 draws them that
 * way: the card gets a header rather than the page getting a banner. They were two byte-identical
 * bordered blocks floating above the composer in each of the two views — four copies of one thing.
 *
 * `lead` is the only real difference: a 3px accent rule for a reply, a pencil for an edit.
 */
export function ComposerChip({ lead, label, detail, onCancel }: {
  lead: ReactNode
  label: string
  detail?: string
  onCancel: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
      borderBottom: '1px solid var(--border)', background: 'var(--surface-base)',
      // Rounded here rather than clipped by the card — see COMPOSER_CARD for what clipping cost.
      borderTopLeftRadius: COMPOSER_CHIP_RADIUS, borderTopRightRadius: COMPOSER_CHIP_RADIUS,
    }}>
      {lead}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-ink)' }}>{label}</div>
        {detail && (
          <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</div>
        )}
      </div>
      <button
        onClick={onCancel}
        title="Cancel"
        aria-label="Cancel"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 20, height: 20, flexShrink: 0, padding: 0, borderRadius: 6,
          border: 'none', background: 'transparent', color: 'var(--text-muted-dim)', cursor: 'pointer',
        }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
  )
}

/** The 3px accent rule a reply chip leads with. */
export const REPLY_RULE = (
  <span style={{ width: 3, height: 28, borderRadius: 99, background: 'var(--accent-400)', flexShrink: 0 }} />
)
