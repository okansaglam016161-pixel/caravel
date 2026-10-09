// The Burn page's arithmetic and wording — pure, so it can be tested without a network or a DOM.

import type { BurnClassification, BurnDeposit } from '../../crypto/burnWallet'
import { EPOCH_MS_APPROX } from '../../crypto/burnWallet'

const MICRO = 1_000_000n

/**
 * A typed TARI amount → µtTARI, EXACTLY. Null for anything that is not a plain positive decimal
 * with at most six places.
 *
 * No float anywhere: a burn is permanent and public, so the figure burned must be the figure typed,
 * not whatever `parseFloat` rounds it to.
 */
export function parseTariInput(input: string): bigint | null {
  const m = /^\s*(\d+)(?:\.(\d{0,6}))?\s*$/.exec(input)
  if (!m) return null
  const whole = BigInt(m[1])
  const frac = BigInt((m[2] ?? '').padEnd(6, '0'))
  const v = whole * MICRO + frac
  return v > 0n ? v : null
}

/** One row of the burns list. No addresses: who burned is never shown, only how. */
export interface BurnRow {
  txId: string
  amount: bigint
  source: 'public' | 'private' | 'unknown'
  /** A public burn from this wallet's own account, or a private burn this device journalled. */
  byYou: boolean
  /** When it happened, in epoch-ms, or null when not even an estimate is possible. */
  at: number | null
  /** False when `at` is estimated from the epoch it committed in. */
  exact: boolean
}

export interface RowContext {
  /** Every vault of this wallet's account — a public burn from one of them is ours. */
  ownVaults: ReadonlySet<string>
  /** Burns this device journalled, by transaction id, with when they were made. */
  journalled: ReadonlyMap<string, number>
  /** When each transaction finalised, while the indexer still has its body. */
  finalizedAt: ReadonlyMap<string, number | null>
  currentEpoch: number | null
  now: number
}

/** Deposits (newest first) and their receipts → rows. */
export function buildBurnRows(
  deposits: readonly BurnDeposit[],
  classes: ReadonlyMap<string, BurnClassification>,
  ctx: RowContext,
): BurnRow[] {
  return deposits.map(d => {
    const c = classes.get(d.txId)
    const source = c?.source ?? 'unknown'
    const mine = ctx.journalled.get(d.txId)
    const byYou = mine !== undefined
      || (source === 'public' && (c?.withdrawVaults ?? []).some(v => ctx.ownVaults.has(v)))
    const finalized = ctx.finalizedAt.get(d.txId) ?? null
    let at: number | null = mine ?? finalized
    let exact = at !== null
    if (at === null && c?.epoch != null && ctx.currentEpoch !== null) {
      at = ctx.now - Math.max(0, ctx.currentEpoch - c.epoch) * EPOCH_MS_APPROX
      exact = false
    }
    return { txId: d.txId, amount: d.amount, source, byYou, at, exact }
  })
}

/** The row's title — the only thing it says about who burned. */
export function burnTitle(row: BurnRow): string {
  if (row.byYou) return 'Burned by you'
  if (row.source === 'public') return 'Public burn'
  if (row.source === 'private') return 'Private burn'
  return 'Burn'
}

/**
 * When, in words. Exact times read like the rest of the app — "Today 14:32", "Yesterday 09:10",
 * "Mon 18:04", "3 Oct". An ESTIMATE says so and never carries a time of day it does not have.
 */
export function burnTimeLabel(at: number | null, exact: boolean, now = Date.now()): string {
  if (at === null) return 'Time unknown'
  if (!exact) {
    const hours = Math.max(0, Math.round((now - at) / 3_600_000))
    if (hours < 1) return 'Within the hour'
    if (hours < 36) return `About ${hours} hour${hours === 1 ? '' : 's'} ago`
    const days = Math.round(hours / 24)
    return `About ${days} days ago`
  }
  const d = new Date(at)
  const today = new Date(now)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const dayDiff = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000)
  if (dayDiff === 0) return `Today ${time}`
  if (dayDiff === 1) return `Yesterday ${time}`
  if (dayDiff > 1 && dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return d.toLocaleDateString([], d.getFullYear() === today.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Does the list account for every µtTARI in the verified total?
 *
 * The list comes from unverified indexer data; the total is verified. When the two agree to the
 * microtari the list is complete. When they do not, the indexer is still catching up (or holds
 * less than the chain), and the page says so rather than presenting a partial list as the whole.
 */
export function depositsComplete(deposits: readonly BurnDeposit[], verifiedTotal: bigint | null): boolean {
  if (verifiedTotal === null) return false
  return deposits.reduce((sum, d) => sum + d.amount, 0n) === verifiedTotal
}

/**
 * The supply a burn is measured against, in TARI.
 *
 * AN ADVERTISING REFERENCE FOR TESTNET, NOT A HARD CAP. Tari has tail emission, so supply keeps
 * growing past this figure and "% of supply" has no fixed denominator. Revisit before mainnet:
 * either the circulating supply at the time, or a different framing altogether.
 */
export const SUPPLY_REFERENCE = 21_000_000_000n

/** "21B" for 21,000,000,000 — the reference, short. */
export function compactSupply(tari: bigint = SUPPLY_REFERENCE): string {
  for (const [unit, size] of [['T', 10n ** 12n], ['B', 10n ** 9n], ['M', 10n ** 6n]] as const) {
    if (tari >= size && tari % (size / 10n) === 0n) {
      const whole = tari / size
      const tenth = (tari % size) / (size / 10n)
      return `${whole}${tenth ? `.${tenth}` : ''}${unit}`
    }
  }
  return tari.toLocaleString('en-US')
}

/**
 * What share of the reference supply `burnedMicrotari` is, as a percentage string WITHOUT the "%".
 *
 * Two significant figures, rounded half-up, however small — "0.0000048", "0.47", "12" — so a real
 * burn never reads as 0, and never in scientific notation. Exact bigint arithmetic throughout:
 * the figure is a quotient of two integers, and there is no float in it to round.
 */
export function formatSupplyPercent(burnedMicrotari: bigint, supplyTari: bigint = SUPPLY_REFERENCE): string {
  if (burnedMicrotari <= 0n) return '0'
  // percent = burned × 100 / (supply × 10⁶)
  const num = burnedMicrotari * 100n
  const den = supplyTari * MICRO

  // Find s with num/den × 10^s in [10, 100): two digits before the point.
  let s = 0
  const scaled = (k: number): [bigint, bigint] => (k >= 0 ? [num * 10n ** BigInt(k), den] : [num, den * 10n ** BigInt(-k)])
  for (;;) {
    const [n, d] = scaled(s)
    if (n < d * 10n) { s++; continue }
    if (n >= d * 100n) { s--; continue }
    break
  }
  const [n, d] = scaled(s)
  let q = (2n * n + d) / (2n * d)      // round half-up to an integer in [10, 100]
  if (q === 100n) { q = 10n; s-- }      // 99.5… rounded up a digit

  if (s <= 0) return (q * 10n ** BigInt(-s)).toLocaleString('en-US')
  const digits = q.toString().padStart(s + 1, '0')
  const out = `${digits.slice(0, digits.length - s)}.${digits.slice(digits.length - s)}`
  return out.replace(/0+$/, '').replace(/\.$/, '')
}

export function shortTx(txId: string): string {
  return txId.length > 14 ? `${txId.slice(0, 4)}…${txId.slice(-6)}` : txId
}
