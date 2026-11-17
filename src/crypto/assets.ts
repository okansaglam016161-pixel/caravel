// The assets Caravel knows about — THE ONE LIST, and the only place a resource address becomes a
// name, a ticker or a price. Today that is TARI alone.
//
// ── AN ALLOWLIST, NOT A DISCOVERY ────────────────────────────────────────────
//
// A stealth output carries no label. Anything the view key can open is "ours", and anyone can mint a
// token with any symbol and decimals in one transaction. So the wallet never shows a token because it
// found one: it shows the resources on this list, identified by ADDRESS, and nothing else. A
// look-alike has a different address and is simply not here.
//
// ── WHAT EACH ENTRY PROMISES ─────────────────────────────────────────────────
//
//   resource   the exact resource address — the identity. Everything else is presentation.
//   decimals   base units per whole token, as a power of ten. TARI's is 6: 1 = 1,000,000 units.
//   usdPrice   a FIXED display rate — the app's placeholder rate (v2/fiat). Not a market price.

import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'

export type AssetId = 'tari'

export interface ApprovedAsset {
  id: AssetId
  /** The resource address. THE identity — a token is this asset only if its address is this. */
  resource: string
  /** The resource address without `resource_`: the form `/utxos` and `utxo_<res>_<c>` ids use. */
  resourceHex: string
  ticker: string
  name: string
  decimals: number
  /** Fixed display rate in USD per whole token. Not a market price. */
  usdPrice: number
}

const hexOf = (resource: string) => resource.replace(/^resource_/, '')

export const TARI_ASSET: ApprovedAsset = {
  id: 'tari',
  resource: TARI_RESOURCE_ADDRESS,
  resourceHex: hexOf(TARI_RESOURCE_ADDRESS),
  ticker: 'TARI',
  name: 'Tari (testnet)',
  decimals: 6,
  // v2/fiat's placeholder (RATE_NUM / RATE_DEN = $0.0004). The hero still prices TARI through
  // fiat.ts; assets.test pins the two together so they cannot drift.
  usdPrice: 0.0004,
}

/** Every asset the wallet will show, in display order. */
export const APPROVED_ASSETS: readonly ApprovedAsset[] = [TARI_ASSET]

/** The approved asset with this resource address, or null — a look-alike is null. */
export function approvedAsset(resource: string): ApprovedAsset | null {
  const want = resource.startsWith('resource_') ? resource : `resource_${resource}`
  return APPROVED_ASSETS.find(a => a.resource === want) ?? null
}

/**
 * THE AMOUNT FORMATTER — every tTARI figure Caravel shows goes through this one function.
 *
 * Base units → the EXACT amount, grouped, with only trailing zeros dropped: `15194` → `0.015194`,
 * `100000` → `0.1`, `1000000` → `1`, `9998900000` → `9,998.9`, `10000000000` → `10,000`. Never rounds,
 * never truncates: every significant decimal up to the token's precision (six for TARI) is kept.
 * Input fields have their own ungrouped form (wallet/v2/format.toInput).
 */
export function formatUnits(units: bigint, decimals: number): string {
  const neg = units < 0n
  const abs = neg ? -units : units
  const scale = 10n ** BigInt(decimals)
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}
