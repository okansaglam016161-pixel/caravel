// When a transaction happened, from the INDEXER — the same answer on every device and after a restore.
//
// `transaction.created_at` (crypto/burnWallet.parseTxCreatedAt: not `finalized_at`, which jumps when an
// indexer resyncs). The indexer forgets old transaction bodies, so when it no longer has one the time is
// ESTIMATED from the epoch its receipt names — marked `estimated`, and shown with "~". Nothing local
// (a clock on this device, a journal) is ever used as the time of a trade.
//
// Fetched once per transaction per session and cached; subscribers hear about each new answer, so a
// list re-sorts as times arrive.

import { parseTxCreatedAt } from './burnWallet'
import { pointRead } from './indexerConfig'

/**
 * THE EPOCH ESTIMATE, FROM ON-CHAIN DATA ONLY — the same on every device.
 *
 * It used to be "now − (current epoch − epoch) × an epoch's length": this device's clock, and the
 * epoch the indexer reported at the moment of the fetch. Two browsers then put the same transaction
 * minutes apart, so rows with estimated times sorted differently, and the transaction-id tie-break
 * never got a chance. Now it is a fixed anchor (an epoch and a time, both read from the chain) plus
 * the epoch difference at a fixed length: a function of the transaction's epoch alone. Two
 * transactions in one epoch get the same estimate, and their order is the tie-break's.
 *
 * Measured on esmeralda: transaction 995bbd88… was created at 2026-10-16 10:31:32 UTC in epoch
 * 12341; epochs 12015 (2026-10-08 19:18 UTC) to 12341 average 2,023 s (12299 → 12341: 2,036 s).
 * Good to within an epoch or so near the anchor, which is all a "~" promises.
 */
export const EPOCH_ANCHOR = { epoch: 12341, at: Date.UTC(2026, 9, 16, 10, 31, 32) }
export const EPOCH_MS = 2_023_000

/** The estimated time of something that committed in `epoch` — deterministic. */
export function estimateFromEpoch(epoch: number): number {
  return EPOCH_ANCHOR.at + (epoch - EPOCH_ANCHOR.epoch) * EPOCH_MS
}

export interface TxTime {
  /** epoch-ms, or null when neither the time nor an estimate could be had. */
  at: number | null
  /** True when estimated from the epoch (the indexer no longer has the exact time). */
  estimated: boolean
}

const cache = new Map<string, TxTime>()
const inflight = new Map<string, Promise<TxTime>>()
const listeners = new Set<() => void>()

/** The cached time of `txId`, if it has been read. */
export function knownTxTime(txId: string): TxTime | undefined {
  return cache.get(txId)
}

/** The time of `txId` — read once (an unanswered read is not cached, so it is asked again later). */
export function txTime(txId: string): Promise<TxTime> {
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
      if (typeof e === 'number') return remember(txId, { at: estimateFromEpoch(e), estimated: true })
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
export function __resetTxTimesForTests(): void { cache.clear(); inflight.clear() }
