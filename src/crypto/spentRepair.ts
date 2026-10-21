// Giving back the coins the Ootle 0.47 shape change condemned.
//
// ── WHAT WENT WRONG ──────────────────────────────────────────────────────────
//
// From 2026-10-20 05:43 UTC (Ootle v0.47.0) until hotfix-0.47 shipped, `GET /substates/<id>` came
// back in a shape this wallet did not read (crypto/substateShape). The lock sweep's fallback probe
// (crypto/lockSweep) asks that route whether a locked coin still exists, read the new shape as
// "gone", and promoted the lock to `spent`. A `spent` record is permanent by design, so a coin that
// was never spent stayed excluded from the balance and from selection after the read was fixed.
//
// ── WHICH RECORDS ARE LOOKED AT ──────────────────────────────────────────────
//
// A record keeps the time it was LOCKED, not the time it was promoted, so the window above cannot
// be applied to it directly. What can be applied is the probe's own rule: it only ever ran on a lock
// at least STALE_LOCK_MS old. So every `spent` record older than that is a candidate, a superset of
// the ones the broken probe can have touched, with no end cut-off. The wider net is safe because a
// coin is only restored on the chain's say-so:
//
//   - its transaction is NOT a known Accept (or an unreadable verdict, which is kept by the same
//     asymmetry as resolveLockAction). An Accept consumed the coin whatever an indexer serves;
//   - EVERY indexer answers with a VERIFIED, LIVE UTXO. One node is not enough: an indexer has been
//     measured serving a just-spent coin as verified and live for a minute after it went down.
//
// Every node gone keeps the record (it is correct). Any other mix leaves it unresolved for the next
// run.
//
// ── ONE-TIME, AND IDEMPOTENT ─────────────────────────────────────────────────
//
// A run that resolves every candidate marks the wallet done and the repair never runs for it again.
// A run that leaves anything unresolved (an unreachable node, a split answer) marks nothing and runs
// again at the next unlock. Restoring an already-restored coin is a no-op, so a run that is cut off
// halfway and repeated cannot do anything twice.

import { INDEXER_URLS, POINT_READ_TIMEOUT_MS, pointRead } from './indexerConfig'
import { fetchWithRetry } from './indexerRetry'
import { STALE_LOCK_MS } from './lockSweep'
import { loadSpentOutputs, restoreLiveSpent, spentRecordReadable } from './spentOutputs'
import { upgradeSubstateBody } from './substateShape'
import { readFinalizedVerdict, type TxVerdict } from './txResult'

/** One node's view of one coin. */
export type NodeVote = 'live' | 'gone' | 'unknown'

/** Each indexer's answer for a coin, in INDEXER_URLS order. Injectable for tests. */
export type CoinReader = (utxoId: string) => Promise<NodeVote[]>
/** A transaction's verdict, `null` when nothing definite could be read. Injectable for tests. */
export type VerdictReader = (txId: string) => Promise<TxVerdict | null>

export interface SpentRepairReport {
  /** True when this wallet was already done and nothing was read. */
  skipped: boolean
  candidates: number
  restored: string[]
  /** Proven gone, or consumed by an Accept: the record was right. */
  kept: number
  unresolved: number
  /** Marked done by this run. */
  done: boolean
}

function doneKey(walletAddress: string) { return `caravel.spentrepair047.v1.${walletAddress}` }

function isDone(walletAddress: string): boolean {
  try { return localStorage.getItem(doneKey(walletAddress)) !== null } catch { return false }
}

function markDone(walletAddress: string, now: number): boolean {
  try { localStorage.setItem(doneKey(walletAddress), String(now)); return true } catch { return false }
}

/** A live, verified, unfrozen UTXO, in either indexer shape. */
function voteFrom(body: unknown): NodeVote {
  const upgraded = upgradeSubstateBody(body)
  if (upgraded === null) return 'gone'
  const b = upgraded as { verified?: unknown; substate?: { Utxo?: { output?: unknown } } } | null
  const utxo = b?.substate?.Utxo
  if (!utxo || typeof utxo !== 'object') return 'unknown'
  if (utxo.output == null) return 'gone'          // spent or frozen: answers 200 with no output
  return b?.verified === true ? 'live' : 'unknown'
}

const readCoinOnEveryNode: CoinReader = async (utxoId) => {
  const path = `/substates/${encodeURIComponent(utxoId)}`
  return Promise.all(INDEXER_URLS.map(async (base): Promise<NodeVote> => {
    try {
      const res = await fetchWithRetry([base], path, {}, { attempts: 2, timeoutMs: POINT_READ_TIMEOUT_MS })
      if (res.status === 404) return 'gone'
      if (!res.ok) return 'unknown'
      return voteFrom(await res.json() as unknown)
    } catch { return 'unknown' }
  }))
}

const readVerdict: VerdictReader = async (txId) => {
  const read = await pointRead(`/transactions/${encodeURIComponent(txId)}/result`)
  return read.body === null ? null : readFinalizedVerdict(read.body)
}

/**
 * Re-check this wallet's old `spent` records against the chain and restore the live ones.
 *
 * Never throws for a network reason: an unreadable answer is `unresolved` and the run repeats at
 * the next unlock.
 */
export async function repairShapeBreakSpends(
  walletAddress: string,
  opts: { readCoin?: CoinReader; readTxVerdict?: VerdictReader; now?: number } = {},
): Promise<SpentRepairReport> {
  const report: SpentRepairReport = { skipped: false, candidates: 0, restored: [], kept: 0, unresolved: 0, done: false }
  if (!walletAddress) return { ...report, skipped: true }
  if (isDone(walletAddress)) return { ...report, skipped: true }
  // A record that cannot be opened reads as empty. "No candidates" would then be a guess, and
  // marking done on it would end the repair before it ever looked.
  if (!spentRecordReadable(walletAddress)) return report

  const now = opts.now ?? Date.now()
  const readCoin = opts.readCoin ?? readCoinOnEveryNode
  const readTxVerdict = opts.readTxVerdict ?? readVerdict

  // Grouped by transaction: the verdict is one read per transaction, not per coin.
  const byTx = new Map<string, string[]>()
  for (const [id, rec] of Object.entries(loadSpentOutputs(walletAddress).records)) {
    if (rec.status !== 'spent' || now - rec.at < STALE_LOCK_MS) continue
    byTx.set(rec.txId, [...(byTx.get(rec.txId) ?? []), id])
    report.candidates++
  }

  const restore: string[] = []
  for (const [txId, ids] of byTx) {
    const verdict = await readTxVerdict(txId).catch(() => null)
    if (verdict?.kind === 'accept' || verdict?.kind === 'unreadable') { report.kept += ids.length; continue }
    for (const id of ids) {
      const votes = await readCoin(id).catch((): NodeVote[] => [])
      if (votes.length > 0 && votes.every(v => v === 'live')) restore.push(id)
      else if (votes.length > 0 && votes.every(v => v === 'gone')) report.kept++
      else report.unresolved++
    }
  }

  if (restore.length > 0) {
    const { ok, restored } = restoreLiveSpent(walletAddress, restore, now)
    // A lost write restored nothing on disk: count those coins as unresolved so the run repeats.
    if (ok) report.restored = restored
    else report.unresolved += restore.length
  }
  if (report.unresolved === 0) report.done = markDone(walletAddress, now)
  return report
}
