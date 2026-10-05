// Fee discovery by dry run (Ootle 0.39).
//
// WHY THIS EXISTS. Both write paths used to reserve a HARDCODED fee — 1 000 µtTARI for the faucet
// claim, a 10 000 ceiling for a send. 0.39 changed the fee tables and the faucet's real cost became
// ~13 200, so every claim aborted with `InsufficientFeesPaid`. Replacing one hardcoded number with
// a bigger hardcoded number just moves the outage to the next fee change, so the fee is now ASKED
// FOR rather than assumed: build the transaction, ask the network what it would cost, rebuild
// paying that.
//
// THE SDK'S OWN `sendDryRun` DOES NOT WORK against this indexer, which is why this module exists at
// all rather than being one import. `sendDryRun` sets `dry_run = true` and then hands the envelope
// to `provider.submitTransaction`, which POSTs to `/transactions` — and the indexer refuses:
//   HTTP 400 {"error":"Dry-run transactions must be submitted to the /transactions/dry-run endpoint"}
// `@tari-project/indexer-client@1.6.0` exposes no method for that route, so the provider cannot
// reach it. Verified against the live indexer on 2026-08-20; revisit when the client adds it.
//
// The two halves both matter, and each fails differently if you get it wrong:
//   - the transaction must carry `dry_run: true` INSIDE the sealed envelope, or the dry-run
//     endpoint replies "Non-dry-run transactions must be submitted to the /transactions endpoint";
//   - the body is `{ transaction: <envelope> }`, not the bare envelope.
//
// AND A DRY RUN THAT IS NOT A CLEAN `Accept` IS A FAILURE, not a cheap fee. That is the third thing
// this module has had to learn the hard way — see the check in dryRunFee. A transaction can commit
// its FEE and have everything else rejected, which the network reports as `AcceptFeeRejectRest`
// with a perfectly ordinary-looking fee receipt. Reading only `Reject` let that price as success.

// A dry run is a single round trip against the indexer; this bounds it so a hung request surfaces
// as an error the caller can show rather than a spinner that never resolves.
import { describeRejectReason } from './txResult'
import { INDEXER_URLS } from './indexerConfig'
import { IndexerBusyError, fetchWithRetry } from './indexerRetry'

const DRY_RUN_TIMEOUT_MS = 20_000

// A dry run changes nothing, so a busy (429/503) or unanswering indexer is asked again — up to this
// many attempts, alternating to the other indexer. See indexerRetry.ts.
const DRY_RUN_ATTEMPTS = 4

// THE MARGIN — one rule for every action that pays a fee (send, public send, make public, make
// private, chat payment, faucet claim, @name register).
//
// IT IS NEVER REFUNDED, and that is the fact the old 25% was built on the opposite of. Every path
// pays with PayFeeFromBucket, which spends the WHOLE reserved bucket: the receipt's
// `total_fee_overcharge` is reported, and burned. Measured live on 2026-10-04 across six
// transactions (claim, two sends, make public, make private, @name) — each was charged its full
// reserved fee, and the wallet's balance reconciled to the microtari only with the overcharge
// counted as spent. So the margin is not a float that comes back: it is part of the price, the
// figure the user is shown, and the figure that leaves the wallet.
//
// What it insures against is DRIFT between the dry run and the real submission — the cost depends
// on state (Storage, NativeExecution) that can move in the seconds between. The measurements:
//   - the same six transactions consumed EXACTLY their dry-run cost, to the microtari;
//   - the required fee does not depend on the fee paid (fee-boundary: 9 452 at every payment from
//     1 000 to 11 815), so building the real transaction at a different fee than the probe does
//     not move its cost;
//   - the confirm step re-simulates the final transaction at the exact quoted fee and refuses to
//     submit if the requirement has risen above it (see simulateFee's `underpaid`), so drift is
//     caught before signing rather than absorbed by the margin.
// 2%, floor 200 µtTARI: ~200–300 µtTARI on every fee measured here (9–19k), against the ~2 300–
// 3 800 that 25% spent. The floor covers a fee small enough that 2% rounds to nothing.
export const FEE_MARGIN_PERCENT = 2n
export const FEE_MARGIN_FLOOR = 200n

/**
 * THE EXACT FEE — no margin — for every action whose instructions all sit in the fee intent
 * (private send, chat payment, make public, faucet claim).
 *
 * Safe because a short fee there is FREE. The engine rejects a transaction that does not cover its
 * fee and, with nothing in the main intent to fall back past, persists nothing and takes nothing
 * (tari-ootle 0.43 runtime/tracker.rs finalize). Proven live 2026-10-05 (harness prove-short-fee,
 * tx 8191c003…): paying 15 198 against 15 199 → Reject, fees paid 0, inputs unspent, balance
 * unchanged. So the margin buys nothing but overcharge; a cost that moved is caught at confirm
 * (crypto/quote) or, rarer, by that free reject — and either way the user is asked again.
 *
 * @names keep withFeeMargin: their register calls are in the MAIN intent, and a slightly short fee
 * there can commit the fee intent alone — fee taken, no name.
 */
export function exactFee(costMicrotari: bigint): bigint {
  return costMicrotari
}

/** Measured cost plus the margin: max(FEE_MARGIN_PERCENT of it, FEE_MARGIN_FLOOR). Exact bigint. */
export function withFeeMargin(costMicrotari: bigint): bigint {
  const pct = (costMicrotari * FEE_MARGIN_PERCENT) / 100n
  return costMicrotari + (pct > FEE_MARGIN_FLOOR ? pct : FEE_MARGIN_FLOOR)
}

// The indexer reports 64-bit amounts as either a JSON number or a decimal string depending on the
// field and the version (0.39 moved several to strings). Accept both rather than guessing.
function toBigInt(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v)
  return null
}

/**
 * The three shapes a finalized transaction result can take.
 *
 * ENUMERATED FROM THE BINDINGS, not guessed —
 * `@tari-project/ootle-ts-bindings` `TransactionResult`:
 *
 *     { Accept: SubstateDiff }
 *   | { AcceptFeeRejectRest: [SubstateDiff, RejectReason] }
 *   | { Reject: RejectReason }
 *
 * There is no fourth. `FinalizeOutcome` ("Commit" | "FeeIntentCommit") is the committed-transaction
 * analogue of the same split, and `FinalizeResult.total_fees_required` documents the middle case
 * outright: "When only the fee intent commits, the charges are re-derived over the fee checkpoint
 * alone and so fall below what was paid." The fee IS paid. Only `Accept` is a clean success.
 */
/**
 * `describeRejectReason` MOVED TO txResult.ts, where the submit paths read the same union.
 *
 * It was written here first, for the dry run; the five submit polls then needed the identical
 * unwrapping and the identical three-variant check, so both live in one module now and this file
 * imports what it used to own.
 */

interface DryRunResponse {
  result?: {
    finalize?: {
      result?: { Reject?: unknown; Accept?: unknown; AcceptFeeRejectRest?: unknown }
      fee_receipt?: {
        total_fees_paid?: number | string
        total_fee_overcharge?: number | string
        cost_breakdown?: { breakdown?: Record<string, number | string> }
      }
      total_fees_required?: number | string
    }
  }
}

/**
 * What a dry run said, as data rather than as a throw.
 *
 * `accepted` carries the cost the engine REQUIRES (see measuredCost). Anything that is not a clean `Accept`
 * is `accepted: false` with the network's reason in a sentence fit to show — see the check below
 * for why `AcceptFeeRejectRest` is in that group. A transport failure, a non-OK HTTP status or a
 * malformed body is NOT a verdict and still throws: those say nothing about the transaction.
 *
 * This is the form the confirm-time check and the harness's fee-boundary measurement read, because
 * both need to know WHETHER a transaction is accepted at a given fee, not only what it costs.
 */
export type FeeSimulation =
  | { accepted: true; cost: bigint }
  | { accepted: false; kind: 'reject' | 'fee-only' | 'unrecognised' | 'underpaid'; reason: string; message: string }

/**
 * Ask the network what `envelope` would actually cost, in µtTARI.
 *
 * `envelope` MUST have been sealed from a transaction carrying `dry_run: true` — see the note above.
 * The reserved fee inside it only has to be GENEROUS ENOUGH for execution to complete. In a dry run
 * nothing is charged, so over-reserving the PROBE is free — unlike the real transaction, whose
 * whole reserved fee is spent (see the margin note above). This returns the required cost.
 *
 * Throws with a message fit to show a user on every failure path — a dead indexer, a timeout, a
 * malformed body, or a transaction the network rejects for a reason that is not about fees at all
 * (an under-funded probe shows up here as a Reject, and reporting it verbatim is far more useful
 * than a silent fallback to some default fee).
 */
export async function dryRunFee(
  indexerUrl: string,
  envelope: unknown,
  opts: { onBusyRetry?: () => void } = {},
): Promise<bigint> {
  const sim = await simulateFee(indexerUrl, envelope, opts)
  if (sim.accepted) return sim.cost
  throw new Error(sim.message)
}

/**
 * The same dry run, returning the verdict instead of throwing on a non-Accept. See FeeSimulation.
 *
 * `opts.fee` — the fee the simulated transaction pays — turns on the one check THE DRY RUN DOES NOT
 * MAKE ITSELF. Measured on Esmeralda (2026-10-05, harness `fee-boundary`): a reveal whose cost is
 * 9 452 µtTARI was dry-run paying 11 815, 9 452, 9 451, 9 352, 8 452, 4 726 and 1 000, and EVERY
 * ONE came back `Accept`, its receipt simply reporting the payment as consumed. The simulation
 * does not enforce the fee; a real submission does ("Required fees 16546 but 14791 paid"). What
 * the dry run does report is `total_fees_required` — 9 452 at every one of those payments — so
 * "is this fee enough" is answered by comparing against that, here, and a short payment comes back
 * as `underpaid` rather than as the Accept the network printed.
 */
export async function simulateFee(
  indexerUrl: string,
  envelope: unknown,
  opts: { onBusyRetry?: () => void; fee?: bigint } = {},
): Promise<FeeSimulation> {
  // The named indexer first, then the others: a simulation is answered the same by any of them.
  const urls = [indexerUrl, ...INDEXER_URLS.filter(u => u !== indexerUrl)]
  let resp: Response
  try {
    resp = await fetchWithRetry(urls, '/transactions/dry-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: envelope }),
    }, { attempts: DRY_RUN_ATTEMPTS, timeoutMs: DRY_RUN_TIMEOUT_MS, alternate: true, onBusyRetry: opts.onBusyRetry })
  } catch (e) {
    // Busy throughout: its own message already says what happened and that nothing was sent.
    if (e instanceof IndexerBusyError) throw e
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new Error(
      timedOut
        ? `Could not estimate the network fee: the indexer did not respond within ${DRY_RUN_TIMEOUT_MS / 1000}s.`
        : `Could not estimate the network fee: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Could not estimate the network fee: indexer HTTP ${resp.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }

  let json: DryRunResponse
  try {
    json = await resp.json() as DryRunResponse
  } catch {
    throw new Error('Could not estimate the network fee: the indexer returned a malformed response.')
  }

  const finalize = json.result?.finalize
  if (!finalize) throw new Error('Could not estimate the network fee: the dry run returned no result.')

  // ── ONLY A CLEAN `Accept` MAY PRICE AS SUCCESS ──
  //
  // This check is deliberately POSITIVE — "is it Accept?" rather than "is it Reject?" — because the
  // negative form is what made this a fund-loss bug. It previously threw only on `Reject`, so the
  // middle variant fell straight through to the fee receipt and was reported as an ordinary cheap
  // fee.
  //
  // `AcceptFeeRejectRest` MEANS THE USER PAYS AND NOTHING MOVES. The fee intent commits; the rest of
  // the transaction is rejected. Measured live on Esmeralda: a public→public transfer missing the
  // recipient's vault declaration returned
  //
  //     {"AcceptFeeRejectRest": [ …diff…, {"SubstateNotFound":"…vault_6a6de7ab…"} ]}
  //     fee_receipt: { total_fees_paid: 887 }
  //
  // and the old code returned 887 as the cost of a working transaction. The user would have been
  // shown a fee, confirmed it, and had it burned for nothing.
  //
  // Anything that is not `Accept` therefore fails, including a shape we do not recognise. Failing
  // closed costs a refused estimate; failing open costs the user their fee.
  const result = finalize.result
  if (!result || typeof result !== 'object') {
    throw new Error('Could not estimate the network fee: the dry run returned no transaction result.')
  }

  if (result.Reject !== undefined) {
    const reason = describeRejectReason(result.Reject)
    return { accepted: false, kind: 'reject', reason, message: `The network rejected this transaction in simulation: ${reason}` }
  }

  if (result.AcceptFeeRejectRest !== undefined) {
    // Shape is [SubstateDiff, RejectReason] — the reason is the second element and the only part
    // worth reporting. Tolerant of a non-array in case the wire form ever changes.
    const pair = result.AcceptFeeRejectRest
    const reason = describeRejectReason(Array.isArray(pair) ? pair[1] : pair)
    return {
      accepted: false, kind: 'fee-only', reason,
      message: 'This transaction would fail after the fee was taken, so it was not priced. ' +
        `The network reported: ${reason}`,
    }
  }

  if (result.Accept === undefined) {
    // An unknown variant. Refuse rather than guess — see the note above.
    const seen = Object.keys(result).join(', ') || '(none)'
    return {
      accepted: false, kind: 'unrecognised', reason: seen,
      message: `Could not estimate the network fee: the dry run returned an unrecognised result (${seen}).`,
    }
  }

  const receipt = finalize.fee_receipt
  if (!receipt) throw new Error('Could not estimate the network fee: the dry run carried no fee receipt.')

  const cost = measuredCost(finalize.total_fees_required, receipt)
  if (cost === null) throw new Error('Could not estimate the network fee: the dry run reported no cost.')
  if (opts.fee !== undefined && cost > opts.fee) {
    const reason = `Required fees ${cost} but ${opts.fee} paid`
    return { accepted: false, kind: 'underpaid', reason, message: `The network fee has risen to ${cost} µtTARI, above the ${opts.fee} µtTARI quoted.` }
  }
  return { accepted: true, cost }
}

/**
 * The cost a dry run reports, most authoritative source first.
 *
 *   1. `total_fees_required` — the engine's own figure, and the only one that does not depend on
 *      how generously the probe was funded (see simulateFee: it is the same at every payment).
 *   2. reserved − overcharge — equal to (1) whenever the probe paid at least the cost, which every
 *      probe here does. Kept for a node that omits (1).
 *   3. the cost breakdown, summed — an open-ended map whose keys grow with the runtime (0.39 added
 *      WasmExecution, ExhaustBurn and NativeExecution to it), so a sum can under-count against a
 *      newer node. Last resort only.
 */
function measuredCost(
  required: number | string | undefined,
  receipt: NonNullable<NonNullable<DryRunResponse['result']>['finalize']>['fee_receipt'] & object,
): bigint | null {
  const req = toBigInt(required)
  if (req !== null && req > 0n) return req

  const paid = toBigInt(receipt.total_fees_paid)
  const overcharge = toBigInt(receipt.total_fee_overcharge)
  if (paid !== null && overcharge !== null && paid >= overcharge) {
    const consumed = paid - overcharge
    if (consumed > 0n) return consumed
  }

  const breakdown = receipt.cost_breakdown?.breakdown
  if (breakdown) {
    let sum = 0n
    for (const v of Object.values(breakdown)) {
      const n = toBigInt(v)
      if (n !== null) sum += n
    }
    if (sum > 0n) return sum
  }
  return null
}
