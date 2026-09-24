// Waiting for the network to decide, by being told rather than by asking.
//
// ── THE BUG THIS MODULE EXISTS TO END ────────────────────────────────────────
//
// Every submit path had its own copy of the same loop: poll `/transactions/<id>/result` six or
// eight times, four or five seconds apart, and give up. That is a thirty-second patience against a
// network that takes SIXTY TO NINETY SECONDS to finalise, so the loop did not time out when
// something went wrong — it timed out as a matter of routine, on transactions that were committing
// perfectly normally.
//
// Everything downstream inherited that. `Timeout` is not a verdict, so the spend record could not
// resolve its lock; the lock stranded; the balance stayed short by the locked amount; the settle
// watch never saw its movement, went `lagged`, and pinned the total at "unreadable". One wallet
// read 190 tTARI against 1300 actually held. The whole chain of failures starts with a wallet that
// stopped listening half a minute too early.
//
// ── THE PUSH STREAM WAS ALREADY IN THE DEPENDENCY TREE ───────────────────────
//
// `@tari-project/ootle-indexer` — already a dependency, already installed — ships a
// `TransactionWatcher` that subscribes to the indexer's SSE `/events` stream and resolves when the
// network reports the transaction finalised. `provider.watchTransactionSSE(txId, timeoutMs)`
// returns a handle to it. Nothing in this app had ever called it; the only trace of it was six
// `provider.stopWatcher()` calls, stopping a watcher that was never started.
//
// The endpoint is public and browser-reachable — verified directly:
//
//     GET https://ootle-indexer-a.tari.com/events
//     200  content-type: text/event-stream  access-control-allow-origin: *
//
// ── ONE COPY, BECAUSE FIVE WERE FOUR TOO MANY ────────────────────────────────
//
// Four of the five loops were byte-identical apart from the name of their outcome type, and the
// fifth differed only by also reading the fee receipt. Five copies of "how do we know what the
// network said" is five places for the answer to drift — the same argument utxoFeed makes for
// reading `/utxos`, and stealthUtxos for input selection. This is that argument applied to
// finality.

import type { IndexerProvider, PendingTransaction } from '@tari-project/ootle-indexer'
import { describeFailure, readFinalizedVerdict } from './txResult'
import { pointRead } from './indexerConfig'


/**
 * How long to wait for a decision before giving up, in ms.
 *
 * THREE MINUTES, against a network that settles in sixty to ninety seconds. That ratio is the
 * point: the old thirty seconds sat BELOW the normal settle time, so a timeout carried no
 * information — most of them were healthy transactions. At double the observed upper bound a
 * timeout means something is actually wrong, which is what makes it worth reporting.
 *
 * The cost of the generous bound is bounded too, because this is not a sleep. The SSE stream
 * resolves the moment the network finalises, so a normal transaction returns in its own good time
 * and never approaches this number. Only a genuinely stuck one waits it out.
 */
export const SETTLE_TIMEOUT_MS = 180_000

export type FinalityOutcome =
  /** `Accept`. The transaction committed in full. */
  | 'Commit'
  /** Decided, and not an Accept — including the fee-only commit. `reason` carries the network's words. */
  | 'Reject'
  /** NOT A VERDICT. No decision was readable in time; the caller must not conclude anything. */
  | 'Timeout'

export interface Finality {
  outcome: FinalityOutcome
  /** The network's own words, on `Reject` only. See crypto/txResult.describeFailure. */
  reason?: string
  /**
   * The raw result body, or `null` when none could be read.
   *
   * Returned rather than picked apart here because the five callers want different things from it
   * — the account address out of the up-substates (conceal, reveal, faucet, publicSend), the fee
   * receipt (confidentialSend) — and a module that waits for a decision has no business knowing
   * which. The verdict is read here, once and honestly; everything else is the caller's.
   */
  body: unknown | null
}

/**
 * How often the REST race below re-asks, in ms.
 *
 * ── WHY THERE IS A RACE AT ALL, AND NOT JUST A WATCHER ──────────────────────
 *
 * The SSE stream is real, open and CORS-clean, and on Esmeralda today it carries NOTHING. Measured
 * directly against both public indexers: a hundred seconds of `GET /events` on indexer-a and sixty
 * on indexer-b produced only the keep-alive comment lines (`:`) that an event stream sends to hold
 * the connection open. No `TransactionFinalized` event ever arrived.
 *
 * So a watcher alone would wait out its whole timeout on every transaction and then read the
 * verdict from REST at the end — measured, on a real send: 181 seconds for a decision the chain
 * had made in about ninety. That is better than the old thirty-second give-up, which reported a
 * healthy transaction as a `Timeout`, but it is three minutes of a user watching a spinner for no
 * reason.
 *
 * Racing fixes both ends without betting on either. The REST side answers at roughly the network's
 * real settle time whatever the stream does; the watcher answers instantly the day the indexer
 * starts emitting, and costs nothing in the meantime. Five seconds is the old loop's cadence — the
 * cadence was never the bug, the thirty-second ceiling was.
 */
const POLL_INTERVAL_MS = 5_000

/**
 * Whether to open the SSE stream as the other half of the race. CURRENTLY OFF, for two measured
 * reasons — neither of them "SSE is the wrong idea".
 *
 * ── 1. IT DELIVERS NOTHING TODAY ────────────────────────────────────────────
 *
 * `GET /events` on indexer-a for a hundred seconds, and indexer-b for sixty, produced only the
 * keep-alive comment lines that hold an event stream open. No `TransactionFinalized` ever arrived,
 * on either node. Every verdict this wallet has read came from REST.
 *
 * ── 2. STOPPING IT CRASHES, AND THE DEFECT IS NOT OURS ──────────────────────
 *
 * @tari-project/ootle-indexer's stream generator ends with:
 *
 *     } finally {
 *       a2.cancel();        // reader.cancel(), on a stream that was just aborted
 *     }
 *
 * `cancel()` on an errored stream returns a REJECTED promise, and that one is neither awaited nor
 * caught. So `provider.stopWatcher()` — which aborts the reader — always leaves an unhandled
 * rejection behind. It killed the harness outright on the first real send after this module
 * shipped; in a browser it is an unhandled rejection on every transaction. Nothing on our side can
 * attach a handler to it: the promise is created inside a private async generator.
 *
 * The only alternative is to never stop the watcher, and each spend path builds its own provider —
 * so that trades one console error per transaction for one permanently open connection per
 * transaction. A leak is worse than a warning, and both are worse than not opening it.
 *
 * ── WHY THE CODE STAYS ──────────────────────────────────────────────────────
 *
 * It is one constant. When the indexer starts emitting events, or the SDK awaits that `cancel()`,
 * flipping this to `true` turns the push side of the race back on and nothing else has to change.
 * The race was built for exactly that: the stream wins when it can, REST carries it when it
 * cannot, and callers never learn which.
 */
export const USE_SSE_WATCHER = false

/**
 * One REST read of the result, used by both the race and the final fallback. Never throws.
 *
 * ACROSS EVERY INDEXER, because the nodes disagree. A verdict one node has not indexed yet is not
 * a verdict that does not exist, and concluding `Timeout` from a single node's silence is what
 * strands a transaction's inputs until a sweep comes along. See indexerConfig.pointRead.
 */
async function fetchResultOnce(txId: string): Promise<unknown | null> {
  return (await pointRead(`/transactions/${encodeURIComponent(txId)}/result`)).body
}

/** Sleep, waking early if the race has already been decided. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(finish, ms)
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** A body carries a decision when crypto/txResult can read a verdict out of it. */
const isDecisive = (body: unknown | null) => body !== null && readFinalizedVerdict(body) !== null

/**
 * Wait for `txId` to be decided, and report what the network actually said.
 *
 * ── TWO WAYS TO HEAR, WHICHEVER SPEAKS FIRST ────────────────────────────────
 *
 * The SSE watcher and a REST poll run against each other and the first DECISIVE answer wins — a
 * body crypto/txResult can read a verdict from. Neither is trusted to be the only one working:
 * today the stream is silent and REST carries every verdict; if that changes, the watcher wins the
 * race and the polling stops on the same tick. See POLL_INTERVAL_MS for the measurements behind
 * that.
 *
 * ── THE VERDICT IS READ HERE, NOT TAKEN FROM THE WATCHER ────────────────────
 *
 * `PendingTransaction.watch()` resolves on a commit and THROWS on anything else — including
 * `FeeIntentCommit`, which it folds into a rejection error. That classification is close to right
 * but it is not ours, and this codebase has been bitten once already by trusting somebody else's
 * summary of a three-variant union (see crypto/txResult, and the fee-only commit that was reported
 * to users as a success). So the watcher is used for its TIMING and the verdict is read from the
 * receipt by `readFinalizedVerdict`. A rejection thrown by `watch()` is caught and ignored.
 *
 * ── A TIMEOUT IS STILL NOT A VERDICT ────────────────────────────────────────
 *
 * It means nothing was legible in time, so callers must leave the transaction's inputs LOCKED —
 * crypto/lockSweep resolves them against the chain later. That contract is unchanged; what changes
 * is how rarely it is reached.
 */
export async function awaitFinality(
  provider: IndexerProvider,
  txId: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number; useStream?: boolean } = {},
): Promise<Finality> {
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  const useStream = opts.useStream ?? USE_SSE_WATCHER
  const ctrl = new AbortController()

  // Held outside the closure so the race can CANCEL it — see the cleanup below. A box rather than
  // a bare `let` because the only assignment happens inside the async closure, which narrows a
  // plain binding to `never` at the read site.
  const handle: { current: PendingTransaction | null } = { current: null }

  // The watcher's own read. Its throw is deliberately ignored — the receipt is the source of truth.
  const viaStream = !useStream ? Promise.resolve<unknown | null>(null) : (async (): Promise<unknown | null> => {
    try {
      const pending = provider.watchTransactionSSE(txId, timeoutMs)
      handle.current = pending
      try { await pending.watch() } catch { /* rejection, timeout or cancellation — read anyway */ }
      if (ctrl.signal.aborted) return null
      try { return await pending.getReceipt() } catch { return null }
    } catch { return null }   // the watcher could not be created at all
  })()

  // The REST side, which is the one carrying every verdict today.
  const viaPolling = (async (): Promise<unknown | null> => {
    const deadline = Date.now() + timeoutMs
    let last: unknown | null = null
    while (!ctrl.signal.aborted && Date.now() < deadline) {
      await delay(pollIntervalMs, ctrl.signal)
      if (ctrl.signal.aborted) return last
      const body = await fetchResultOnce(txId)
      if (body !== null) last = body
      if (isDecisive(body)) return body
    }
    return last
  })()

  // FIRST DECISIVE ANSWER WINS. If both finish without one, the last body seen is kept for the
  // caller's diagnostics and the outcome below reads as a Timeout.
  const body = await new Promise<unknown | null>(resolve => {
    let outstanding = 2
    let fallback: unknown | null = null
    const settle = (result: unknown | null) => {
      if (isDecisive(result)) return resolve(result)
      if (result !== null) fallback = result
      if (--outstanding === 0) resolve(fallback)
    }
    void viaStream.then(settle, () => settle(null))
    void viaPolling.then(settle, () => settle(null))
  })

  // ── STOP THE LOSER, AND DEREGISTER THE WATCH BEFORE THE CALLER STOPS THE STREAM ──
  //
  // `cancel()` is not tidiness. Every caller calls `provider.stopWatcher()` next, and that aborts
  // the AbortSignal the SSE reader is sitting on — which rejects the SDK's own internal stream
  // promise. While a watch is still registered nothing is holding that promise, so the rejection
  // escapes as an UNHANDLED REJECTION: it crashed the harness outright on the first real send
  // after this module shipped, and in a browser it would surface on every transaction.
  //
  // Cancelling first deregisters this watch, which lets the watcher pause itself (the SDK pauses
  // the stream when nothing is being watched), so the caller's stopWatcher has no live reader to
  // abort. It is documented idempotent, and the promise it rejects is `viaStream`, which already
  // has a handler attached below.
  ctrl.abort()
  try { handle.current?.cancel() } catch { /* already finished, or never created */ }
  // The stream promise is settled either way; attach a terminal handler so a late rejection from
  // the cancellation cannot escape.
  void viaStream.catch(() => undefined)

  const verdict = body === null ? null : readFinalizedVerdict(body)
  if (verdict === null) return { outcome: 'Timeout', body }
  if (verdict.kind === 'accept') return { outcome: 'Commit', body }
  return { outcome: 'Reject', reason: describeFailure(verdict), body }
}
