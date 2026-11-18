// TARI amounts for display. Bigint-only: amounts are 128-bit on the wire, and a float divide drifts
// on a large one. Raw units are micro-TARI (six decimals).

import { formatBalance } from './provider'

/** The unit name every amount is shown in. Display only — nothing stored or sent carries it. */
export const TICKER = 'TARI'

/** Micro-TARI → "12,847.50321", "0.015194", "1": exact, grouped, trailing zeros dropped. */
export function formatTari(micro: bigint): string {
  return formatBalance({ amount: micro, divisibility: 6 })
}
