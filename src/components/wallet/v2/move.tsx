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

import { C, tealBorder, tealFill } from './tokens'
import { Spinner } from './icons'
import { MASK_SHORT, fmt6 } from './format'
import { AmountField } from './primitives'

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

