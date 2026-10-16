// The apps the Burn page knows by name. A burn whose receipt carries events from one of these
// templates was made by that app (crypto/burnWallet.classifyBurnReceipt → `appTemplates`); any other
// contract is an "App burn" from an unknown app. Adding an app is one line here.

import { TRADE_BOARD_TEMPLATE, TRADE_ORDER_TEMPLATE } from '../../crypto/tradeConfig'

export interface BurnApp {
  /** The row's title. */
  name: string
  /** The row's detail, where a person's burn says Private or Public. */
  detail: string
}

const CARAVEL_TRADE: BurnApp = { name: 'Caravel Trade burn', detail: 'Trading fee' }

/** By template address. */
export const KNOWN_BURN_APPS: ReadonlyMap<string, BurnApp> = new Map([
  [TRADE_ORDER_TEMPLATE, CARAVEL_TRADE],   // an order paying the 0.3% of its fill
  [TRADE_BOARD_TEMPLATE, CARAVEL_TRADE],
])

export const UNKNOWN_BURN_APP: BurnApp = { name: 'App burn', detail: 'Unknown app' }

/** The app behind a burn, from its receipt's app templates; null when a person burned directly. */
export function burnAppOf(appTemplates: readonly string[]): BurnApp | null {
  for (const t of appTemplates) {
    const known = KNOWN_BURN_APPS.get(t)
    if (known) return known
  }
  return appTemplates.length > 0 ? UNKNOWN_BURN_APP : null
}
