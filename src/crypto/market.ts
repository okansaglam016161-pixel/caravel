// Caravel Trade, read: the ORDER BOOK, this wallet's ORDERS, and RECENT TRADES across the market.
//
// The port of caravel-trade live.ts `book()`, made safe to show a person and cheap to repeat.
//
// ── WHAT GETS ON THE BOOK ────────────────────────────────────────────────────
//
// Orders are DISCOVERED from the Board's OrderPlaced events (a hint — anyone can read them, and the
// listing can lag), then each is READ VERIFIED and must pass all of:
//
//   legitimate   the Order template, naming THIS Board, THIS Board's badge, quoting cUSD
//                (tradeRead.orderLegitimacy — only the Board holds the badge, so only the Board could
//                have made it)
//   open         status OPEN on the verified read
//   payable      a private payout's single output must not already exist on either indexer
//                (tradeRead.checkPayout) — a copied statement can never be filled
//
// Anything that fails, or cannot be read verified right now, is HIDDEN. Never shown "with a warning":
// a book is something people click on.
//
// ── PRICES, EXACTLY ──────────────────────────────────────────────────────────
//
// An order is N tTARI against P cUSD (both 6 decimals), so its price is the ratio P/N cUSD per tTARI.
// Sorting compares the ratios EXACTLY (cross-multiplied bigints), never rounded figures. The price
// shown is P/N to the cUSD's 6 decimals, flagged `exact: false` when the ratio does not end there.
// Sells sort cheapest first, buys dearest first; the spread is best sell − best buy (negative = the
// book is crossed). "You receive" is what the TAKER gets after the 1% trade fee: N − fee tTARI from a
// sell order (the fee is on the tTARI side), P cUSD from a buy order (the maker's N pays the fee).
//
// ── KEEPING THE INDEXERS HAPPY ───────────────────────────────────────────────
//
// One refresh is: the Board (verified, reused for a minute), one events page, a verified read of each
// order NOT already known to be filled or cancelled (those never change, so they are read once ever),
// a payout check per open private-payout order (reused for a minute; an existing output is final), one
// fills query, and the time of each NEW fill (read once). At most READ_CONCURRENCY requests in flight.
// The poll cadence and back-off live in crypto/marketFeed.
//
// ── MINE ─────────────────────────────────────────────────────────────────────
//
// An order is this wallet's when its cancel rule names one of the wallet's seed-derived cancel keys
// (derivation.cancelKeyFor). Matched against every discovered order on every refresh, so it works
// after a restore and across devices with no local record; matches are written to crypto/tradeStore.

import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import { CUSD_ASSET } from './assets'
import { currentEpoch, estimateEpochTime, parseTxCreatedAt } from './burnWallet'
import { verifiedRead, type VerifiedReader } from './cusdScan'
import { cancelKeyFor } from './derivation'
import { INDEXER_URLS, POINT_READ_TIMEOUT_MS, pointRead } from './indexerConfig'
import { fetchWithRetry } from './indexerRetry'
import {
  ORDER_CANCELLED, ORDER_FILLED, ORDER_OPEN, SELL, TRADE_ORDER_TEMPLATE, type OrderSide,
} from './tradeConfig'
import { checkPayout, listBoardOrderIds, orderLegitimacy, readBoard, readOrder, readOrderUnverified, type BoardInfo, type OrderInfo, type PayoutCheck } from './tradeRead'
import { loadTradeState, observeOrder, recordRecovery, type OrderState, type TradeRecord } from './tradeStore'

const TARI = TARI_RESOURCE_ADDRESS
const CUSD = CUSD_ASSET.resource

/** 1 tTARI in µtTARI — a price is quoted per whole tTARI. */
export const PRICE_SCALE = 1_000_000n

// ── Pure: prices, legs, the book ─────────────────────────────────────────────

export interface Price {
  /** cUSD base units per 1 tTARI (floor). */
  micro: bigint
  /** False when P/N has more digits than cUSD's six: `micro` is then rounded DOWN. */
  exact: boolean
}

/** P/N, in cUSD base units per whole tTARI. */
export function pricePerTari(n: bigint, p: bigint): Price {
  const scaled = p * PRICE_SCALE
  return { micro: scaled / n, exact: scaled % n === 0n }
}

/** Sign of priceA − priceB, compared exactly (pA/nA vs pB/nB, cross-multiplied). */
export function comparePrice(a: { n: bigint; p: bigint }, b: { n: bigint; p: bigint }): number {
  const l = a.p * b.n, r = b.p * a.n
  return l < r ? -1 : l > r ? 1 : 0
}

export interface Leg { resource: string; amount: bigint }

/** What a TAKER pays and receives filling `o` — the receive is after the 1% trade fee. */
export function takerLegs(o: Pick<OrderInfo, 'side' | 'n' | 'p' | 'fee'>): { pays: Leg; receives: Leg } {
  return o.side === SELL
    ? { pays: { resource: CUSD, amount: o.p }, receives: { resource: TARI, amount: o.n - o.fee } }
    : { pays: { resource: TARI, amount: o.n }, receives: { resource: CUSD, amount: o.p } }
}

export interface BookEntry {
  orderId: string
  side: OrderSide
  /** tTARI side, µtTARI; cUSD side, base units. */
  n: bigint
  p: bigint
  /** The 1% trade fee (on the tTARI side), and its shares as the order fixed them at placement. */
  fee: bigint
  caravelCut: bigint
  burnCut: bigint
  /** The version the verified read saw — what a fill pins. */
  version: number
  price: Price
  /** The taker's legs: what filling it costs and returns (after the trade fee). */
  pays: Leg
  receives: Leg
  /** This wallet's own order: the book offers Cancel, not Buy/Sell. */
  yours: boolean
  /**
   * Read VERIFIED. False only for this wallet's own just-placed order, shown from a plain read before
   * the indexer serves it verified — "confirming", with no Cancel until it is.
   */
  confirmed: boolean
  /** Its cancel key index when `yours`. */
  cancelIndex: number | null
  /** Discovery order — the tie-breaker: at one price, the older order first. */
  seq: number
}

export interface Book {
  /** Sell orders (they sell tTARI for cUSD): cheapest first. */
  sells: BookEntry[]
  /** Buy orders (they buy tTARI with cUSD): dearest first. */
  buys: BookEntry[]
  /** Best sell − best buy, per tTARI. Null without both sides. Negative when the book is crossed. */
  spread: Price | null
}

export function toBookEntry(o: OrderInfo, seq: number, mine: ReadonlyMap<string, number>, confirmed = true): BookEntry {
  const { pays, receives } = takerLegs(o)
  const cancelIndex = mine.get(o.id) ?? null
  return {
    confirmed,
    orderId: o.id, side: o.side, n: o.n, p: o.p, fee: o.fee, caravelCut: o.caravelCut, burnCut: o.burnCut, version: o.version,
    price: pricePerTari(o.n, o.p), pays, receives, yours: cancelIndex !== null, cancelIndex, seq,
  }
}

/** Exact spread between the best sell and the best buy, per tTARI (floored toward −∞ on a remainder). */
export function spreadOf(bestSell: { n: bigint; p: bigint }, bestBuy: { n: bigint; p: bigint }): Price {
  const num = (bestSell.p * bestBuy.n - bestBuy.p * bestSell.n) * PRICE_SCALE
  const den = bestSell.n * bestBuy.n
  let q = num / den
  if (num % den !== 0n && num < 0n) q -= 1n
  return { micro: q, exact: num % den === 0n }
}

export function buildBook(entries: readonly BookEntry[]): Book {
  const sells = entries.filter(e => e.side === SELL).sort((a, b) => comparePrice(a, b) || a.seq - b.seq)
  const buys = entries.filter(e => e.side !== SELL).sort((a, b) => comparePrice(b, a) || a.seq - b.seq)
  return { sells, buys, spread: sells.length && buys.length ? spreadOf(sells[0], buys[0]) : null }
}

// ── Pure: recent trades ──────────────────────────────────────────────────────

export interface RecentTrade {
  orderId: string
  txId: string
  /** The ORDER's side: a SELL order filled = someone bought tTARI; a BUY order filled = someone sold. */
  side: OrderSide
  n: bigint
  p: bigint
  price: Price
  /** When it was made (epoch-ms): the transaction's created_at, else estimated from its epoch, else null. */
  at: number | null
  atEstimated: boolean
  /** This wallet's part in it: the maker (our order), the taker (our fill), or neither. */
  yours: 'maker' | 'taker' | null
}

const FILLED_TOPIC = 'CaravelTradeOrder.Filled'

/**
 * Fill events from one `/transactions/events?topic=…` page, kept only when the ENGINE says they came
 * from a legitimate order: the topic is just a name any template can emit, while the component and
 * template on an event are set by the engine. Newest first, one per order.
 *
 * `legit` is every order this reader has EVER read verified and found legitimate — its terms never
 * change, and the event itself is what proves the fill. So a fill counts even while the order's newly
 * written state is not yet served verified (measured: minutes after a fill, both indexers answered the
 * filled order with `verified: false`).
 */
export function parseFillEvents(page: unknown, legit: ReadonlyMap<string, OrderInfo>): { orderId: string; txId: string }[] {
  const events = (page as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return []
  const out: { orderId: string; txId: string }[] = []
  const seen = new Set<string>()
  for (const entry of events) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [txId, e] = entry as [unknown, { substate_id?: unknown; template_address?: unknown; topic?: unknown }]
    if (typeof txId !== 'string' || !e || e.topic !== FILLED_TOPIC || e.template_address !== TRADE_ORDER_TEMPLATE) continue
    const id = e.substate_id
    if (typeof id !== 'string' || seen.has(id)) continue
    if (!legit.has(id)) continue
    seen.add(id)
    out.push({ orderId: id, txId })
  }
  return out
}

// ── Pure: my orders ──────────────────────────────────────────────────────────

export interface MyOrder {
  orderId: string
  side: OrderSide
  n: bigint
  p: bigint
  /** The order's 1% trade fee (tTARI), as fixed at placement. */
  fee: bigint
  price: Price
  state: OrderState
  /**
   * Was `state` read VERIFIED in this refresh? False: the order could not be read verified just now
   * (a freshly written order is served unverified for a while), and `state` is the last one known —
   * or `filled` when its fill event is already in. Show it as "checking", not as fact.
   */
  confirmed: boolean
  /** The cancel key index — what a Cancel needs. */
  cancelIndex: number | null
  /** When it was placed here (journalled), or null for an order recovered from the chain. */
  placedAt: number | null
}

/**
 * This wallet's placed orders, open first (newest first within each state). `chain`: orders read
 * verified THIS refresh; `lastKnown`: any earlier verified read; `filledIds`: orders whose fill event
 * is in. The verified read wins; without one the state is unconfirmed.
 */
export function myOrdersFrom(
  records: readonly TradeRecord[],
  chain: ReadonlyMap<string, OrderInfo>,
  lastKnown: ReadonlyMap<string, OrderInfo> = new Map(),
  filledIds: ReadonlySet<string> = new Set(),
): MyOrder[] {
  const rank: Record<OrderState, number> = { open: 0, filled: 1, cancelled: 2 }
  const out: MyOrder[] = []
  for (const r of records) {
    if (r.action !== 'place' || !r.orderId || (r.outcome !== null && r.outcome !== 'committed')) continue
    const now = chain.get(r.orderId)
    const before = lastKnown.get(r.orderId)
    const state: OrderState | null = now ? stateOf(now)
      : filledIds.has(r.orderId) ? 'filled'
      : before ? stateOf(before) : r.orderState
    if (!state) continue
    out.push({
      orderId: r.orderId, side: r.side, n: r.n, p: r.p, fee: (now ?? before)?.fee ?? r.tradeFee, price: pricePerTari(r.n, r.p), state, confirmed: !!now,
      cancelIndex: r.cancelIndex, placedAt: r.journalId.startsWith('recovered-') ? null : r.at,
    })
  }
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (b.placedAt ?? 0) - (a.placedAt ?? 0))
}

function stateOf(o: OrderInfo): OrderState {
  return o.status === ORDER_FILLED ? 'filled' : o.status === ORDER_CANCELLED ? 'cancelled' : 'open'
}

// ── The reader ───────────────────────────────────────────────────────────────

export interface MarketData {
  book: Book
  mine: MyOrder[]
  /** Newest first. Null when the fills could not be read this time (the book is unaffected). */
  recent: RecentTrade[] | null
  /** Orders discovered but not shown, by reason. Diagnostic. */
  hidden: { reason: string; orderId: string }[]
  /** Orders discovered on the Board. */
  discovered: number
  board: BoardInfo
  /** When this data was read (epoch-ms). */
  at: number
}

export class MarketUnreachable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketUnreachable'
  }
}

/** At most this many requests in flight in one refresh. */
export const READ_CONCURRENCY = 3
/** How long a Board read and a "payout output is free" answer are reused. */
export const REUSE_MS = 60_000
/** Recent trades shown. */
export const RECENT_LIMIT = 50
/** How far past the last cancel key in use to look for this wallet's orders. */
export const CANCEL_KEY_LOOKAHEAD = 20

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

export interface MarketReaderOptions {
  /** This wallet, to find its own orders; omit both for a book with no "yours". */
  walletAddress?: string | null
  tradeRoot?: Uint8Array | null
  read?: VerifiedReader
  now?: () => number
}

/**
 * Keeps what never changes between refreshes: filled/cancelled orders, existing payout outputs, fill
 * times, derived cancel keys. One per wallet (crypto/marketFeed).
 */
export class MarketReader {
  private readonly opts: MarketReaderOptions
  private readonly orders = new Map<string, OrderInfo>()
  /** Every order ever read verified AND legitimate — terms are immutable, so this never goes stale. */
  private readonly legitSeen = new Map<string, OrderInfo>()
  private readonly payout = new Map<string, { check: PayoutCheck; at: number }>()
  private readonly fillTimes = new Map<string, { at: number | null; estimated: boolean }>()
  private board: { info: BoardInfo; at: number } | null = null
  private cancelKeys: string[] = []

  constructor(opts: MarketReaderOptions = {}) { this.opts = opts }

  private get now() { return (this.opts.now ?? Date.now)() }
  private get read() { return this.opts.read ?? verifiedRead }

  private async boardInfo(): Promise<BoardInfo> {
    if (this.board && this.now - this.board.at < REUSE_MS) return this.board.info
    try {
      const info = await readBoard(this.read)
      this.board = { info, at: this.now }
      return info
    } catch (e) {
      throw new MarketUnreachable(e instanceof Error ? e.message : 'The trade Board could not be read.')
    }
  }

  /** The verified order, re-read unless already filled or cancelled (final). Null: not shown this time. */
  private async order(id: string): Promise<OrderInfo | null> {
    const known = this.orders.get(id)
    if (known && known.status !== ORDER_OPEN) return known
    try {
      const o = await readOrder(id, this.read)
      if (o) this.orders.set(id, o)
      return o
    } catch {
      // Unreadable verified now. A FINAL state already known still stands; an open one is not shown.
      return null
    }
  }

  private async payable(o: OrderInfo): Promise<PayoutCheck> {
    const hit = this.payout.get(o.id)
    if (hit && (!hit.check.ok || this.now - hit.at < REUSE_MS)) return hit.check
    const check = await checkPayout(o, this.read)
    // An existing output is final ("exists"); an unreachable indexer is not — ask again next time.
    if (check.ok || /already exists/.test(check.reason)) this.payout.set(o.id, { check, at: this.now })
    return check
  }

  /** Cancel key public keys 0…`upTo`, derived once per reader. */
  private async keysUpTo(upTo: number): Promise<string[]> {
    const root = this.opts.tradeRoot
    if (!root) return []
    while (this.cancelKeys.length <= upTo) {
      const pk = await cancelKeyFor(root, this.cancelKeys.length).getPublicKey()
      this.cancelKeys.push(Array.from(pk, b => b.toString(16).padStart(2, '0')).join(''))
    }
    return this.cancelKeys
  }

  /** Match every discovered order against this wallet's cancel keys; record what the store lacks. */
  private async syncMine(orders: readonly OrderInfo[]): Promise<Map<string, number>> {
    const address = this.opts.walletAddress
    const mine = new Map<string, number>()
    if (!address || !this.opts.tradeRoot) return mine
    const state = loadTradeState(address)
    let horizon = state.nextCancelIndex + CANCEL_KEY_LOOKAHEAD
    let keys = await this.keysUpTo(horizon)
    const byKey = new Map(orders.filter(o => o.cancelKeyHex).map(o => [o.cancelKeyHex!, o]))
    // Look ahead from the highest key found, so a gap of failed placements is no dead end.
    for (let i = 0; i <= horizon; i++) {
      const o = byKey.get(keys[i])
      if (!o) continue
      mine.set(o.id, i)
      if (i + CANCEL_KEY_LOOKAHEAD > horizon) { horizon = i + CANCEL_KEY_LOOKAHEAD; keys = await this.keysUpTo(horizon) }
    }
    const known = new Set(state.records.filter(r => r.action === 'place').map(r => r.orderId))
    const found: TradeRecord[] = []
    let next = 0
    for (const [id, idx] of mine) {
      next = Math.max(next, idx + 1)
      const o = byKey.get(keys[idx])!
      if (known.has(id)) { observeOrder(address, id, stateOf(o)); continue }
      found.push({
        journalId: `recovered-${id}`, action: 'place', txId: null, at: this.now,
        side: o.side, n: o.n, p: o.p, tradeFee: o.fee, caravelCut: o.caravelCut, burnCut: o.burnCut,
        pays: null, gets: null, orderId: id, cancelIndex: idx, cusdOutputIds: [], cusdSpentIds: [],
        outcome: 'committed', payoutOutputId: null, orderState: stateOf(o), filledSeenAt: null,
      })
    }
    if (found.length > 0 || next > state.nextCancelIndex) recordRecovery(address, next, found)
    return mine
  }

  private async fillTime(txId: string, epochNow: () => Promise<number | null>): Promise<{ at: number | null; estimated: boolean }> {
    const hit = this.fillTimes.get(txId)
    if (hit) return hit
    const tx = await pointRead(`/transactions/${txId}`)
    let at = parseTxCreatedAt(tx.body)
    let estimated = false
    if (at === null) {
      // Not retained any more: estimate from the epoch its receipt names (crypto/burnWallet's rule).
      const receipt = await pointRead(`/transaction-receipts/${txId}`)
      const epoch = (receipt.body as { receipt?: { epoch?: unknown } } | null)?.receipt?.epoch
      const current = typeof epoch === 'number' ? await epochNow() : null
      if (typeof epoch === 'number' && current !== null) { at = estimateEpochTime(epoch, current, this.now); estimated = true }
      if (!tx.answered && !receipt.answered) return { at: null, estimated: false }   // ask again next time
    }
    const result = { at, estimated }
    this.fillTimes.set(txId, result)
    return result
  }

  /** One refresh. Throws MarketUnreachable when the Board or its order list cannot be read at all. */
  async refresh(): Promise<MarketData> {
    const board = await this.boardInfo()
    let ids: string[]
    try {
      ids = await listBoardOrderIds()
    } catch (e) {
      throw new MarketUnreachable(e instanceof Error ? e.message : 'The order book could not be read.')
    }
    // THIS WALLET'S OWN committed orders, even before the Board's event listing has them (measured:
    // ~20-30 s behind a placement). Caravel knows the id from the committed result, so a placed order
    // is in the placer's book on the next refresh, not the one after.
    const ownPlaced = this.opts.walletAddress
      ? loadTradeState(this.opts.walletAddress).records.filter(r => r.action === 'place' && r.orderId && r.outcome === 'committed')
      : []
    for (const r of ownPlaced) if (!ids.includes(r.orderId!)) ids = [...ids, r.orderId!]
    const read = await mapLimit(ids, READ_CONCURRENCY, async id => ({ id, o: await this.order(id) }))
    const hidden: MarketData['hidden'] = []
    const legit = new Map<string, OrderInfo>()
    // Own just-placed orders not yet served verified: shown to their placer from a plain read,
    // flagged unconfirmed. Never anyone else's.
    const ownIndex = new Map(ownPlaced.map(r => [r.orderId!, r.cancelIndex]))
    const unconfirmedOwn: OrderInfo[] = []
    for (const { id, o } of read) {
      if (!o) {
        if (ownIndex.has(id)) {
          const plain = await readOrderUnverified(id).catch(() => null)
          if (plain && plain.status === ORDER_OPEN && orderLegitimacy(plain, board) === null) { unconfirmedOwn.push(plain); continue }
        }
        hidden.push({ orderId: id, reason: 'not readable verified' })
        continue
      }
      const why = orderLegitimacy(o, board)
      if (why) { hidden.push({ orderId: id, reason: why }); continue }
      legit.set(id, o)
      this.legitSeen.set(id, o)
    }

    const mine = await this.syncMine([...this.legitSeen.values()])

    const open = [...legit.values()].filter(o => o.status === ORDER_OPEN)
    const checks = await mapLimit(open, READ_CONCURRENCY, async o => ({ o, c: await this.payable(o) }))
    const seqOf = new Map(ids.map((id, i) => [id, i]))
    const entries: BookEntry[] = []
    for (const { o, c } of checks) {
      if (!c.ok) { hidden.push({ orderId: o.id, reason: c.reason }); continue }
      entries.push(toBookEntry(o, seqOf.get(o.id) ?? 0, mine))
    }
    for (const o of unconfirmedOwn) {
      const idx = ownIndex.get(o.id)
      entries.push(toBookEntry(o, seqOf.get(o.id) ?? 0, idx === null || idx === undefined ? mine : new Map([...mine, [o.id, idx]]), false))
    }

    // Recent fills: one topic query, then each new fill's time once. A failure here costs only this
    // list (null = not known now), never the book.
    let recent: RecentTrade[] | null = null
    const filledIds = new Set<string>()
    try {
      const q = new URLSearchParams({ topic: FILLED_TOPIC, limit: '1000' })
      const res = await fetchWithRetry(INDEXER_URLS, `/transactions/events?${q}`, {}, { attempts: 3, timeoutMs: POINT_READ_TIMEOUT_MS, alternate: true })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const allFills = parseFillEvents(await res.json(), this.legitSeen)
      for (const f of allFills) filledIds.add(f.orderId)
      // This wallet's orders that somebody filled: recorded now, from the engine's fill event, so the
      // cUSD scan that follows (hooks/useFullRescan) asks for the maker's payout by id at once.
      const address = this.opts.walletAddress
      if (address) for (const id of filledIds) if (mine.has(id)) observeOrder(address, id, 'filled')
      const fills = allFills.slice(0, RECENT_LIMIT)
      let epochPromise: Promise<number | null> | null = null
      const epochNow = () => (epochPromise ??= currentEpoch())
      const takerTx = new Set(this.opts.walletAddress
        ? loadTradeState(this.opts.walletAddress).records.filter(r => r.action === 'fill' && r.txId).map(r => r.txId!)
        : [])
      recent = await mapLimit(fills, READ_CONCURRENCY, async f => {
        const o = this.legitSeen.get(f.orderId)!
        const t = await this.fillTime(f.txId, epochNow)
        return {
          orderId: f.orderId, txId: f.txId, side: o.side, n: o.n, p: o.p, price: pricePerTari(o.n, o.p),
          at: t.at, atEstimated: t.estimated,
          yours: mine.has(f.orderId) ? 'maker' : takerTx.has(f.txId) ? 'taker' : null,
        } satisfies RecentTrade
      })
      recent.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    } catch {
      recent = null
    }

    const records = this.opts.walletAddress ? loadTradeState(this.opts.walletAddress).records : []
    return {
      book: buildBook(entries), mine: myOrdersFrom(records, legit, this.legitSeen, filledIds), recent, hidden,
      discovered: ids.length, board, at: this.now,
    }
  }
}
