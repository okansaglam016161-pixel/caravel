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
import { preparePlace, type PlaceParams, type PreparedTrade, type Trader, type TradeResult } from './trade'
import { ORDER_CANCELLED, ORDER_FILLED, ORDER_OPEN, TRADE_BOARD_ADDRESS, TRADE_ORDER_TEMPLATE } from './tradeConfig'
import { listBoardOrderIds, orderOutcomeFromEvents, readOrder } from './tradeRead'
import {
  claimCancelIndex, knownCusdIds, loadTradeState, observeOrder, ownOpenOrders, peekCancelIndex, recordRecovery, recordTrade,
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
  if (d.action === 'cancel' && result.outcome === 'Commit' && d.orderId) observeOrder(t.address, d.orderId, 'cancelled')
  return { ...result, journalId: entry.id }
}

/**
 * Read every order this wallet placed that was open when last seen. One the chain now shows FILLED
 * becomes the maker's "Order filled" (its payout is then counted by the scans); CANCELLED is noted.
 * Returns how many changed. Unreadable orders are left as they were.
 */
export async function refreshOwnOrders(walletAddress: string): Promise<number> {
  let changed = 0
  for (const r of ownOpenOrders(walletAddress)) {
    let state: 'open' | 'filled' | 'cancelled' | null = null
    try {
      const o = await readOrder(r.orderId!)
      if (o) state = o.status === ORDER_FILLED ? 'filled' : o.status === ORDER_CANCELLED ? 'cancelled' : 'open'
    } catch {
      // Not served verified right now — just after a fill or cancel, typically. The order's own
      // engine-stamped event says what happened; without one, try again on the next refresh.
      state = await orderOutcomeFromEvents(r.orderId!)
    }
    if (state && state !== r.orderState) { observeOrder(walletAddress, r.orderId!, state); changed++ }
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
    found.push({
      journalId: `recovered-${o.id}`, action: 'place', txId: null, at: Date.now(),
      side: o.side, n: o.n, p: o.p, tradeFee: o.fee, caravelCut: o.caravelCut, burnCut: o.burnCut,
      pays: null, gets: null, orderId: o.id, cancelIndex: i, cusdOutputIds: [], cusdSpentIds: [], outcome: 'committed', payoutOutputId: null,
      orderState: o.status === ORDER_OPEN ? 'open' : o.status === ORDER_FILLED ? 'filled' : 'cancelled',
      // Seen filled before this device knew of it: no "Order filled" moment to show.
      filledSeenAt: null,
    })
  }
  recordRecovery(t.address, next, found)
  return { found: found.length, nextCancelIndex: Math.max(next, loadTradeState(t.address).nextCancelIndex) }
}
