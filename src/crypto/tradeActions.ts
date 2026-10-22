// Running a prepared trade, and keeping this wallet's trade record true — the one place the Trade page
// (T4) and the harness both go through, so the journal, the trade store and the cancel keys are kept
// the same way whichever drives them.
//
//   runTrade          confirm (re-check the fee and inputs) → take the cancel key index (place) →
//                     journal + trade record BEFORE sending → submit → settle both
//   preparePlaceOrder the next cancel key index, peeked (a preview uses nothing up), then preparePlace
//   refreshOwnOrders  read each of this wallet's open orders; one seen FILLED becomes "Order filled"
//   recoverTradeState a device with no trade record (a restore) finds its orders from the seed: the
//                     cancel keys are derived in index order and matched against the orders' cancel
//                     rules, so they can still be cancelled and their index is never reused

import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { cancelKeyFor, type PurposeKeys } from './derivation'
import type { JournalKind, JournalOutcome } from './journal'
import { beginEntry, settleEntry } from './journalStore'
import { SubmitMaybeLandedError } from './submitGuard'
import { fetchCreatedUtxoIds } from './txOutputs'
import { preparePlace, type PlaceParams, type PreparedTrade, type Trader, type TradeResult } from './trade'
import { ORDER_CANCELLED, ORDER_FILLED, ORDER_OPEN, TRADE_BOARD_ADDRESS, TRADE_ORDER_TEMPLATE } from './tradeConfig'
import { foundOrderRecord, listBoardOrderIds, orderOutcomeFromEvents, payoutLegOf, payoutOutputIdOf, readOrder } from './tradeRead'
import {
  claimCancelIndex, knownCusdIds, loadTradeState, noteCloseOutputs, notePayout, observeOrder, ownOpenOrders, peekCancelIndex, recordRecovery, recordTrade,
  type TradeRecord,
} from './tradeStore'

/** The Trader for an unlocked wallet. `account` null when it has none (public paths then refuse). */
export function traderFor(wallet: SecretKeyWallet, address: string, purposeKeys: Pick<PurposeKeys, 'tradeRoot'>, account: string | null): Trader {
  return { wallet, address, account, tradeRoot: purposeKeys.tradeRoot, knownCusdIds: knownCusdIds(address) }
}

/** Place: recover the cancel index first on a device that never has, then price with the next index. */
export async function preparePlaceOrder(
  t: Trader,
  params: Omit<PlaceParams, 'cancelIndex'>,
  onProgress?: (m: string) => void,
): Promise<PreparedTrade> {
  if (loadTradeState(t.address).recoveredAt === null) {
    onProgress?.('Looking for this wallet\'s earlier orders…')
    await recoverTradeState(t)
  }
  return preparePlace(t, { ...params, cancelIndex: peekCancelIndex(t.address) }, onProgress)
}

export interface TradeRun extends TradeResult {
  journalId: string
}

const JOURNAL_KIND: Record<PreparedTrade['details']['action'], JournalKind> = {
  place: 'trade-place', fill: 'trade-fill', cancel: 'trade-cancel',
}

/** The tTARI this trade moves for us (out or in), 0 when its legs are cUSD. The journal's amount. */
function tariMoved(d: PreparedTrade['details']): bigint {
  if (d.pays?.resource === TARI_RESOURCE_ADDRESS) return d.pays.amount
  if (d.gets?.resource === TARI_RESOURCE_ADDRESS && d.action !== 'place') return d.gets.amount
  return 0n
}

/**
 * Send a prepared trade and record it. The confirm check runs first, so a fee that moved or a coin
 * that went is caught before anything is written; from then on the journal entry exists before the
 * transaction does, and is settled with what the network decided.
 */
export async function runTrade(t: Trader, prepared: PreparedTrade, onProgress?: (m: string) => void): Promise<TradeRun> {
  const d = prepared.details
  onProgress?.('Checking the fee…')
  await prepared.confirm()
  if (d.action === 'place') claimCancelIndex(t.address, d.cancelIndex!)

  const e = prepared.effects
  // tTARI only: the fee's change, a tTARI receive or change, and a BUY order's private tTARI payout.
  const selfOutputIds = [...e.tariCreated, ...(e.payout?.resource === TARI_RESOURCE_ADDRESS ? [e.payout.outputId] : [])]
  const { entry } = beginEntry(t.address, {
    kind: JOURNAL_KIND[d.action],
    amountMicrotari: tariMoved(d),
    feeMicrotari: prepared.fee,
    from: d.pays?.mode ?? null,
    to: d.gets?.mode ?? null,
    counterparty: null,
    note: null,
    source: 'local-journal',
    selfOutputIds,
    spentInputIds: e.tariSpent,
  })
  const record: TradeRecord = {
    journalId: entry.id, action: d.action, txId: null, at: entry.timestamp,
    side: d.side, n: d.n, p: d.p, tradeFee: d.tradeFee, caravelCut: d.caravelCut, burnCut: d.burnCut,
    pays: d.pays, gets: d.gets, orderId: d.orderId, cancelIndex: d.cancelIndex,
    // A maker's cUSD payout is not created yet; tradeStore.knownCusdIds asks for it once the order fills.
    cusdOutputIds: e.cusdCreated,
    // Held out of the cUSD balance from now on (tradeStore.spentCusdIds), as tTARI coins are by markLocked.
    cusdSpentIds: e.cusdSpent,
    outcome: 'pending',
    payoutOutputId: e.payout?.outputId ?? null,
    orderState: null, filledSeenAt: null,
  }
  recordTrade(t.address, record)

  let result: TradeResult
  try {
    result = await prepared.submit(onProgress)
  } catch (err) {
    // Maybe-landed is not a failure: nothing can be concluded, exactly like a timeout.
    const failed: JournalOutcome = err instanceof SubmitMaybeLandedError ? 'timeout' : 'failed'
    settleEntry(t.address, entry.id, { outcome: failed })
    recordTrade(t.address, { ...record, outcome: failed })
    throw err
  }
  const outcome: JournalOutcome = result.outcome === 'Commit' ? 'committed' : result.outcome === 'Reject' ? 'rejected' : 'timeout'
  settleEntry(t.address, entry.id, { outcome, txId: result.txId, feeMicrotari: result.outcome === 'Timeout' ? prepared.fee : result.feeMicrotari })
  recordTrade(t.address, {
    ...record,
    outcome,
    txId: result.txId,
    orderId: result.orderId ?? record.orderId,
    orderState: d.action === 'place' && result.outcome === 'Commit' ? 'open' : null,
  })
  if (d.action === 'cancel' && result.outcome === 'Commit' && d.orderId) observeOrder(t.address, d.orderId, 'cancelled', result.txId)
  return { ...result, journalId: entry.id }
}

/**
 * Read every order this wallet placed that was open when last seen. One the chain now shows FILLED
 * becomes the maker's "Order filled" (its payout is then counted by the scans); CANCELLED is noted.
 * Returns how many changed. Unreadable orders are left as they were.
 */
export async function refreshOwnOrders(walletAddress: string): Promise<number> {
  let changed = 0
  // Orders found on chain before their payout was recorded: read how each pays its maker, once, so a
  // fill's private payout is this order's "Order filled" and not an unknown receive.
  for (const r of loadTradeState(walletAddress).records) {
    if (r.action !== 'place' || !r.orderId || r.gets !== null) continue
    try {
      const o = await readOrder(r.orderId)
      if (!o) continue
      let id: string | null = null
      try { id = payoutOutputIdOf(o) } catch { /* unreadable statement: the leg alone */ }
      if (notePayout(walletAddress, r.orderId, payoutLegOf(o), id)) changed++
    } catch { /* not served verified right now: next refresh */ }
  }
  // Closed orders whose closing transaction is not on record yet (recovered before it was looked up,
  // or recorded by an older version): find it once, for the time of its "Order filled" row.
  for (const r of loadTradeState(walletAddress).records) {
    if (r.action !== 'place' || !r.orderId || r.closedTxId) continue
    if (r.orderState !== 'filled' && r.orderState !== 'cancelled') continue
    const ev = await orderOutcomeFromEvents(r.orderId)
    if (ev && ev.state === r.orderState) { observeOrder(walletAddress, r.orderId, ev.state, ev.txId); changed++ }
  }
  for (const r of ownOpenOrders(walletAddress)) {
    let state: 'open' | 'filled' | 'cancelled' | null = null
    let txId: string | null = null
    try {
      const o = await readOrder(r.orderId!)
      if (o) state = o.status === ORDER_FILLED ? 'filled' : o.status === ORDER_CANCELLED ? 'cancelled' : 'open'
    } catch {
      // Not served verified right now — just after a fill or cancel, typically. The order's own
      // engine-stamped event says what happened; without one, try again on the next refresh.
      const ev = await orderOutcomeFromEvents(r.orderId!)
      if (ev) { state = ev.state; txId = ev.txId }
    }
    if (!state || state === r.orderState) continue
    // The transaction that closed it, for its time (the indexer's, on every device).
    if (state !== 'open' && txId === null) txId = (await orderOutcomeFromEvents(r.orderId!))?.txId ?? null
    observeOrder(walletAddress, r.orderId!, state, txId)
    changed++
  }
  // A cancel of ours made ELSEWHERE (another device, or before this device's journal held it): what it
  // created is this wallet's own — the escrow back and the fee's change — read once from its result,
  // so those outputs are its "Cancelled" row's and never "Received · Sender unknown". A FILL's
  // closing transaction is the taker's: nothing of it is ours but the payout (payoutOutputId).
  for (const r of loadTradeState(walletAddress).records) {
    if (r.action !== 'place' || !r.orderId || r.orderState !== 'cancelled' || !r.closedTxId || r.closeOutputIds) continue
    const ids = await fetchCreatedUtxoIds(r.closedTxId)
    if (ids !== null && noteCloseOutputs(walletAddress, r.orderId, ids)) changed++   // null: a hole — next refresh
  }
  return changed
}

/** How far past the last cancel key found to keep looking (placements that failed leave gaps). */
export const CANCEL_KEY_GAP = 20

/**
 * Find this wallet's orders on the Board from its seed: derive cancel keys 0, 1, 2, … and match each
 * against the key every order's `cancel` rule names, until CANCEL_KEY_GAP keys in a row match nothing.
 * Records what it finds (so open ones can be cancelled) and moves `nextCancelIndex` past them.
 */
export async function recoverTradeState(t: Pick<Trader, 'address' | 'tradeRoot'>): Promise<{ found: number; nextCancelIndex: number }> {
  const byKey = new Map<string, Awaited<ReturnType<typeof readOrder>>>()
  for (const id of await listBoardOrderIds()) {
    try {
      const o = await readOrder(id)
      if (o && o.template === TRADE_ORDER_TEMPLATE && o.board === TRADE_BOARD_ADDRESS && o.cancelKeyHex) byKey.set(o.cancelKeyHex, o)
    } catch { /* an unreadable order cannot be claimed as ours */ }
  }
  const found: TradeRecord[] = []
  let next = 0
  for (let i = 0, misses = 0; misses < CANCEL_KEY_GAP; i++) {
    const pk = Array.from(await cancelKeyFor(t.tradeRoot, i).getPublicKey(), b => b.toString(16).padStart(2, '0')).join('')
    const o = byKey.get(pk)
    if (!o) { misses++; continue }
    misses = 0
    next = i + 1
    // A restore dates an old fill by its closing transaction, on the indexer — when it happened.
    found.push(foundOrderRecord(o, i, o.status === ORDER_OPEN ? null : (await orderOutcomeFromEvents(o.id))?.txId ?? null))
  }
  recordRecovery(t.address, next, found)
  return { found: found.length, nextCancelIndex: Math.max(next, loadTradeState(t.address).nextCancelIndex) }
}

// ── The wallet's own refresh: orders placed ELSEWHERE ─────────────────────────
//
// Before this, an order placed on another device (or by the harness) reached this device's store only
// through the Trade page's market read or the one-time search before a first placement here. The
// wallet's refresh re-read only orders already known — so a fill of an order the store never learned
// of had no "Order filled" row, and its private TARI payout surfaced as "Received · Sender unknown".
// Every refresh now finds this wallet's orders itself. An order's cancel key never changes, so each
// Board order is read ONCE per session; a refresh reads only orders listed since the last one.

/** Board order id → the cancel key its `cancel` rule names (null: not a Caravel Trade order). */
export type BoardKeyCache = Map<string, string | null>
const sessionBoardKeys: BoardKeyCache = new Map()
/** This session's derived cancel public keys, per trade root (derivation is local, but not free). */
const sessionCancelKeys = new WeakMap<Uint8Array, string[]>()

async function cancelKeysUpTo(tradeRoot: Uint8Array, upTo: number): Promise<string[]> {
  const keys = sessionCancelKeys.get(tradeRoot) ?? []
  while (keys.length <= upTo) {
    keys.push(Array.from(await cancelKeyFor(tradeRoot, keys.length).getPublicKey(), b => b.toString(16).padStart(2, '0')).join(''))
  }
  sessionCancelKeys.set(tradeRoot, keys)
  return keys
}

/** How many Board orders are read at once when a refresh meets new ones. */
const DISCOVERY_READS_AT_ONCE = 6

/**
 * Record every order of this wallet's on the Board that its store does not hold. Returns how many.
 * An order that cannot be read now is left for the next refresh (never cached as "not ours").
 */
export async function discoverOwnOrders(t: Pick<Trader, 'address' | 'tradeRoot'>, cache: BoardKeyCache = sessionBoardKeys): Promise<number> {
  const unread = (await listBoardOrderIds()).filter(id => !cache.has(id))
  for (let i = 0; i < unread.length; i += DISCOVERY_READS_AT_ONCE) {
    await Promise.all(unread.slice(i, i + DISCOVERY_READS_AT_ONCE).map(async id => {
      try {
        const o = await readOrder(id)
        if (!o) return
        cache.set(id, o.template === TRADE_ORDER_TEMPLATE && o.board === TRADE_BOARD_ADDRESS ? o.cancelKeyHex : null)
      } catch { /* not served verified right now: read again next refresh */ }
    }))
  }

  const state = loadTradeState(t.address)
  const known = new Set(state.records.filter(r => r.action === 'place').map(r => r.orderId))
  const byKey = new Map<string, string>()
  for (const [id, key] of cache) if (key) byKey.set(key, id)
  const found: TradeRecord[] = []
  let next = 0
  // From key 0 up past the last key in use, as a restore searches (failed placements leave gaps).
  for (let i = 0, horizon = state.nextCancelIndex + CANCEL_KEY_GAP; i <= horizon; i++) {
    const id = byKey.get((await cancelKeysUpTo(t.tradeRoot, horizon))[i])
    if (!id) continue
    next = i + 1
    horizon = Math.max(horizon, i + CANCEL_KEY_GAP)
    if (known.has(id)) continue
    try {
      const o = await readOrder(id)
      if (o) found.push(foundOrderRecord(o, i, o.status === ORDER_OPEN ? null : (await orderOutcomeFromEvents(o.id))?.txId ?? null))
    } catch { /* next refresh */ }
  }
  if (found.length > 0 || next > state.nextCancelIndex) recordRecovery(t.address, next, found)
  return found.length
}

/**
 * The wallet's refresh of its trades (WalletContext, each rescan): find orders placed elsewhere, then
 * re-read every open one. Best-effort throughout — the balance never waits on, or fails with, this.
 */
export async function syncOwnOrders(t: Pick<Trader, 'address' | 'tradeRoot'>): Promise<number> {
  const found = await discoverOwnOrders(t).catch(() => 0)
  return found + await refreshOwnOrders(t.address)
}
