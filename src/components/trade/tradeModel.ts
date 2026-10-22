// The Trade page's view model: parsing what a person types, and turning the market's exact figures
// into the words and numbers the page shows. Pure — the page and sheet only render what this says.
//
// ── THE RULES THESE STRINGS MUST NOT BEND ────────────────────────────────────
//
//   The 1% trade fee is ALWAYS tTARI (0.7% Caravel, 0.3% burned) — never cUSD.
//   Whoever RECEIVES tTARI gets N − 1%. Whoever SELLS tTARI gets the FULL cUSD total.
//   A network fee is shown only once it has been priced (a live quote) — never an example figure.
//   cUSD is shown with its dollar value, "≈ $X" (cUSD is $1).
//
// The trade fee figures come from the order itself (an open order's fee was fixed when it was
// placed) or, for a new order, from the Board's live settings — both through crypto/trade's own
// tradeFeeSplit, so the page cannot round differently from the contract.

import { CUSD_ASSET, formatUnits, formatUsd } from '../../crypto/assets'
import type { BookEntry, MyOrder, Price, RecentTrade } from '../../crypto/market'
import { NO_PUBLIC_BALANCE, OrderTaken } from '../../crypto/trade'
import { SELL, type OrderSide } from '../../crypto/tradeConfig'
import { TICKER, fmt6, timeLabel } from '../wallet/v2/format'

const MICRO = 1_000_000n

/** tTARI as typed: up to six decimals, positive. Null when it is not an amount. */
export function parseTari(input: string): bigint | null {
  const m = /^\s*(\d+)(?:\.(\d{0,6}))?\s*$/.exec(input)
  if (!m) return null
  const v = BigInt(m[1]) * MICRO + BigInt((m[2] ?? '').padEnd(6, '0'))
  return v > 0n ? v : null
}

/** A price in cUSD per tTARI as typed (up to six decimals), in cUSD base units. Null when not a price. */
export function parsePrice(input: string): bigint | null {
  return parseTari(input)   // same shape: six decimals, positive
}

/**
 * The cUSD total of N µtTARI at `price` (base units per whole tTARI): P = N × price, floored to cUSD's
 * six decimals. `exact` false when it had to round — the order then trades at exactly P, which the
 * page states rather than the typed price.
 */
export function orderTotal(n: bigint, price: bigint): { p: bigint; exact: boolean } {
  const scaled = n * price
  return { p: scaled / MICRO, exact: scaled % MICRO === 0n }
}

export const fmtTari = (micro: bigint) => `${fmt6(micro)} ${TICKER}`
/** A cUSD amount — the shared exact form: "2.2", "1,000.5", "0.000001", "10,000". */
export function fmtCusd(units: bigint): string {
  return formatUnits(units, CUSD_ASSET.decimals)
}
export const fmtCusdWithUnit = (units: bigint) => `${fmtCusd(units)} ${CUSD_ASSET.ticker}`
/** cUSD's dollar value — exact (cUSD is $1). */
export const usdOf = (units: bigint) => formatUsd(units, CUSD_ASSET)
/**
 * A price per tTARI, exact: "2.2", "1.5". Only a ratio that does not END within cUSD's six decimals
 * (P/N = 2.5/1.5 = 1.6666…) is cut, at six places with "…" — and priceTitle gives its exact terms.
 */
export const fmtPrice = (price: Price) => `${formatUnits(price.micro, CUSD_ASSET.decimals)}${price.exact ? '' : '…'}`

/** The full value behind a price, for hover: exact when the price is, the order's terms when cut. */
export function priceTitle(n: bigint, p: bigint, price: Price): string {
  return price.exact ? `${fmtPrice(price)} cUSD per ${TICKER}` : `${fmtCusd(p)} cUSD for ${fmt6(n)} ${TICKER}`
}

export interface Row {
  k: string
  v: string
  strong?: boolean
  positive?: boolean
  /** A small explanatory line under the figures, not a figure (`k` is unused). */
  note?: boolean
}

/** The one line that stands for the whole fee breakdown on a trade sheet. */
export const TRADING_FEE_NOTE = 'Includes 1% trading fee'

/**
 * What placing an order means — what you give and what you get. SELL: you are paid the FULL cUSD
 * total; the buyer receives N − 1% tTARI. BUY: you pay the cUSD total and receive N − 1% tTARI. The
 * fee is always tTARI; `split` is the order's (or the Board's live) fee, null while unknown.
 */
export function placeRows(side: OrderSide, n: bigint, p: bigint, split: { fee: bigint } | null): Row[] {
  const net = split ? fmtTari(n - split.fee) : '—'
  return side === SELL
    ? [
        { k: 'You receive', v: fmtCusdWithUnit(p), strong: true, positive: true },
        { k: '', v: `Buyer receives ${net} after the 1% trading fee`, note: true },
      ]
    : [
        { k: 'You pay', v: fmtCusdWithUnit(p), strong: true },
        { k: 'You receive', v: net, strong: true, positive: true },
        { k: '', v: TRADING_FEE_NOTE, note: true },
      ]
}

/**
 * What filling a book order means for the taker. From a SELL order: pay P cUSD, receive N − 1% tTARI.
 * Into a BUY order: pay N tTARI (the 1% comes out of it — the buyer receives N − 1%) and receive the
 * FULL P cUSD.
 */
export function fillRows(e: Pick<BookEntry, 'side' | 'n' | 'p' | 'fee'>): Row[] {
  return e.side === SELL
    ? [
        { k: 'You pay', v: fmtCusdWithUnit(e.p), strong: true },
        { k: 'You receive', v: fmtTari(e.n - e.fee), strong: true, positive: true },
        { k: '', v: TRADING_FEE_NOTE, note: true },
      ]
    : [
        { k: 'You pay', v: fmtTari(e.n), strong: true },
        { k: 'You receive', v: fmtCusdWithUnit(e.p), strong: true, positive: true },
        { k: '', v: TRADING_FEE_NOTE, note: true },
      ]
}

/** "1.000000 tTARI @ 2.5" — an order's terms in one line. */
export function termsLine(n: bigint, p: bigint): string {
  return `${fmtTari(n)} @ ${fmtPrice({ micro: (p * MICRO) / n, exact: (p * MICRO) % n === 0n })}`
}

export const NETWORK_MESSAGE = 'Can’t reach the network. Nothing was sent. Try again in a moment.'
export const INSUFFICIENT_MESSAGE = 'Insufficient balance.'

/**
 * Any refusal or failure, in plain words. No internal names, no network jargon, no raw error text:
 * what happened, that nothing was sent, and what to do. (A taken order has its own state — isTaken.)
 */
export function tradeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/locked/i.test(m) && /unlock/i.test(m)) return 'Your wallet is locked. Unlock it to trade.'
  if (/smallest order/i.test(m)) return `The smallest order is 1 ${TICKER}.`
  if (m === NO_PUBLIC_BALANCE) return NO_PUBLIC_BALANCE
  if (/not enough|no public account|must leave change|too small|insufficient/i.test(m)) return INSUFFICIENT_MESSAGE
  if (/paused/i.test(m)) return 'New orders are paused right now. Nothing was sent. Try again later.'
  if (/kept changing/i.test(m)) return 'The network fee kept changing. Nothing was sent. Try again in a moment.'
  if (/fee .*(above|exceeds)|reserves|unusually high/i.test(m)) return 'The network fee is unusually high right now. Nothing was sent. Try again later.'
  if (/cancel key/i.test(m)) return 'This order can’t be cancelled from this wallet.'
  if (/not a caravel trade order|not placed by|badge|not the one this app trusts|wrong template|exactly one way|fee does not add up|not quoted|not positive|not an order address/i.test(m)) {
    return 'This order isn’t available.'
  }
  if (/could not|couldn’t|can.t reach|no indexer|failed to fetch|network|indexer|did not respond|timed? ?out|busy|verified|try again in a moment/i.test(m)) return NETWORK_MESSAGE
  return 'Something went wrong. Nothing was sent. Try again in a moment.'
}

/**
 * Was this refusal "somebody got there first"? Only when it is about the ORDER: gone, closed, its terms
 * changed, its payout already made, or its pinned version moved between review and confirm — each an
 * OrderTaken from crypto/trade, refused before anything is charged. A missing input that is the
 * trader's own (its coins, its account) is an ordinary error, never "taken".
 */
export function isTaken(e: unknown): boolean {
  return e instanceof OrderTaken
}

/**
 * A fill the network turned down after it was sent: "taken" only when the reason names the order
 * itself (it moved, or is down), never one of the taker's own inputs.
 */
export function isTakenReject(reason: string | undefined, orderId: string): boolean {
  return !!reason && reason.includes(orderId.replace(/^component_/, '')) && /no longer open|version|FailedToLock|is down/i.test(reason)
}

/** The shared chain-time label (wallet/v2/format.timeLabel), re-exported for the Trade page. */
export { timeLabel }

export interface MyOrderView {
  key: string
  side: 'SELL' | 'BUY'
  title: string
  sub: string
  status: 'Open' | 'Filled' | 'Cancelled' | 'Unconfirmed'
  canCancel: boolean
}

export function myOrderView(m: MyOrder): MyOrderView {
  const sell = m.side === SELL
  const title = `${sell ? 'Sell' : 'Buy'} ${fmt6(m.n)} ${TICKER} @ ${fmtPrice(m.price)}`
  const placed = m.placedAt !== null ? ` · placed ${timeLabel(m.placedAt, m.placedEstimated)}` : ''
  if (!m.confirmed) {
    return { key: m.orderId, side: sell ? 'SELL' : 'BUY', title, sub: `Waiting for confirmation${placed}`, status: 'Unconfirmed', canCancel: false }
  }
  if (m.state === 'open') {
    return { key: m.orderId, side: sell ? 'SELL' : 'BUY', title, sub: `Total ${fmtCusdWithUnit(m.p)}${placed}`, status: 'Open', canCancel: m.cancelIndex !== null }
  }
  // When it closed — the filling or cancelling transaction's indexer time ("~" only if estimated).
  const when = m.closedAt !== null ? ` · ${timeLabel(m.closedAt, m.closedEstimated)}` : ''
  if (m.state === 'filled') {
    // The seller of tTARI was paid the full cUSD; the buyer received N − 1% tTARI.
    const got = sell ? `${fmtCusdWithUnit(m.p)} received` : `${fmtTari(m.n - m.fee)} received`
    return { key: m.orderId, side: sell ? 'SELL' : 'BUY', title, sub: `Filled · ${got}${when}`, status: 'Filled', canCancel: false }
  }
  return { key: m.orderId, side: sell ? 'SELL' : 'BUY', title, sub: `Cancelled · everything returned${when}`, status: 'Cancelled', canCancel: false }
}

export interface TradeRowView { key: string; side: 'Buy' | 'Sell'; amount: string; price: string; time: string; yours: boolean }

/** A market fill from the TAKER's side: a filled SELL order was a Buy; a filled BUY order a Sell. */
export function tradeRowView(t: RecentTrade, now = Date.now()): TradeRowView {
  return {
    key: t.txId, side: t.side === SELL ? 'Buy' : 'Sell', amount: fmt6(t.n), price: fmtPrice(t.price),
    time: timeLabel(t.at, t.atEstimated, now), yours: t.yours !== null,
  }
}
