// The assets Caravel knows about — THE ONE LIST, and the only place a resource address becomes a
// name, a ticker or a price.
//
// ── AN ALLOWLIST, NOT A DISCOVERY ────────────────────────────────────────────
//
// A stealth output carries no label. Anything the view key can open is "ours", and an attacker can
// mint a token called "cUSD" with the same symbol and decimals in one transaction (caravel-trade's
// red team does exactly that). So the wallet never shows a token because it found one: it shows
// the resources on this list, identified by ADDRESS, and nothing else. A look-alike has a different
// address and is simply not here.
//
// ── WHAT EACH ENTRY PROMISES ─────────────────────────────────────────────────
//
//   resource   the exact resource address — the identity. Everything else is presentation.
//   decimals   base units per whole token, as a power of ten. Both are 6: 1 = 1,000,000 units.
//   usdPrice   a FIXED display rate. TARI's is the app's placeholder rate (v2/fiat); cUSD is a
//              testnet dollar shown at $1 by definition. Neither is a market price.
//   actions    what the wallet may DO with it. cUSD is display-only until the Trade page: no
//              sends, burns or chat payments, because every one of those paths is TARI-specific
//              (fee probes, change, reconciliation) and has not been built for a second resource.
//
// The cUSD addresses are caravel-trade's live deployment (README, 2026-10-14, Ootle 0.46.1):
// a stealth resource with 6 decimals and a fixed supply, mint/burn/recall/freeze denied and locked.

import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'

export type AssetId = 'tari' | 'cusd'

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
  actions: { send: boolean; burn: boolean; chat: boolean }
}

/** caravel-trade's live cUSD (Caravel Test Dollar), created by the cUSD faucet on 2026-10-14. */
export const CUSD_RESOURCE_ADDRESS = 'resource_d1f7fb8d5a70b5a7c7aeb98aefd73d3f87bae5625acfe6f39a072f4c5ba4edea'

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
  actions: { send: true, burn: true, chat: true },
}

export const CUSD_ASSET: ApprovedAsset = {
  id: 'cusd',
  resource: CUSD_RESOURCE_ADDRESS,
  resourceHex: hexOf(CUSD_RESOURCE_ADDRESS),
  ticker: 'cUSD',
  name: 'Caravel Test Dollar',
  decimals: 6,
  usdPrice: 1,
  actions: { send: false, burn: false, chat: false },
}

/** Every asset the wallet will show, in display order. */
export const APPROVED_ASSETS: readonly ApprovedAsset[] = [TARI_ASSET, CUSD_ASSET]

/** The approved asset with this resource address, or null — a look-alike is null. */
export function approvedAsset(resource: string): ApprovedAsset | null {
  const want = resource.startsWith('resource_') ? resource : `resource_${resource}`
  return APPROVED_ASSETS.find(a => a.resource === want) ?? null
}

/**
 * THE AMOUNT FORMATTER — every tTARI and cUSD figure Caravel shows goes through this one function.
 *
 * Base units → the EXACT amount, grouped, with only trailing zeros dropped: `15194` → `0.015194`,
 * `100000` → `0.1`, `1000000` → `1`, `9998900000` → `9,998.9`, `10000000000` → `10,000`. Never rounds,
 * never truncates: every significant decimal up to the token's precision (six for both) is kept.
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

/**
 * The fixed-rate dollar value of `units`, to the cent. Exact for cUSD at $1 (integer arithmetic on
 * base units), so 10,000 cUSD is "$10,000.00" and never a float that rounds to $9,999.99.
 */
export function formatUsd(units: bigint, asset: ApprovedAsset): string {
  // Price as an integer number of micro-dollars per whole token keeps this exact for both rates.
  const microUsdPerToken = BigInt(Math.round(asset.usdPrice * 1_000_000))
  const scale = 10n ** BigInt(asset.decimals)
  const cents = (units * microUsdPerToken) / scale / 10_000n
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `$${whole}.${(cents % 100n).toString().padStart(2, '0')}`
}
