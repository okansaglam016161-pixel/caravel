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

/**
 * Rounded display for prose — "12,847.50". Two decimals, grouped, BIGINT ONLY.
 *
 * Exists because the faucet had its own `Number(µt) / 1_000_000` doing this, which is the same
 * silent-rounding bug as any other float on an amount and was missed once already because it lived
 * in a panel rather than in crypto. There is now one place to do it.
 *
 * Rounds HALF-UP on the third decimal, in integer arithmetic: scale to hundredths, add half a
 * hundredth's worth of µtTARI, truncate.
 */
export function fmt2(microtari: bigint): string {
  const neg = microtari < 0n
  const v = neg ? -microtari : microtari
  const hundredths = (v + 5_000n) / 10_000n          // 12_847_503_210 → 1_284_750
  const whole = (hundredths / 100n).toLocaleString('en-US')
  const frac = (hundredths % 100n).toString().padStart(2, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

/** Masked stand-in used when the hide toggle is on. Width roughly matches a real figure. */
export const MASK = '••••••••'
export const MASK_SHORT = '••••••'

/**
 * How long is left, as words.
 *
 * General in the units so it stays correct if the cooldown ever changes — today it is 60 seconds,
 * so in practice this only ever shows seconds. Rounds UP, because a countdown that reads "0s"
 * while the button is still disabled is the one number it must not show.
 */
export function formatCooldown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

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
