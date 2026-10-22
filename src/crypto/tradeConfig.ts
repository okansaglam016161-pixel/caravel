// The live Caravel Trade deployment (caravel-trade README, esmeralda, Ootle 0.46.1, created 2026-10-14
// by the deployer key 20db90bf…). Every address here was read back verified on both public indexers.
//
// Orders are not listed here: the Board creates one component per order. An order is believed only
// when its OWN state names this Board and this Board's badge and it runs the Order template below
// (crypto/tradeRead.orderLegitimacy) — only the Board holds the badge, so only the Board could have
// created it.

import { CUSD_ASSET } from './assets'

export const TRADE_BOARD_ADDRESS = 'component_278c4da6fd49c03d2735355241bbb29e01748712e2377657769bfbcc365c3bdc'
/** The Board's template — a component claiming to be the Board but running other code is not it. */
export const TRADE_BOARD_TEMPLATE = '6e9bb8eba68c45e3b5301e1f5ce2e350927cfbffc392c6ed39a4ddb550b8834f'
/** Every real order runs this template (Order, published 2026-10-14). */
export const TRADE_ORDER_TEMPLATE = '73aae2b35810bd46f471986baf797517a00b6a45e9eef924156b2edc4ae8d6d7'
/** The Board's badge (supply exactly 1, minting DenyAll + Locked): proof a real Board placed an order. */
export const TRADE_BOARD_BADGE = 'resource_279ed778dc054969303f7bec1cdc4db2fa410ef22238f98350f373f36faceb43'
/** Caravel's 0.7% (of the 1% trade fee) lands here. */
export const TRADE_CARAVEL_FEE_ACCOUNT = 'component_4c7dddbe61ec6e77430cc4398535d29e127c1f6d46be4500ce8f2ab164e422bc'
/** The 0.3% is burned: deposited into the Caravel Burn Wallet. */
export const TRADE_BURN_WALLET = 'component_2e91fb78b73440dd114bdbb887d256d760fa3be3276d7b833f4ab1b23d796029'
/** The quote token. */
export const TRADE_QUOTE = CUSD_ASSET.resource

export const SELL = 0
export const BUY = 1
export type OrderSide = typeof SELL | typeof BUY

export const ORDER_OPEN = 0
export const ORDER_FILLED = 1
export const ORDER_CANCELLED = 2
export type OrderStatus = typeof ORDER_OPEN | typeof ORDER_FILLED | typeof ORDER_CANCELLED

/** The smallest order the Board takes (its `min_order`, 1 tTARI). Read live too; this is the floor the UI states. */
export const MIN_ORDER_MICROTARI = 1_000_000n

/** How a side of a trade is funded or paid: a private coin, or the public account. */
export type TradeMode = 'private' | 'public'
