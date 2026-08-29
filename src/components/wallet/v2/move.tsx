// What is left of the move flow's own module: the entry shape, and the in-flight banner.
//
// THE DIRECTION COPY LIVES IN moveCopy.ts and the amount field is panels/AmountBlock, shared with
// Send. Both left this file in the V3 pass — the copy so it could be tested as data without a
// renderer, the field so the two flows could not draw the same control two ways.
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
import type { Dir } from './moveCopy'

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
