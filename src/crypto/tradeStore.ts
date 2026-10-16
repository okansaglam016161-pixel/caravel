// The wallet's record of its own Caravel Trade activity: the orders it placed (and which cancel key
// each names), the fills it took, the cancels it made, and the cUSD outputs any of them created.
//
// ── WHY ITS OWN RECORD ───────────────────────────────────────────────────────
//
// The journal holds the TARI side of every trade (the network fee, tTARI spent and created), because
// every reader of the journal treats an output id as TARI. A trade also moves cUSD and has terms (side,
// N, P, the order, the trade fee) that are not a TARI amount. Those live here, keyed by the journal
// entry, exactly as crypto/cusdStore keeps the cUSD claim beside its journal entry.
//
// ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
//
//   cancel keys   `nextCancelIndex` — each order names a fresh seed-derived key (derivation.cancelKeyFor)
//                 and the index is RESERVED HERE BEFORE the order is placed, so a crash after placing
//                 cannot hand the same key to two orders. A restored wallet with no record rebuilds it
//                 from the chain (tradeActions.recoverTradeState): the keys come back from the seed and
//                 are matched against the cancel rules of the orders on the Board.
//   recovery      cUSD outputs a trade made for us, asked for by id until a listing has them (the cUSD
//                 scan and the cUSD coin selection both read `knownCusdIds`).
//   activity      what each trade was, and when one of OUR orders was seen filled by somebody else —
//                 the maker's "Order filled", which is no transaction of ours.
//
// It is NOT the source of truth for any balance. Sealed like every per-identity store.

import { asRecord, loadStore, writeStore, type Parse } from './storeIo'
import { loadCusdClaims } from './cusdStore'
import { CUSD_ASSET } from './assets'
import type { OrderSide, TradeMode } from './tradeConfig'

export type TradeAction = 'place' | 'fill' | 'cancel'
export type OrderState = 'open' | 'filled' | 'cancelled'

export interface TradeLeg { resource: string; amount: bigint; mode: TradeMode }

export interface TradeRecord {
  /** The journal entry of this trade's transaction (its TARI side). */
  journalId: string
  action: TradeAction
  txId: string | null
  at: number
  side: OrderSide
  /** tTARI side (µtTARI) and cUSD side (base units) of the order. */
  n: bigint
  p: bigint
  tradeFee: bigint
  caravelCut: bigint
  burnCut: bigint
  pays: TradeLeg | null
  gets: TradeLeg | null
  orderId: string | null
  cancelIndex: number | null
  /** cUSD outputs this transaction created for us (change, a private receive). */
  cusdOutputIds: string[]
  /**
   * cUSD coins this transaction spends. HELD OUT OF THE cUSD BALANCE AND SELECTION from the moment it is
   * sent — unless it was rejected — because an indexer can still vouch for a spent coin for a while after
   * the spend commits (measured: a `verified: true` live body right after commit, 404 a minute later).
   * The cUSD counterpart of crypto/spentOutputs, which does this for tTARI.
   */
  cusdSpentIds: string[]
  /** How the transaction ended, as the journal says; null before it was sent. */
  outcome: 'pending' | 'committed' | 'rejected' | 'timeout' | 'failed' | null
  /** Place, private payout: the output a fill will create for us later. */
  payoutOutputId: string | null
  /** Place: the order's state as last seen, and when it was first seen filled (the "Order filled" row). */
  orderState: OrderState | null
  filledSeenAt: number | null
  /** Place: the transaction that filled or cancelled the order — its time is the indexer's. */
  closedTxId?: string | null
}

export interface TradeState {
  /** The next unused cancel key index. */
  nextCancelIndex: number
  /** Set once the chain has been searched for this wallet's orders (a restore). */
  recoveredAt: number | null
  records: TradeRecord[]
}

const key = (walletAddress: string) => `caravel-trade-${walletAddress}`
const EMPTY: TradeState = { nextCancelIndex: 0, recoveredAt: null, records: [] }

const big = (v: unknown): bigint | null => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null)

function parseLeg(v: unknown): TradeLeg | null | undefined {
  if (v === null) return null
  const r = asRecord(v)
  const amount = big(r?.amount)
  if (!r || typeof r.resource !== 'string' || amount === null || (r.mode !== 'private' && r.mode !== 'public')) return undefined
  return { resource: r.resource, amount, mode: r.mode }
}

const parse: Parse<TradeState> = (decoded) => {
  const root = asRecord(decoded)
  if (!root || typeof root.nextCancelIndex !== 'number' || !Array.isArray(root.records)) return null
  const records: TradeRecord[] = []
  for (const raw of root.records) {
    const r = asRecord(raw)
    if (!r) return null
    const n = big(r.n), p = big(r.p), tradeFee = big(r.tradeFee), caravelCut = big(r.caravelCut), burnCut = big(r.burnCut)
    const pays = parseLeg(r.pays), gets = parseLeg(r.gets)
    if (typeof r.journalId !== 'string' || !['place', 'fill', 'cancel'].includes(r.action as string) || typeof r.at !== 'number'
      || (r.side !== 0 && r.side !== 1) || n === null || p === null || tradeFee === null || caravelCut === null || burnCut === null
      || pays === undefined || gets === undefined || !Array.isArray(r.cusdOutputIds)) return null
    records.push({
      journalId: r.journalId,
      action: r.action as TradeAction,
      txId: typeof r.txId === 'string' ? r.txId : null,
      at: r.at,
      side: r.side,
      n, p, tradeFee, caravelCut, burnCut, pays, gets,
      orderId: typeof r.orderId === 'string' ? r.orderId : null,
      cancelIndex: typeof r.cancelIndex === 'number' ? r.cancelIndex : null,
      cusdOutputIds: r.cusdOutputIds.filter((x): x is string => typeof x === 'string'),
      cusdSpentIds: Array.isArray(r.cusdSpentIds) ? r.cusdSpentIds.filter((x): x is string => typeof x === 'string') : [],
      outcome: ['pending', 'committed', 'rejected', 'timeout', 'failed'].includes(r.outcome as string) ? r.outcome as TradeRecord['outcome'] : null,
      payoutOutputId: typeof r.payoutOutputId === 'string' ? r.payoutOutputId : null,
      orderState: r.orderState === 'open' || r.orderState === 'filled' || r.orderState === 'cancelled' ? r.orderState : null,
      filledSeenAt: typeof r.filledSeenAt === 'number' ? r.filledSeenAt : null,
      closedTxId: typeof r.closedTxId === 'string' ? r.closedTxId : null,
    })
  }
  return { nextCancelIndex: root.nextCancelIndex, recoveredAt: typeof root.recoveredAt === 'number' ? root.recoveredAt : null, records }
}

const legJson = (l: TradeLeg | null) => (l ? { ...l, amount: l.amount.toString() } : null)

function save(walletAddress: string, s: TradeState): boolean {
  const json = JSON.stringify({
    ...s,
    records: s.records.map(r => ({
      ...r, n: r.n.toString(), p: r.p.toString(), tradeFee: r.tradeFee.toString(),
      caravelCut: r.caravelCut.toString(), burnCut: r.burnCut.toString(), pays: legJson(r.pays), gets: legJson(r.gets),
    })),
  })
  const ok = writeStore(key(walletAddress), json, parse)
  if (ok) notify()
  return ok
}

export function loadTradeState(walletAddress: string): TradeState {
  if (!walletAddress) return { ...EMPTY, records: [] }
  return loadStore(key(walletAddress), parse, () => ({ ...EMPTY, records: [] }))
}

/** The cancel key index the next order will name. A preview only peeks; nothing is used up. */
export function peekCancelIndex(walletAddress: string): number {
  return loadTradeState(walletAddress).nextCancelIndex
}

/**
 * Take cancel key `index` for an order about to be SUBMITTED — persisted before it is sent, so a key is
 * never named by two orders. Refuses when the index was taken meanwhile (the order must be re-priced
 * with a fresh one) or when the claim could not be stored. A placement that then fails leaves a gap,
 * which recovery tolerates.
 */
export function claimCancelIndex(walletAddress: string, index: number): void {
  const s = loadTradeState(walletAddress)
  if (s.nextCancelIndex !== index) throw new Error('This order\'s cancel key was used meanwhile. Review the order again.')
  if (!save(walletAddress, { ...s, nextCancelIndex: index + 1 })) {
    throw new Error('Could not record this order\'s cancel key on this device. Nothing was sent.')
  }
}

/** Add or replace (by journal id) a trade record. */
export function recordTrade(walletAddress: string, rec: TradeRecord): boolean {
  const s = loadTradeState(walletAddress)
  return save(walletAddress, { ...s, records: [...s.records.filter(r => r.journalId !== rec.journalId), rec] })
}

/**
 * Patch the placed-order record for `orderId` with what the chain now says about it — and, when known,
 * the transaction that filled or cancelled it.
 */
export function observeOrder(walletAddress: string, orderId: string, state: OrderState, closedTxId: string | null = null, now = Date.now()): boolean {
  const s = loadTradeState(walletAddress)
  let changed = false
  const records = s.records.map(r => {
    if (r.action !== 'place' || r.orderId !== orderId) return r
    const newTx = closedTxId !== null && state !== 'open' && r.closedTxId !== closedTxId
    if (r.orderState === state && !newTx) return r
    changed = true
    return {
      ...r, orderState: state,
      filledSeenAt: state === 'filled' ? (r.filledSeenAt ?? now) : r.filledSeenAt,
      closedTxId: newTx ? closedTxId : r.closedTxId ?? null,
    }
  })
  return changed ? save(walletAddress, { ...s, records }) : true
}

/** After a chain search (a restore): never hand out an index at or below one the chain shows in use. */
export function recordRecovery(walletAddress: string, nextCancelIndex: number, found: TradeRecord[], now = Date.now()): boolean {
  const s = loadTradeState(walletAddress)
  const known = new Set(s.records.filter(r => r.action === 'place').map(r => r.orderId))
  return save(walletAddress, {
    nextCancelIndex: Math.max(s.nextCancelIndex, nextCancelIndex),
    recoveredAt: now,
    records: [...s.records, ...found.filter(r => !known.has(r.orderId))],
  })
}

/** Orders this wallet placed that were open when last seen (or never checked). */
export function ownOpenOrders(walletAddress: string): TradeRecord[] {
  return loadTradeState(walletAddress).records.filter(r => r.action === 'place' && r.orderId && r.orderState !== 'filled' && r.orderState !== 'cancelled')
}

/**
 * cUSD coins this wallet has spent (or is spending) in a trade, to hold out of the cUSD balance and of
 * coin selection. Everything but a rejected or failed trade's: a rejection consumed no cUSD (the trade's
 * cUSD moves only in the main intent), and a failed one never reached the network.
 */
export function spentCusdIds(walletAddress: string): Set<string> {
  const out = new Set<string>()
  for (const r of loadTradeState(walletAddress).records) {
    if (r.outcome === 'rejected' || r.outcome === 'failed') continue
    for (const id of r.cusdSpentIds) out.add(id)
  }
  return out
}

/** Every cUSD output this wallet made for itself — claims and trades — for recovery by id. */
export function knownCusdIds(walletAddress: string): string[] {
  const prefix = `utxo_${CUSD_ASSET.resourceHex}_`
  // A claim's output is always cUSD. Claims recorded before the fix carry TARI's prefix (the id was
  // built with the wrong resource), so the commitment is re-keyed to cUSD's — the same output.
  const ids = new Set<string>(loadCusdClaims(walletAddress).map(c => `${prefix}${c.outputId.split('_').pop()}`))
  for (const r of loadTradeState(walletAddress).records) {
    for (const id of r.cusdOutputIds) ids.add(id)
    // A maker's cUSD payout exists only once the order is filled; ask for it from then on.
    if (r.payoutOutputId && r.orderState === 'filled') ids.add(r.payoutOutputId)
  }
  return [...ids].filter(id => id.startsWith(prefix))
}

// Change signal + a cached snapshot for useSyncExternalStore (see cusdStore).
const listeners = new Set<() => void>()
function notify() { snapshotAddress = undefined; for (const l of listeners) l() }
export function subscribeTrades(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

let snapshotAddress: string | null | undefined
let snapshot: TradeRecord[] = []
export function tradesSnapshot(walletAddress: string | null): TradeRecord[] {
  if (walletAddress === snapshotAddress) return snapshot
  snapshotAddress = walletAddress
  snapshot = walletAddress ? loadTradeState(walletAddress).records : []
  return snapshot
}
