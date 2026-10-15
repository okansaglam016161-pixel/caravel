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
import { QuoteChanged } from '../../crypto/quote'
import { SELL, type OrderSide } from '../../crypto/tradeConfig'
import { fmt6 } from '../wallet/v2/format'

/** The testnet token, as the Trade design names it everywhere (the wallet's shared TICKER says TARI). */
export const TTARI = 'tTARI'

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

export const fmtTari = (micro: bigint) => `${fmt6(micro)} ${TTARI}`
/** cUSD with at least two decimals: "2.20", "1,000.50", "0.000001". */
export function fmtCusd(units: bigint): string {
  const s = formatUnits(units, CUSD_ASSET.decimals)
  const [w, f = ''] = s.split('.')
  return `${w}.${f.padEnd(2, '0')}`
}
export const fmtCusdWithUnit = (units: bigint) => `${fmtCusd(units)} ${CUSD_ASSET.ticker}`
/** cUSD's dollar value — exact (cUSD is $1). */
export const usdOf = (units: bigint) => formatUsd(units, CUSD_ASSET)
/** A price per tTARI: "2.2", "1.666666…" when it does not end at six decimals. */
export const fmtPrice = (price: Price) => `${formatUnits(price.micro, CUSD_ASSET.decimals)}${price.exact ? '' : '…'}`

export interface Row { k: string; v: string; strong?: boolean; positive?: boolean }

/** The 1% trade fee line: always tTARI, with its two shares. */
export function feeLine(fee: bigint, caravelCut: bigint, burnCut: bigint): string {
  return `${fmtTari(fee)} · ${fmt6(caravelCut)} Caravel, ${fmt6(burnCut)} burned`
}

/**
 * What placing an order means, before the network fee is priced. SELL: you are paid the FULL cUSD
 * total, the buyer receives N − 1% tTARI. BUY: you pay the cUSD total and receive N − 1% tTARI.
 */
export function placeRows(side: OrderSide, n: bigint, p: bigint, split: { fee: bigint; caravelCut: bigint; burnCut: bigint } | null): Row[] {
  const net = split ? n - split.fee : null
  const fee: Row = { k: '1% trade fee', v: split ? feeLine(split.fee, split.caravelCut, split.burnCut) : '—' }
  return side === SELL
    ? [
        { k: 'You receive', v: fmtCusdWithUnit(p), strong: true },
        { k: 'Buyer receives', v: net === null ? '—' : fmtTari(net) },
        fee,
      ]
    : [
        { k: 'You pay', v: fmtCusdWithUnit(p), strong: true },
        { k: 'You receive', v: net === null ? '—' : fmtTari(net), positive: true },
        fee,
      ]
}

/**
 * What filling a book order means for the taker. From a SELL order: pay P cUSD, receive N − 1% tTARI.
 * Into a BUY order: pay N tTARI — the 1% comes out of it, so the buyer receives N − 1% — and receive
 * the FULL P cUSD.
 */
export function fillRows(e: Pick<BookEntry, 'side' | 'n' | 'p' | 'fee' | 'caravelCut' | 'burnCut'>): Row[] {
  const fee = feeLine(e.fee, e.caravelCut, e.burnCut)
  return e.side === SELL
    ? [
        { k: 'You pay', v: fmtCusdWithUnit(e.p), strong: true },
        { k: 'Trade fee 1%', v: fee },
        { k: 'You receive', v: fmtTari(e.n - e.fee), strong: true, positive: true },
      ]
    : [
        { k: 'You pay', v: fmtTari(e.n), strong: true },
        { k: 'Trade fee 1%', v: `${fee} · from the tTARI you pay; the buyer receives ${fmtTari(e.n - e.fee)}` },
        { k: 'You receive', v: fmtCusdWithUnit(e.p), strong: true, positive: true },
      ]
}

/**
 * Was this refusal "somebody got there first"? The order is no longer open (checked before pricing),
 * moved between review and confirm (the version a fill pins), or its payout now exists. Every one of
 * these is refused before anything is charged.
 */
export function isTaken(e: unknown): boolean {
  if (e instanceof QuoteChanged) return e.reason === 'inputs-gone'
  const m = e instanceof Error ? e.message : String(e)
  return /no longer open|does not exist|payout output already exists|terms are not the ones/i.test(m)
}

/** HH:MM for a time today, "Oct 14" otherwise; "~" when estimated from the epoch; "—" when unknown. */
export function timeLabel(at: number | null, estimated = false, now = Date.now()): string {
  if (at === null) return '—'
  const d = new Date(at), today = new Date(now)
  const same = d.toDateString() === today.toDateString()
  const s = same
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${estimated ? '~' : ''}${s}`
}

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
  const title = `${sell ? 'Sell' : 'Buy'} ${fmt6(m.n)} ${TTARI} @ ${fmtPrice(m.price)}`
  const placed = m.placedAt !== null ? ` · placed ${timeLabel(m.placedAt)}` : ''
  if (!m.confirmed) {
    return { key: m.orderId, side: sell ? 'SELL' : 'BUY', title, sub: `Checking on chain · last seen ${m.state}`, status: 'Unconfirmed', canCancel: false }
  }
  if (m.state === 'open') {
    return { key: m.orderId, side: sell ? 'SELL' : 'BUY', title, sub: `Total ${fmtCusdWithUnit(m.p)}${placed}`, status: 'Open', canCancel: m.cancelIndex !== null }
  }
  if (m.state === 'filled') {
    // The seller of tTARI was paid the full cUSD; the buyer received N − 1% tTARI.
    const got = sell ? `${fmtCusdWithUnit(m.p)} received` : `${fmtTari(m.n - m.fee)} received`
    return { key: m.orderId, side: sell ? 'SELL' : 'BUY', title, sub: `Filled · ${got}`, status: 'Filled', canCancel: false }
  }
  return { key: m.orderId, side: sell ? 'SELL' : 'BUY', title, sub: 'Cancelled · everything returned', status: 'Cancelled', canCancel: false }
}

export interface TradeRowView { key: string; side: 'Buy' | 'Sell'; amount: string; price: string; time: string; yours: boolean }

/** A market fill from the TAKER's side: a filled SELL order was a Buy; a filled BUY order a Sell. */
export function tradeRowView(t: RecentTrade, now = Date.now()): TradeRowView {
  return {
    key: t.txId, side: t.side === SELL ? 'Buy' : 'Sell', amount: fmt6(t.n), price: fmtPrice(t.price),
    time: timeLabel(t.at, t.atEstimated, now), yours: t.yours !== null,
  }
}
