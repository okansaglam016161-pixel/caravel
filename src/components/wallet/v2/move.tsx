// The move flow's own components: the entry list, the direction chips, and the amount card.
//
// ENTRY AVAILABILITY IS A FIRST-CLASS STATE, not an absence. The M4 report's finding was that the
// shipped modal hides an entry it cannot honour — so a wallet below the reveal floor, or one whose
// account address has not been recovered, simply has no button and no explanation. Worse, the
// account case shows the button and fails AFTER the user has typed an amount and pressed Review,
// on the irreversible direction.
//
// So `MoveEntry` takes an explicit `disabledReason`. A direction that cannot run says why, in the
// place the user is looking. Nothing here decides the reason — Stage 2 passes it in from the same
// balance and account state the builders already read.

import type { ReactNode } from 'react'
import { C, tealBorder, tealFill } from './tokens'
import { Eye, Lock, Shield, Spinner } from './icons'
import { MASK_SHORT, fmt6 } from './format'
import { AmountField, SectionLabel } from './primitives'

export type Dir = 'conceal' | 'reveal'

/** Copy that differs by direction, in one place so the two can never disagree. */
/**
 * Copy that differs by direction, in ONE place so the two can never disagree.
 *
 * `done` and `pastTense` in particular: a success screen that says "Now shielded" after an unshield
 * is not a cosmetic slip, it is the wallet telling someone the opposite of what happened to their
 * privacy. Deriving both from this table means the two directions cannot be swapped or duplicated
 * by an edit to one branch.
 */
export const DIR = {
  conceal: {
    title: 'Shield', from: 'Unshielded', to: 'Shielded',
    verb: 'becomes shielded', avail: 'Unshielded available',
    blurb: 'Move unshielded funds into your shielded balance.',
    done: 'Now shielded', pastTense: 'shielded',
  },
  reveal: {
    title: 'Unshield', from: 'Shielded', to: 'Unshielded',
    verb: 'becomes unshielded', avail: 'Shielded available',
    blurb: 'Make shielded funds visible on chain. This cannot be undone.',
    done: 'Now unshielded', pastTense: 'unshielded',
  },
} as const

// ── Entry list ────────────────────────────────────────────────────────────────

export interface EntryProps {
  dir: Dir
  /** When set, the row is inert and this is shown beneath the title as the reason. */
  disabledReason?: string
  onClick?: () => void
}

function Entry({ dir, disabledReason, onClick }: EntryProps) {
  const dead = !!disabledReason
  const isConceal = dir === 'conceal'
  const Icon = isConceal ? Shield : Eye

  return (
    <span
      role="button" tabIndex={dead ? -1 : 0} aria-disabled={dead}
      onClick={dead ? undefined : onClick}
      onKeyDown={e => { if (!dead && e.key === 'Enter') onClick?.() }}
      className={dead ? undefined : 'cv-move-entry'}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 16px', borderRadius: 'var(--r-lg)', userSelect: 'none',
        cursor: dead ? 'not-allowed' : 'pointer',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        opacity: dead ? 0.6 : 1,
      }}
    >
      {/* The direction tile. Amber on unshield — the irreversible one — blue on shield. Colour is
          the SECOND signal here, never the only one: the icon and the word carry it too. */}
      <span style={{
        width: 34, height: 34, borderRadius: 'var(--r-md)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: isConceal ? 'var(--accent-wash)' : 'rgba(var(--warn-rgb),0.12)',
        color: isConceal ? 'var(--accent-ink)' : 'var(--warn)',
      }}>
        <Icon size={15} color="currentColor" width={1.9} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{DIR[dir].title}</span>
        {/* An absent control cannot explain itself, so a dead entry is SHOWN and states its reason
            rather than being hidden — the design's "disabled action with a stated reason". */}
        <span style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', lineHeight: 1.45 }}>
          {disabledReason ?? DIR[dir].blurb}
        </span>
      </span>
      {!dead && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M9 18l6-6-6-6" />
        </svg>
      )}
    </span>
  )
}

/** A single inert row that replaces BOTH entries — used for the in-flight lock and unknown balances. */
function EntryLocked({ text, icon }: { text: string; icon?: ReactNode }) {
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px',
      borderRadius: 'var(--r-lg)', background: 'var(--surface)',
      border: '1px solid var(--border)', cursor: 'not-allowed', opacity: 0.6,
    }}>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted-dim)' }}>{text}</span>
    </span>
  )
}

export function MoveList({ entries, lockedText, lockedIsFlight }: {
  entries?: EntryProps[]
  /** When set, replaces the whole list with one inert row. */
  lockedText?: string
  lockedIsFlight?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>MOVE BETWEEN BALANCES</SectionLabel>
      {lockedText
        ? <EntryLocked text={lockedText} icon={lockedIsFlight ? <Lock color={C.ghost} /> : undefined} />
        : (
          // Two across where there is room, stacked where there is not. Same auto-fit rule as the
          // extras row, so the page and the 480 modal need no separate layout.
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 8 }}>
            {entries?.map(e => <Entry key={e.dir} {...e} />)}
          </div>
        )}
    </div>
  )
}

/** The banner that sits above the balances while a move is in flight. */
export function InFlightBanner({ text }: { text: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 13, padding: '14px 17px', borderRadius: 13,
      background: tealFill(0.05), border: tealBorder(0.26),
    }}>
      <Spinner size={16} />
      <span style={{ fontSize: 13.5, fontWeight: 700, color: C.bright }}>{text}</span>
    </div>
  )
}

// ── Direction chips ───────────────────────────────────────────────────────────


// ── Amount card ───────────────────────────────────────────────────────────────

export interface AmountCardProps {
  dir: Dir
  /** The raw text in the field. Full precision, never a rounded display string. */
  value: string
  onChange: (v: string) => void
  onMax: () => void
  /** MAX has been pressed and not since typed over — the exact bigint is in play. */
  maxUsed: boolean
  /** The source balance, or null while hidden/unknown. */
  available: bigint | null
  hidden: boolean
  /** Reveal + MAX: what stays behind. Shown inside the card, before they can wonder. */
  leftoverNote?: string
  /** Validation message, shown in place of the note. */
  error?: string
}

export function AmountCard({ dir, value, onChange, onMax, maxUsed, available, hidden, leftoverNote, error }: AmountCardProps) {
  return (
    <AmountField
      value={hidden ? MASK_SHORT : value}
      onChange={onChange}
      onMax={onMax}
      maxUsed={maxUsed}
      readOnly={hidden}
      // Amber all the way through the irreversible direction, not only on the confirm button.
      accent={dir === 'conceal' ? 'teal' : 'amber'}
      availableLabel={hidden ? 'Available' : DIR[dir].avail}
      availableValue={hidden ? MASK_SHORT : available !== null ? fmt6(available) : '—'}
      note={leftoverNote}
      error={error}
    />
  )
}

