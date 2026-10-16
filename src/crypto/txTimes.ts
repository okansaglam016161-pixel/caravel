// When a transaction happened, from the INDEXER — the same answer on every device and after a restore.
//
// `transaction.created_at` (crypto/burnWallet.parseTxCreatedAt: not `finalized_at`, which jumps when an
// indexer resyncs). The indexer forgets old transaction bodies, so when it no longer has one the time is
// ESTIMATED from the epoch its receipt names — marked `estimated`, and shown with "~". Nothing local
// (a clock on this device, a journal) is ever used as the time of a trade.
//
// Fetched once per transaction per session and cached; subscribers hear about each new answer, so a
// list re-sorts as times arrive.

import { currentEpoch, estimateEpochTime, parseTxCreatedAt } from './burnWallet'
import { pointRead } from './indexerConfig'

export interface TxTime {
  /** epoch-ms, or null when neither the time nor an estimate could be had. */
  at: number | null
  /** True when estimated from the epoch (the indexer no longer has the exact time). */
  estimated: boolean
}

const cache = new Map<string, TxTime>()
const inflight = new Map<string, Promise<TxTime>>()
const listeners = new Set<() => void>()
let epoch: { at: number; value: Promise<number | null> } | null = null
const EPOCH_REUSE_MS = 60_000

function epochNow(now: number): Promise<number | null> {
  if (!epoch || now - epoch.at > EPOCH_REUSE_MS) epoch = { at: now, value: currentEpoch() }
  return epoch.value
}

/** The cached time of `txId`, if it has been read. */
export function knownTxTime(txId: string): TxTime | undefined {
  return cache.get(txId)
}

/** The time of `txId` — read once (an unanswered read is not cached, so it is asked again later). */
export function txTime(txId: string, now = Date.now()): Promise<TxTime> {
  const hit = cache.get(txId)
  if (hit) return Promise.resolve(hit)
  let p = inflight.get(txId)
  if (!p) {
    p = (async () => {
      const tx = await pointRead(`/transactions/${txId}`)
      const exact = parseTxCreatedAt(tx.body)
      if (exact !== null) return remember(txId, { at: exact, estimated: false })
      const receipt = await pointRead(`/transaction-receipts/${txId}`)
      const e = (receipt.body as { receipt?: { epoch?: unknown } } | null)?.receipt?.epoch
      if (typeof e === 'number') {
        const current = await epochNow(now)
        if (current !== null) return remember(txId, { at: estimateEpochTime(e, current, now), estimated: true })
      }
      const none = { at: null, estimated: false }
      // Both reads answered and neither had it: that is the answer. Otherwise ask again next time.
      return tx.answered && receipt.answered ? remember(txId, none) : none
    })().finally(() => inflight.delete(txId))
    inflight.set(txId, p)
  }
  return p
}

function remember(txId: string, t: TxTime): TxTime {
  cache.set(txId, t)
  for (const l of listeners) l()
  return t
}

export function subscribeTxTimes(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

/** Test seam. */
export function __resetTxTimesForTests(): void { cache.clear(); inflight.clear(); epoch = null }
