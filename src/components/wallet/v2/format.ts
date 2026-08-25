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

const MICRO = 1_000_000n

/** Full-precision display: grouped whole part, always six decimals. "12,847.503210" */
export function fmt6(microtari: bigint): string {
  const neg = microtari < 0n
  const v = neg ? -microtari : microtari
  const whole = (v / MICRO).toLocaleString('en-US')
  const frac = (v % MICRO).toString().padStart(6, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

/**
 * Amount-ENTRY form: full precision, no grouping, trailing zeros trimmed. "999.997686"
 *
 * Distinct from fmt6, which always pads to six places for column alignment. Grouping separators
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
