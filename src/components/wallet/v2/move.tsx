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
import { C, border, tealBorder, tealFill, warnBorder, warnFill } from './tokens'
import { Arrow, Eye, Lock, Shield, Spinner } from './icons'
import { MASK_SHORT, fmt6 } from './format'
import { AmountField, SectionLabel } from './primitives'

export type Dir = 'conceal' | 'reveal'

/** Copy that differs by direction, in one place so the two can never disagree. */
export const DIR = {
  conceal: { title: 'Make private', from: 'Public', to: 'Private', verb: 'becomes private', avail: 'Public available' },
  reveal: { title: 'Make public', from: 'Private', to: 'Public', verb: 'becomes public', avail: 'Private available' },
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
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: '14px 18px', borderRadius: 12, userSelect: 'none',
        cursor: dead ? 'not-allowed' : 'pointer',
        background: dead ? C.disabled : isConceal ? tealFill(0.07) : C.raised,
        border: dead ? border(0.08) : isConceal ? tealBorder(0.3) : border(0.16),
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <Icon size={15} color={dead ? C.ghost : isConceal ? C.teal : C.mutedDim} width={isConceal ? 2 : 1.9} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: dead ? C.ghost : isConceal ? C.bright : C.bodyDim }}>
            {DIR[dir].title}
          </span>
          {disabledReason && <span style={{ fontSize: 12, color: C.ghost, lineHeight: 1.4 }}>{disabledReason}</span>}
        </span>
      </span>
      {!dead && <span style={{ color: isConceal ? C.teal : C.faint, fontSize: 15, flexShrink: 0 }}>›</span>}
    </span>
  )
}

/** A single inert row that replaces BOTH entries — used for the in-flight lock and unknown balances. */
function EntryLocked({ text, icon }: { text: string; icon?: ReactNode }) {
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 11, padding: '14px 18px', borderRadius: 12,
      background: C.disabled, border: border(0.08), cursor: 'not-allowed',
    }}>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 600, color: C.ghost }}>{text}</span>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      <SectionLabel>MOVE BETWEEN BALANCES</SectionLabel>
      {lockedText
        ? <EntryLocked text={lockedText} icon={lockedIsFlight ? <Lock color={C.ghost} /> : undefined} />
        : entries?.map(e => <Entry key={e.dir} {...e} />)}
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

/**
 * THE DIRECTION, UNMISTAKABLE. Rendered from `dir` rather than written out twice, so the chips can
 * never disagree with the transaction being built.
 *
 * The ARROW carries the tone: teal for the routine move, amber for the permanent one. That is the
 * earliest point the caution appears — the design deliberately signals irreversibility from the
 * moment the direction is chosen, rather than saving it all for review.
 */
export function DirectionChips({ dir }: { dir: Dir }) {
  const chip = (kind: 'private' | 'public', active: boolean) => (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 7, padding: '7px 14px', borderRadius: 999,
      fontSize: 12.5, fontWeight: active ? 700 : 600,
      background: active && kind === 'private' ? tealFill(0.08) : C.raised,
      border: active && kind === 'private' ? tealBorder(0.32) : border(0.18),
      color: active && kind === 'private' ? C.teal300 : C.muted,
    }}>
      {kind === 'private' ? <Shield color={active ? C.teal : C.mutedDim} /> : <Eye color={C.mutedDim} />}
      {kind === 'private' ? 'Private' : 'Public'}
    </span>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      {dir === 'conceal' ? chip('public', false) : chip('private', true)}
      <Arrow color={dir === 'conceal' ? C.teal : C.warn} />
      {dir === 'conceal' ? chip('private', true) : chip('public', false)}
    </div>
  )
}

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
      accent={dir === 'conceal' ? 'teal' : 'neutral'}
      availableLabel={hidden ? 'Available' : DIR[dir].avail}
      availableValue={hidden ? MASK_SHORT : available !== null ? fmt6(available) : '—'}
      note={leftoverNote}
      error={error}
    />
  )
}

/**
 * The three facts, for the make-public review.
 *
 * NOT IN THE DESIGN CANVAS — its review screen carries the amber signal through the arrow, the
 * "becomes public" label and the confirm button, but never states WHY. The M4 report's position is
 * that the minimal honest signal is three facts, and the third (concealing again adds a record
 * rather than removing one) is the one users get wrong. Rendered compactly so it informs without
 * becoming friction; the preview can switch it off to compare.
 */
export function PermanenceNote() {
  return (
    <div style={{
      display: 'flex', gap: 10, padding: '11px 13px', borderRadius: 11,
      background: warnFill(0.10), border: warnBorder(0.28),
    }}>
      <Eye size={14} color={C.warn} />
      <div style={{ fontSize: 12, color: C.mutedDim, lineHeight: 1.55 }}>
        Anyone will be able to see this amount, and it stays visible permanently.
        Making it private again later adds a new record — it doesn’t remove this one.
      </div>
    </div>
  )
}
