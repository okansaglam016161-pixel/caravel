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

// A dry run is a single round trip against the indexer; this bounds it so a hung request surfaces
// as an error the caller can show rather than a spinner that never resolves.
const DRY_RUN_TIMEOUT_MS = 20_000

// Safety margin added to the measured cost, as a percentage.
//
// 25% is deliberately generous, because OVERCHARGE IS REFUNDED and under-paying is fatal. The
// measured probe proves it: reserving 50 000 against a 13 211 cost returned `total_fee_overcharge:
// 36 789`, so the only real price of over-reserving is that the amount is briefly committed to the
// fee bucket. Under-reserving, by contrast, aborts the whole transaction — which is the outage this
// module was written to end.
//
// It has to absorb genuine drift, not just noise: the dry run executes against the state of one
// moment and the real submission lands a few seconds later, and the cost breakdown is dominated by
// terms that depend on that state (`Storage` 2 287, `NativeExecution` 8 100 on a faucet claim). A
// tighter 5% would re-open exactly this failure on any modest upward move. In absolute terms 25% of
// a ~13 200 fee is ~3 300 µtTARI — 0.0033 tTARI, against a claim of ~1 000 tTARI.
export const FEE_MARGIN_PERCENT = 25n

/** Measured cost plus FEE_MARGIN_PERCENT, rounded down (bigint division). */
export function withFeeMargin(costMicrotari: bigint): bigint {
  return (costMicrotari * (100n + FEE_MARGIN_PERCENT)) / 100n
}

// The indexer reports 64-bit amounts as either a JSON number or a decimal string depending on the
// field and the version (0.39 moved several to strings). Accept both rather than guessing.
function toBigInt(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v)
  return null
}

interface DryRunResponse {
  result?: {
    finalize?: {
      result?: { Reject?: unknown; Accept?: unknown }
      fee_receipt?: {
        total_fees_paid?: number | string
        total_fee_overcharge?: number | string
        cost_breakdown?: { breakdown?: Record<string, number | string> }
      }
    }
  }
}

/**
 * Ask the network what `envelope` would actually cost, in µtTARI.
 *
 * `envelope` MUST have been sealed from a transaction carrying `dry_run: true` — see the note above.
 * The reserved fee inside it only has to be GENEROUS ENOUGH for execution to complete; whatever is
 * not consumed comes back as overcharge, and it is the consumed part this returns.
 *
 * Throws with a message fit to show a user on every failure path — a dead indexer, a timeout, a
 * malformed body, or a transaction the network rejects for a reason that is not about fees at all
 * (an under-funded probe shows up here as a Reject, and reporting it verbatim is far more useful
 * than a silent fallback to some default fee).
 */
export async function dryRunFee(indexerUrl: string, envelope: unknown): Promise<bigint> {
  let resp: Response
  try {
    resp = await fetch(`${indexerUrl}/transactions/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: envelope }),
      signal: AbortSignal.timeout(DRY_RUN_TIMEOUT_MS),
    })
  } catch (e) {
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

  // A rejected dry run has no meaningful cost to report, and the reason is the useful part.
  const reject = finalize.result?.Reject
  if (reject !== undefined) {
    const detail = typeof reject === 'string' ? reject : JSON.stringify(reject).slice(0, 200)
    throw new Error(`The network rejected this transaction in simulation: ${detail}`)
  }

  const receipt = finalize.fee_receipt
  if (!receipt) throw new Error('Could not estimate the network fee: the dry run carried no fee receipt.')

  // WHAT WAS ACTUALLY CONSUMED = reserved − refunded. Preferred over summing `cost_breakdown`
  // because the breakdown is an open-ended map whose keys grow with the runtime (0.39 added
  // WasmExecution, ExhaustBurn and NativeExecution to it), so a sum silently under-counts against a
  // newer node. The breakdown is kept only as a fallback for a receipt that omits the totals.
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

  throw new Error('Could not estimate the network fee: the dry run reported no cost.')
}
