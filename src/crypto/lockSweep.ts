// Making a lock temporary.
//
// ── THE BUG THIS MODULE EXISTS TO END ────────────────────────────────────────
//
// Stage 1 locks a spend's inputs at submit and resolves them against the verdict: Commit promotes
// them to spent, Reject releases them. There is a third outcome, and it was left to fall through
// both branches (confidentialSend, reveal):
//
//     if (outcome === 'Commit') promoteToSpent(...)
//     else if (outcome === 'Reject') release(...)
//     // Timeout: nothing. The lock stays, and nothing ever looks at it again.
//
// A TIMEOUT USED TO BE THE NORMAL CASE. The send path polled 6 x 5s and the reveal path 8 x 4s
// against a network that settles in 60-90 seconds, so a transaction that committed perfectly
// normally reported `Timeout` more often than not. Every one of those stranded its inputs:
// excluded from the balance, excluded from coin selection, forever. Measured on a real wallet:
// 190 tTARI displayed against 1300 actually held.
//
// The wait now runs on the indexer's SSE stream with a 180s bound (crypto/finality), so a timeout
// is rare and genuinely means something is wrong. This module did not become unnecessary — a lock
// still has to resolve when one does happen, and locks predating the fix are still out there — but
// it went from being the routine repair path to being the safety net it was meant to be.
//
// `lockedTxIds` was written for this and called by nothing. This is the caller.
//
// ── WHAT IT COSTS WHEN NOTHING IS WRONG ──────────────────────────────────────
//
// Nothing. A wallet with no locks does no work and makes no request — the walk is over the locked
// set, which is empty in the ordinary case and holds one transaction for about a minute after a
// spend. That is what lets this run on unlock AND after every scan without anybody noticing.
//
// ── WHY THE FETCHING IS HERE AND THE DECIDING IS NOT ─────────────────────────
//
// `resolveLockAction` lives in spentOutputs, pure, testable against a value. This file is the half
// that cannot be: one GET per locked transaction, a timeout so a dead indexer cannot hang an
// unlock, and the application of a decision it does not make. Same split as reconcile.ts (pure)
// against feeProbe.ts (network), for the same reason — the rule that moves money on and off a
// screen deserves a test that does not need a chain.

import { parseSubstateUtxo, type IndexerGetSubstateResponse } from '@tari-project/ootle'
import { readFinalizedVerdict, type TxVerdict } from './txResult'
import { pointRead } from './indexerConfig'
import {
  loadSpentOutputs, lockedCoinsFor, lockedTxIds, promoteToSpent, recordSweepAttempt, release,
  resolveLockAction, type LockAction,
} from './spentOutputs'


/**
 * How a transaction's result is obtained. Injectable for the same reason readRevealedBalance's
 * vault resolver is: it keeps the policy tests off the network without mocking the module graph.
 *
 * Returns the parsed body, or `null` for every failure — 404, a dead host, a malformed body. The
 * caller does not distinguish them, because they all mean the same thing here: no answer, keep the
 * lock, ask again next time.
 */
export type TxResultFetcher = (txId: string) => Promise<unknown | null>

/**
 * How long a lock must have stood before the COIN is asked about instead of the transaction.
 *
 * ── WHY THIS FALLBACK HAD TO EXIST ──────────────────────────────────────────
 *
 * The transaction-result endpoint FORGETS. Measured on Esmeralda: two transactions committed
 * earlier the same day — a faucet claim and a confidential send — both answered
 * `404 Transaction ... not found` within hours. So a lock stranded by a timeout is resolvable
 * only inside the indexer's retention window, and the wallets this work exists to repair are
 * exactly the ones whose locks are older than that. A sweep that could only read transaction
 * results would leave every historical strand permanently unresolved, which is the bug.
 *
 * THE COIN IS THE BETTER ORACLE ANYWAY, and it does not expire. `/substates/<utxoId>` answers
 * about the output itself:
 *
 *     live  — a full Utxo body with an `output`. This coin was never consumed.
 *     gone  — 404, or `{"error":"Input substate utxo_..._429c5ed6... is down"}`, which is the
 *             same sentence the chain returns when a transaction tries to spend it.
 *
 * That is a direct answer to the only question a lock is actually asking.
 *
 * ── AND WHY IT WAITS ────────────────────────────────────────────────────────
 *
 * A coin whose transaction is genuinely still in flight is ALSO live — it has not been consumed
 * yet — so applying this immediately would release the inputs of a transaction mid-decision and
 * invite a self-double-spend. Thirty minutes is far past any decision window (the poll gives up at
 * 30 seconds; consensus is minutes) and costs nothing, because the ordinary case never reaches
 * here: a fresh timeout resolves from the transaction result while it is still retained.
 */
export const STALE_LOCK_MS = 30 * 60_000

/** What the chain says about one output. `unknown` means we could not find out. */
export type CoinState = 'live' | 'gone' | 'unknown'

/** How a coin's state is obtained. Injectable for the same reason the result fetcher is. */
export type SubstateProbe = (utxoId: string) => Promise<CoinState>

const fetchTxResult: TxResultFetcher = async (txId) =>
  (await pointRead(`/transactions/${encodeURIComponent(txId)}/result`)).body

const probeSubstate: SubstateProbe = async (utxoId) => {
  // ACROSS EVERY INDEXER — and this is the read where that matters most. `gone` promotes a lock to
  // `spent`, permanently excluding the coin, so believing one node's 404 would let a node that
  // merely lacks the substate condemn a live output. indexerConfig.pointRead reports an absence
  // only once EVERY node has said 404, and `answered: false` when none of them spoke at all.
  const read = await pointRead(`/substates/${encodeURIComponent(utxoId)}`)
  if (!read.answered) return 'unknown'
  if (read.body === null) return 'gone'   // every node agreed it is not there

  // parseSubstateUtxo is the SDK's own structural check and returns null for a spent or frozen
  // output — the same call paymentResolver uses to tell "gone" from "not ours".
  try {
    return parseSubstateUtxo(read.body as IndexerGetSubstateResponse, utxoId) === null ? 'gone' : 'live'
  } catch { return 'gone' }
}

/** What the sweep did about one locked transaction. Diagnostic — the harness prints these. */
export interface SweepStep {
  txId: string
  /** `null` when the chain has not decided, or when the result could not be fetched at all. */
  verdict: TxVerdict | null
  action: LockAction
  /** Which oracle decided it: the transaction's result, or the coins themselves. */
  via: 'result' | 'substate' | 'none'
  /** Coins moved locked → spent, or released back to available. */
  affected: number
}

export interface SweepResult {
  /** Locked transactions examined. Zero means there was nothing to do and no request was made. */
  swept: number
  /** How many of them reached a verdict and stopped being locks. */
  resolved: number
  steps: SweepStep[]
}

/**
 * Resolve every lock this wallet is still holding, against what the chain actually says.
 *
 * ── THE ONE EDGE THAT LOOKS LIKE A BUG AND IS NOT ───────────────────────────
 *
 * A transaction that succeeded has its inputs promoted to `spent` here — correct, they are gone —
 * while the CHANGE output it created may not be in the `/utxos` listing yet. For that window the
 * balance is genuinely understated by roughly the change amount.
 *
 * That is indexer lag, not a fault in this module, and it fixes itself the moment the change
 * lists. It is also exactly what the settle loop (context/settle.ts) was built to wait through.
 * Do not "fix" it by delaying the promotion: holding an input as spendable after the chain has
 * consumed it is how a wallet builds a transaction against a down input.
 */
export async function sweepLocks(
  walletAddress: string,
  opts: { fetchResult?: TxResultFetcher; probeCoin?: SubstateProbe; now?: number } = {},
): Promise<SweepResult> {
  if (!walletAddress) return { swept: 0, resolved: 0, steps: [] }

  const txIds = lockedTxIds(loadSpentOutputs(walletAddress))
  // THE ZERO-COST PATH, and the one almost every call takes. No locks, no requests, no writes.
  if (txIds.length === 0) return { swept: 0, resolved: 0, steps: [] }

  const fetchResult = opts.fetchResult ?? fetchTxResult
  const probeCoin = opts.probeCoin ?? probeSubstate
  const now = opts.now ?? Date.now()
  const steps: SweepStep[] = []
  let resolved = 0

  for (const txId of txIds) {
    const body = await fetchResult(txId)
    // An unfetchable result and an undecided one are the same instruction — see resolveLockAction.
    const verdict = body === null ? null : readFinalizedVerdict(body)
    let action = resolveLockAction(verdict)
    let via: SweepStep['via'] = verdict === null ? 'none' : 'result'

    // ── THE FALLBACK: ASK ABOUT THE COINS ────────────────────────────────────
    //
    // Only when the transaction itself could tell us nothing, and only once the lock is too old to
    // be a transaction in flight. See STALE_LOCK_MS for both halves of that.
    if (action === 'keep') {
      const coins = lockedCoinsFor(loadSpentOutputs(walletAddress), txId)
      const oldest = coins.reduce((m, c) => Math.min(m, c.at), Number.POSITIVE_INFINITY)
      if (coins.length > 0 && now - oldest >= STALE_LOCK_MS) {
        const states = await Promise.all(coins.map(c => probeCoin(c.id)))
        // UNANIMITY OR NOTHING. A transaction consumes all of its inputs or none of them, so a
        // mixed answer means the chain is telling us something we do not understand — and one
        // `unknown` is enough to make the whole reading untrustworthy. Either way: keep the lock.
        if (states.every(st => st === 'gone')) { action = 'promote'; via = 'substate' }
        else if (states.every(st => st === 'live')) { action = 'release'; via = 'substate' }
      }
    }

    let affected = 0
    if (action === 'promote') {
      affected = promoteToSpent(walletAddress, txId, now).promoted
      resolved++
    } else if (action === 'release') {
      affected = release(walletAddress, txId, now).released
      resolved++
    } else {
      // Still unresolved. Counted so the safety net can eventually say so out loud rather than
      // letting the wallet go on quietly subtracting money nobody can explain.
      affected = recordSweepAttempt(walletAddress, txId, now).counted
    }
    steps.push({ txId, verdict, action, via, affected })
  }

  return { swept: txIds.length, resolved, steps }
}
