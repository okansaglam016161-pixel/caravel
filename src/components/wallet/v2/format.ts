// Amount formatting for the M4 modal.
//
// THE DESIGN SHOWS SIX DECIMAL PLACES EVERYWHERE — "12,847.503210", not "12,847.50". That is a
// deliberate change from the shipped modal's 2dp display, and it is the right one for a wallet
// whose fees are measured in hundredths of a thousandth: at 2dp a 0.014537 fee renders as "0.01",
// and two different fees render identically.
//
// ALL BIGINT. Amounts are 128-bit on the wire; a formatter that divided through Number would drift
// on a large balance, and the M2 lesson was that a rounded figure fed back into an amount field
// asks the network for a number that does not exist. Nothing here converts to Number.

import { TARI_ASSET, formatUnits } from '../../../crypto/assets'

const MICRO = 1_000_000n

/**
 * The unit name every amount is shown in. ONE place, so a rename is one line.
 *
 * DISPLAY ONLY. Nothing stored, sent or keyed carries it: amounts travel and persist as µtTARI
 * bigints, and the SDK's own symbols (TARI_RESOURCE_ADDRESS and the like) are not this.
 */
export const TICKER = TARI_ASSET.ticker

/**
 * A tTARI amount for display: EXACT, grouped, trailing zeros dropped — "12,847.50321", "0.015194",
 * "1". The shared formatter (crypto/assets.formatUnits) at tTARI's six decimals; never padded, never
 * rounded. The name stays for its many callers; "6" is the precision kept, not a width.
 */
export function fmt6(microtari: bigint): string {
  return formatUnits(microtari, 6)
}

/**
 * Amount-ENTRY form: full precision, no grouping, trailing zeros trimmed. "999.997686"
 *
 * Distinct from fmt6, which groups thousands for reading. Grouping separators
 * would have to be stripped before parsing, and that round-trip is exactly where M2's MAX bug
 * lived — so the entry form never has any.
 */
export function toInput(microtari: bigint): string {
  const whole = microtari / MICRO
  const frac = (microtari % MICRO).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** Masked stand-in used when the hide toggle is on. Width roughly matches a real figure. */
export const MASK = '••••••••'
export const MASK_SHORT = '••••••'

/**
 * The date a UTXO was first observed — DATE ONLY, and deliberately so.
 *
 * ── WHY THERE IS NO TIME OF DAY ──────────────────────────────────────────────
 *
 * This labels when a complete scan first REPORTED an output, not when anybody sent it. Those can
 * be far apart: nothing is observed while the app is closed, so a payment made on Tuesday and
 * first seen on Friday is dated Friday. Rendering "14:32" beside it would claim a precision the
 * number does not have and would read as the moment the payment happened — which is the one thing
 * a first-seen must never be mistaken for. A bare date is honest about its own resolution.
 *
 * The year appears only when it is not the current one, so the common case stays short.
 */
export function firstSeenLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString([], sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * When a transaction happened on chain, in a list: HH:MM for a time today, "Oct 14" otherwise; "~"
 * when estimated from the epoch (crypto/txTimes); "—" when unknown. ONE rule for the Trade and
 * Burn pages, fed only by the indexer's time or the deterministic epoch estimate — never a device's
 * own record — so every device shows the same label.
 */
export function timeLabel(at: number | null, estimated = false, now = Date.now()): string {
  if (at === null) return '—'
  const d = new Date(at), today = new Date(now)
  const same = d.toDateString() === today.toDateString()
  const s = same
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${estimated ? '~' : ''}${s}`
}
