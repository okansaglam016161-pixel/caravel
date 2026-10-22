// Caravel Trade from the chain: the Board, an order, and the SAFETY CHECK a taker runs before paying.
//
// Every read here is a VERIFIED read (crypto/cusdScan.verifiedRead: an indexer body marked
// `verified: true`, a 404 believed only when no node said otherwise). A fill is refused unless all of
// these hold, read just now:
//
//   legitimacy   the order runs the Order template, names THIS Board and THIS Board's badge, and
//                quotes cUSD. Only the Board holds the badge (supply 1, minting locked), so only the
//                Board could have created a component naming it — a look-alike order fails here.
//   still open   status OPEN, at the version the fill pins.
//   terms        the N and P the taker was shown (the fill passes them too; the contract re-checks).
//   payout       a private payout's single output must NOT already exist on EITHER indexer: the fill
//                creates it, so an existing one (a copied statement) makes the fill fail after its fee.
//                A public payout's account must exist.
//   dry run      a clean Accept at the exact fee (crypto/trade does that one).

import { CUSD_ASSET } from './assets'
import { verifiedRead, type VerifiedReader } from './cusdScan'
import { decodeStatement, payoutCommitment, StatementCborError } from './statementCbor'
import { substateValueOf } from './substateShape'
import { fetchWithRetry } from './indexerRetry'
import { INDEXER_URLS, POINT_READ_TIMEOUT_MS, pointRead } from './indexerConfig'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import type { TradeLeg, TradeRecord } from './tradeStore'
import {
  BUY, ORDER_FILLED, ORDER_OPEN, SELL, TRADE_BOARD_ADDRESS, TRADE_BOARD_BADGE, TRADE_BOARD_TEMPLATE, TRADE_ORDER_TEMPLATE, TRADE_QUOTE,
  type OrderSide, type OrderStatus,
} from './tradeConfig'

export class TradeReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TradeReadError'
  }
}

// ── Decoding component state (tagged CBOR JSON on the 0.46 indexer) ──────────

/** The hex inside an address field: `{tag, value: {bytes}}`, `{bytes}`, or a plain `prefix_hex`. */
export function cborHex(v: unknown): string | null {
  let x = v as { '@cbor'?: string; value?: unknown; hex?: unknown } | string | null | undefined
  if (x && typeof x === 'object' && x['@cbor'] === 'tag') x = x.value as typeof x
  if (x && typeof x === 'object' && x['@cbor'] === 'bytes' && typeof x.hex === 'string') return x.hex
  if (typeof x === 'string') return x.split('_').pop() ?? null
  return null
}

function addr(prefix: string, v: unknown, what: string): string {
  const h = cborHex(v)
  if (h === null || !/^[0-9a-f]{64}$/.test(h)) throw new TradeReadError(`Unreadable ${what}`)
  return `${prefix}_${h}`
}

/** An Amount in state: a JSON number (safe integers only — never a rounded one) or a decimal string. */
export function amountOf(v: unknown, what: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v)
  throw new TradeReadError(`Unreadable ${what}`)
}

interface ComponentBody { version: number; template: string; header: unknown; state: unknown[] }

function component(body: unknown, what: string): ComponentBody {
  const b = (body ?? {}) as { version?: unknown }
  // Either indexer shape (crypto/substateShape): 0.47 serves the value at `state.up.substate`.
  const c = (substateValueOf(body) as { Component?: { header?: { template_address?: unknown }; body?: { state?: unknown } } } | undefined)?.Component
  const state = c?.body?.state
  if (!c || !Array.isArray(state) || typeof b.version !== 'number' || typeof c.header?.template_address !== 'string') {
    throw new TradeReadError(`${what} is not a component`)
  }
  return { version: b.version, template: c.header.template_address, header: c.header, state }
}

// ── The Board ────────────────────────────────────────────────────────────────

export interface BoardInfo {
  version: number
  orderTemplate: string
  quote: string
  feeBps: bigint
  caravelPct: bigint
  caravelAccount: string
  burnWallet: string
  minOrder: bigint
  paused: boolean
  badgeVault: string
  badge: string
}

export function parseBoard(body: unknown): BoardInfo {
  const c = component(body, 'The Board')
  if (c.template !== TRADE_BOARD_TEMPLATE) throw new TradeReadError('The Board is not running the Board template.')
  const s = c.state
  const paused = s[7]
  if (typeof paused !== 'boolean') throw new TradeReadError('Unreadable Board pause flag')
  return {
    version: c.version,
    orderTemplate: cborHex(s[0]) ?? '',
    quote: addr('resource', s[1], 'quote token'),
    feeBps: amountOf(s[2], 'fee'),
    caravelPct: amountOf(s[3], 'fee split'),
    caravelAccount: addr('component', s[4], 'Caravel fee account'),
    burnWallet: addr('component', s[5], 'burn wallet'),
    minOrder: amountOf(s[6], 'minimum order'),
    paused,
    badgeVault: addr('vault', s[8], 'badge vault'),
    badge: addr('resource', s[9], 'badge'),
  }
}

export async function readBoard(read: VerifiedReader = verifiedRead): Promise<BoardInfo> {
  const c = await read(`/substates/${TRADE_BOARD_ADDRESS}`)
  if (c.kind !== 'verified') throw new TradeReadError('Could not read the trade Board verified — try again in a moment.')
  const board = parseBoard(c.body)
  if (board.badge !== TRADE_BOARD_BADGE || board.quote !== TRADE_QUOTE || board.orderTemplate !== TRADE_ORDER_TEMPLATE) {
    throw new TradeReadError('The trade Board is not the one this app trusts.')
  }
  return board
}

// ── An order ─────────────────────────────────────────────────────────────────

export interface OrderInfo {
  id: string
  version: number
  template: string
  side: OrderSide
  status: OrderStatus
  board: string
  badge: string
  quote: string
  /** The tTARI side, µtTARI. */
  n: bigint
  /** The cUSD side, base units. */
  p: bigint
  fee: bigint
  caravelCut: bigint
  burnCut: bigint
  caravelAccount: string
  burnWallet: string
  /** The maker's stored payout statement (tari_bor), or null when the maker is paid publicly. */
  payoutStatement: Uint8Array | null
  /** The maker's public account, or null when the maker is paid privately. */
  payoutAccount: string | null
  escrowVault: string
  /** The public key the `cancel` rule names (hex), or null if the rule is not the expected shape. */
  cancelKeyHex: string | null
}

function bytesOf(v: unknown): Uint8Array {
  const h = cborHex(v)
  if (h === null || h.length % 2 !== 0) throw new TradeReadError('Unreadable payout statement')
  const b = new Uint8Array(h.length / 2)
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
  return b
}

/** The key in `cancel: Restricted(Require(Require(NonFungibleAddress(<pk badge>, U256 <pk>))))`. */
export function cancelKeyOf(header: unknown): string | null {
  const rule = (header as { access_rules?: { method_access?: { cancel?: unknown } } })?.access_rules?.method_access?.cancel
  const nft = (rule as { Restricted?: { Require?: { Require?: { NonFungibleAddress?: { id?: { U256?: unknown } } } } } })
    ?.Restricted?.Require?.Require?.NonFungibleAddress
  const pk = nft?.id?.U256
  return typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk) ? pk : null
}

export function parseOrder(id: string, body: unknown): OrderInfo {
  const c = component(body, 'The order')
  // The template first: a component running other code is not an order, whatever its state looks like.
  if (c.template !== TRADE_ORDER_TEMPLATE) throw new TradeReadError('This is not a Caravel Trade order (wrong template).')
  const s = c.state
  const side = Number(s[0]), status = Number(s[1])
  if ((side !== SELL && side !== BUY) || ![0, 1, 2].includes(status)) throw new TradeReadError('Unreadable order side or status')
  const statement = bytesOf(s[12])
  const accounts = Array.isArray(s[13]) ? s[13] : null
  if (accounts === null || accounts.length > 1) throw new TradeReadError('Unreadable order payout account')
  return {
    id,
    version: c.version,
    template: c.template,
    side: side as OrderSide,
    status: status as OrderStatus,
    board: addr('component', s[2], 'order board'),
    badge: addr('resource', s[3], 'order badge'),
    quote: addr('resource', s[4], 'order quote'),
    n: amountOf(s[5], 'order N'),
    p: amountOf(s[6], 'order P'),
    fee: amountOf(s[7], 'order fee'),
    caravelCut: amountOf(s[8], 'order fee share'),
    burnCut: amountOf(s[9], 'order burn share'),
    caravelAccount: addr('component', s[10], 'order fee account'),
    burnWallet: addr('component', s[11], 'order burn wallet'),
    payoutStatement: statement.length === 0 ? null : statement,
    payoutAccount: accounts.length === 1 ? addr('component', accounts[0], 'order payout account') : null,
    escrowVault: addr('vault', s[14], 'order escrow'),
    cancelKeyHex: cancelKeyOf(c.header),
  }
}

/** The order at `id`, verified. Null when the chain says no such substate. */
export async function readOrder(id: string, read: VerifiedReader = verifiedRead): Promise<OrderInfo | null> {
  if (!/^component_[0-9a-f]{64}$/.test(id)) throw new TradeReadError('That is not an order address.')
  const r = await read(`/substates/${id}`)
  if (r.kind === 'absent') return null
  if (r.kind === 'unknown') throw new TradeReadError('Could not read the order verified — try again in a moment.')
  return parseOrder(id, r.body)
}

/**
 * The order at `id` from a PLAIN (unverified) read — for this wallet's OWN just-placed order only, in
 * the seconds before the indexer serves it verified. Never used to show or fill anyone else's order.
 */
export async function readOrderUnverified(id: string): Promise<OrderInfo | null> {
  const r = await pointRead(`/substates/${id}`)
  if (!r.answered || r.body === null) return null
  try { return parseOrder(id, r.body) } catch { return null }
}

/** What the maker is owed out of a fill: P cUSD for a SELL, N minus the fee in tTARI for a BUY. */
export function makerOwed(o: Pick<OrderInfo, 'side' | 'n' | 'p' | 'fee'>): { resource: string; amount: bigint } {
  return o.side === SELL ? { resource: CUSD_ASSET.resource, amount: o.p } : { resource: TARI_RESOURCE_ADDRESS, amount: o.n - o.fee }
}

/** Why `o` is not a real order of the trusted Board — or null when it is. */
export function orderLegitimacy(o: OrderInfo, board: Pick<BoardInfo, 'badge'>): string | null {
  if (o.template !== TRADE_ORDER_TEMPLATE) return 'This is not a Caravel Trade order (wrong template).'
  if (o.board !== TRADE_BOARD_ADDRESS) return 'This order was not placed by the Caravel Trade Board.'
  if (o.badge !== TRADE_BOARD_BADGE || o.badge !== board.badge) return 'This order does not carry the Board\'s badge.'
  if (o.quote !== TRADE_QUOTE) return 'This order is not quoted in Caravel Test Dollars.'
  if (o.n <= 0n || o.p <= 0n) return 'This order\'s amounts are not positive.'
  if (o.caravelCut + o.burnCut !== o.fee || o.fee > o.n) return 'This order\'s fee does not add up.'
  if ((o.payoutStatement === null) === (o.payoutAccount === null)) return 'This order does not name exactly one way to pay its maker.'
  return null
}

// ── The payout must not collide ──────────────────────────────────────────────

/**
 * The output a fill creates for the maker of a PRIVATE-payout order — `utxo_<resource>_<commitment>`,
 * from the payout statement the order stores on chain — or null for a public payout (it goes into the
 * maker's account; no output). Throws when the stored statement cannot be read.
 *
 * The same id whichever device asks: what lets a wallet that did not place an order (a restore, an
 * order placed elsewhere) still recognise its payout when the fill pays it.
 */
export function payoutOutputIdOf(o: Pick<OrderInfo, 'side' | 'n' | 'p' | 'fee' | 'payoutStatement'>): string | null {
  if (o.payoutStatement === null) return null
  const owed = makerOwed(o)
  return `utxo_${owed.resource.replace(/^resource_/, '')}_${payoutCommitment(decodeStatement(o.payoutStatement), owed.amount)}`
}

/** How the maker of `o` is paid: the owed amount, privately (a payout output) or into its account. */
export function payoutLegOf(o: Pick<OrderInfo, 'side' | 'n' | 'p' | 'fee' | 'payoutStatement'>): TradeLeg {
  return { ...makerOwed(o), mode: o.payoutStatement === null ? 'public' : 'private' }
}

/** The payout output id, or null when it cannot be read (a payout never recognised is only a label). */
function payoutOutputIdOrNull(o: OrderInfo): string | null {
  try { return payoutOutputIdOf(o) } catch { return null }
}

/**
 * The record of an order of ours FOUND on chain rather than placed on this device — a restore, the
 * Trade page's discovery, or the wallet's own refresh finding an order placed elsewhere. Everything a
 * placement would have recorded that the chain still holds: terms, cancel key, state, the closing
 * transaction (its time is the "Order filled" row's), and how the maker is paid — with the payout
 * output's id, so a fill's private payout is recognised as this order's and not as an unknown receive.
 */
export function foundOrderRecord(o: OrderInfo, cancelIndex: number, closedTxId: string | null, now = Date.now()): TradeRecord {
  return {
    journalId: `recovered-${o.id}`, action: 'place', txId: null, at: now,
    side: o.side, n: o.n, p: o.p, tradeFee: o.fee, caravelCut: o.caravelCut, burnCut: o.burnCut,
    pays: null, gets: payoutLegOf(o), orderId: o.id, cancelIndex, cusdOutputIds: [], cusdSpentIds: [], outcome: 'committed',
    payoutOutputId: payoutOutputIdOrNull(o),
    orderState: o.status === ORDER_OPEN ? 'open' : o.status === ORDER_FILLED ? 'filled' : 'cancelled',
    // Seen closed before this device knew of it: no local moment. Its time is the closing transaction's.
    filledSeenAt: null,
    closedTxId,
  }
}

/** `taken`: the payout already exists — the order was filled. Every other refusal is not "taken". */
export type PayoutCheck = { ok: true; outputId: string | null } | { ok: false; reason: string; taken?: boolean }

/**
 * Is the maker's payout still payable? A private payout's single output (the substate the fill will
 * create) must be absent on EVERY indexer — each asked separately, and an unanswered one is a refusal,
 * not a pass. A public payout's account must exist.
 */
export async function checkPayout(o: OrderInfo, read: VerifiedReader = verifiedRead): Promise<PayoutCheck> {
  if (o.payoutStatement === null) {
    const acct = await read(`/substates/${o.payoutAccount}`)
    if (acct.kind === 'verified') return { ok: true, outputId: null }
    return { ok: false, reason: acct.kind === 'absent' ? 'The maker\'s payout account does not exist.' : 'Could not verify the maker\'s payout account.' }
  }
  let outputId: string
  try {
    outputId = payoutOutputIdOf(o)!
  } catch (e) {
    return { ok: false, reason: e instanceof StatementCborError ? e.message : 'The order\'s payout could not be read.' }
  }
  for (const base of INDEXER_URLS) {
    let status: number
    try {
      status = (await fetchWithRetry([base], `/substates/${outputId}`, {}, { attempts: 2, timeoutMs: POINT_READ_TIMEOUT_MS })).status
    } catch {
      return { ok: false, reason: 'Could not check the maker\'s payout on every indexer — try again in a moment.' }
    }
    if (status === 200) return { ok: false, taken: true, reason: 'This order\'s payout output already exists, so filling it would fail. It cannot be filled.' }
    if (status !== 404) return { ok: false, reason: 'Could not check the maker\'s payout on every indexer — try again in a moment.' }
  }
  return { ok: true, outputId }
}

// ── The book ─────────────────────────────────────────────────────────────────

const EVENTS_PAGE = 1000
const MAX_EVENT_PAGES = 50

/** Every order the Board has announced (OrderPlaced), oldest first, de-duplicated. A hint, not a fact. */
export async function listBoardOrderIds(): Promise<string[]> {
  return (await listBoardOrders()).map(o => o.id)
}

/** {@link listBoardOrderIds}, with the transaction that placed each order (its time comes from that). */
export async function listBoardOrders(): Promise<{ id: string; txId: string }[]> {
  const ids: { id: string; txId: string }[] = []
  const seen = new Set<string>()
  let before: string | null = null
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const query = new URLSearchParams({ substate_id: TRADE_BOARD_ADDRESS, limit: String(EVENTS_PAGE) })
    if (before !== null) query.set('before_id', before)
    const res = await fetchWithRetry(INDEXER_URLS, `/transactions/events?${query}`, {}, { attempts: 3, timeoutMs: POINT_READ_TIMEOUT_MS, alternate: true })
    if (!res.ok) throw new TradeReadError(`The order book could not be read (indexer HTTP ${res.status}).`)
    const body = await res.json() as { events?: unknown; next_before_id?: unknown }
    for (const e of Array.isArray(body.events) ? body.events : []) {
      const txId = (e as unknown[])?.[0]
      const ev = (e as unknown[])?.[1] as { topic?: unknown; substate_id?: unknown; payload?: { order?: unknown } } | undefined
      if (ev?.substate_id !== TRADE_BOARD_ADDRESS || ev.topic !== 'CaravelTradeBoard.OrderPlaced' || typeof txId !== 'string') continue
      const id = String(ev.payload?.order ?? '')
      if (/^component_[0-9a-f]{64}$/.test(id) && !seen.has(id)) { seen.add(id); ids.push({ id, txId }) }
    }
    if (body.next_before_id === null || body.next_before_id === undefined) break
    before = String(body.next_before_id)
  }
  return ids.reverse()
}

/** Open, legitimate orders on the book, each read verified. Unreadable ones are skipped. */
export async function readOpenOrders(read: VerifiedReader = verifiedRead): Promise<OrderInfo[]> {
  const board = await readBoard(read)
  const out: OrderInfo[] = []
  for (const id of await listBoardOrderIds()) {
    try {
      const o = await readOrder(id, read)
      if (o && o.status === ORDER_OPEN && orderLegitimacy(o, board) === null) out.push(o)
    } catch { /* an order that cannot be read verified is not shown */ }
  }
  return out
}

/**
 * What an order's OWN events say happened to it — 'filled', 'cancelled', or null (neither yet, or no
 * answer). Kept only when the ENGINE stamped the event with this order and the Order template (a topic
 * is just a name). For the moments after a fill or cancel when the order's new state is not yet served
 * verified (measured: ~40-50 s): the event is already there.
 */
export async function orderOutcomeFromEvents(orderId: string): Promise<{ state: 'filled' | 'cancelled'; txId: string } | null> {
  try {
    const q = new URLSearchParams({ substate_id: orderId, limit: '20' })
    const res = await fetchWithRetry(INDEXER_URLS, `/transactions/events?${q}`, {}, { attempts: 2, timeoutMs: POINT_READ_TIMEOUT_MS, alternate: true })
    if (!res.ok) return null
    const body = await res.json() as { events?: unknown }
    for (const e of Array.isArray(body.events) ? body.events : []) {
      const txId = (e as unknown[])?.[0]
      const ev = (e as unknown[])?.[1] as { substate_id?: unknown; template_address?: unknown; topic?: unknown } | undefined
      if (ev?.substate_id !== orderId || ev.template_address !== TRADE_ORDER_TEMPLATE || typeof txId !== 'string') continue
      if (ev.topic === 'CaravelTradeOrder.Filled') return { state: 'filled', txId }
      if (ev.topic === 'CaravelTradeOrder.Cancelled') return { state: 'cancelled', txId }
    }
  } catch { /* no answer: nothing concluded */ }
  return null
}
