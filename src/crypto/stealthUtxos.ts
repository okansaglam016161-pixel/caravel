// The wallet's own stealth (private) UTXO set, as spendable inputs.
//
// LIFTED OUT OF confidentialSend.ts UNCHANGED, because M3's reveal path needs the same thing for a
// different reason. A send spends stealth UTXOs to pay someone else; a reveal spends them to make
// value public. Both need the identical answer to "which outputs do I own, what are they worth, and
// what do I need to spend them" — and two copies of that answer is one copy that drifts. The same
// reasoning epoch.ts records for max_epoch, applied to input discovery.
//
// WHAT A SPENDABLE INPUT NEEDS, and why this returns all four fields:
//   commitment — names the UTXO on-chain (the StealthInput, and the substate id).
//   value      — recovered by trial decryption; the balance arithmetic runs on it.
//   mask       — the blinding factor. Without it there is no balance proof, so an output whose
//                mask we cannot recover is not spendable no matter how much it is worth.
//   nonce      — the sender's public nonce, which the one-time spend-key signature is derived
//                against. A UTXO with no readable nonce cannot be authorized, so it is dropped.
//
// UNREADABLE IS DROPPED, NOT ZEROED. Anything that fails to decrypt is somebody else's output and
// is skipped silently — that is the overwhelming majority of the set and not an error. What IS
// surfaced is a truncated listing: see the FETCH_LIMIT note below.

import { decryptOwnedUtxo, TARI_RESOURCE_ADDRESS, WasmStealthCrypto, type Mask, type Signer } from '@tari-project/ootle'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'

/** The TARI resource address with its `resource_` prefix stripped — the form the /utxos query and
 *  the `utxo_<resource>_<commitment>` substate id both use. */
export const RESOURCE_HEX = TARI_RESOURCE_ADDRESS.replace(/^resource_/, '')

// The indexer's /utxos endpoint IGNORES `offset` (every offset returns the same set) but HONORS
// `limit`. So we fetch the whole set in one request with a limit safely above it — never paginate by
// offset (that loops forever once the set exceeds one page). 1000 is honored; 5000 is rejected.
export const FETCH_LIMIT = 1000

/** One of the wallet's own stealth outputs, with everything needed to spend it. */
export interface OwnedUtxo {
  substateId: string
  commitment: Uint8Array
  nonce: Uint8Array
  value: bigint
  mask: Mask
}

export function fromHex(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16)
  return bytes
}

/**
 * Every stealth TARI output this view key can open, in the order the indexer returned them.
 *
 * Order is preserved deliberately: input selection sorts by value and JS sorts are stable, so a
 * deterministic starting order means a deterministic selection for a given balance — the same
 * transaction gets built when it is priced and when it is sent.
 */
export async function scanOwnedUtxos(crypto: WasmStealthCrypto, viewSecret: Uint8Array): Promise<OwnedUtxo[]> {
  const owned: OwnedUtxo[] = []

  // ONE request — the indexer ignores `offset`, so paginating by it would re-fetch the same set
  // forever. Fetch the whole set with a big `limit` instead.
  const url = `${INDEXER_URL}/utxos?resource_address=${RESOURCE_HEX}&limit=${FETCH_LIMIT}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`UTXO scan HTTP ${res.status}`)
  const body = await res.json() as { utxos?: [string, unknown][] } | [string, unknown][]
  const rows = Array.isArray(body) ? body : (body as { utxos?: [string, unknown][] }).utxos ?? []
  // Ceiling guard: a full FETCH_LIMIT means there may be inputs we couldn't see. The spend paths
  // have no balance display of their own, so surface it in the log; an actually-unspendable set
  // still fails with an explicit insufficient-funds message.
  if (rows.length >= FETCH_LIMIT) {
    console.warn(`[Caravel] stealth UTXO fetch hit the indexer limit (${FETCH_LIMIT}) — input selection may be incomplete`)
  }

  // Dedup by commitment — the indexer can return the same UTXO more than once, and input selection
  // must never consider a duplicate: spending one commitment twice is a self-double-spend, and
  // counting it twice overstates what the wallet can cover.
  const seen = new Set<string>()
  for (const [commitmentHex, utxoBody] of rows) {
    if (seen.has(commitmentHex)) continue
    seen.add(commitmentHex)

    const substateId = `utxo_${RESOURCE_HEX}_${commitmentHex}`
    const fakeResponse = { version: 0, verified: false, substate: { Utxo: utxoBody } }
    const decrypted = await decryptOwnedUtxo(
      crypto,
      viewSecret,
      fakeResponse as Parameters<typeof decryptOwnedUtxo>[2],
      substateId,
    )
    if (decrypted !== null) {
      const output = (utxoBody as { output?: { output?: { public_nonce?: string } } })?.output?.output
      if (!output?.public_nonce) continue
      owned.push({
        substateId,
        commitment: fromHex(commitmentHex),
        nonce: fromHex(output.public_nonce),
        value: decrypted.value,
        mask: decrypted.mask,
      })
    }
  }

  return owned
}

// ── Spend-side signing shim ───────────────────────────────────────────────────

/**
 * Carries pre-computed one-time spend-key signatures into `signTransaction`.
 *
 * A stealth input is authorized not by the wallet key but by a ONE-TIME key derived from the
 * sender's public nonce on that specific output, so those signatures have to be produced before
 * signing (they hash over the serialized transaction and the seal public key) and then handed to
 * the signer list as-is. `signTransaction` concatenates whatever each signer returns, so ONE
 * StaticSigner carrying N signatures is how a multi-input spend is authorized.
 *
 * Shared by the send and reveal paths for the same reason the scan above is: one definition, so a
 * change to how spends are authorized cannot land in one path and not the other.
 */
export type SignedTxArr = Awaited<ReturnType<Signer['signTransaction']>>

export class StaticSigner implements Signer {
  private sigs: SignedTxArr
  constructor(sigs: SignedTxArr) { this.sigs = sigs }
  async getAddress() { return '' }
  async getPublicKey() { return new Uint8Array(32) }
  async signTransaction(_t: Parameters<Signer['signTransaction']>[0], _k: Uint8Array): Promise<SignedTxArr> {
    return this.sigs
  }
}

// ── Input selection ───────────────────────────────────────────────────────────
//
// SHARED BY EVERY SPEND. Both paths that consume stealth outputs — a confidential send and a
// reveal — face the identical problem: pick outputs covering a target, and hand back the total so
// change can be computed. Two copies of that would be two chances to compute change wrongly, which
// is the one arithmetic in either path that loses value silently.
//
// A STEALTH TRANSFER MAY SPEND MANY INPUTS. That is not a workaround; it is what the protocol is
// built for. The engine's own limits say so (tari-ootle engine_types/src/limits.rs):
//
//     STEALTH_LIMITS.max_inputs                     = 1000   (per transfer statement)
//     STEALTH_LIMITS.max_total_inputs_per_transaction = 1024
//     NativeExecutionPoints::PER_INPUT  =    42_000
//     NativeExecutionPoints::PER_OUTPUT = 6_000_000          — inputs are ~143× cheaper
//
// and it is verified live: dry runs spending 1, 2, 5, 8, 12 and 15 real outputs were all accepted,
// with the cost moving only 24 642 → 25 539 µtTARI across the whole range. Inputs are close to
// free; outputs are what a transfer pays for.
//
// This corrects a belief that shaped two earlier milestones. The send path spent exactly ONE output
// because it was ported from a minimal reference example that did, and the reveal path capped
// itself at 8 because that number looked generous. Neither was a protocol constraint, and both
// understated what a wallet could do — a wallet holding 1107 TARI across 15 outputs could send at
// most 245 in one payment.

/**
 * Most stealth inputs one transfer may spend.
 *
 * OURS, NOT THE PROTOCOL'S — the engine allows 1000 per statement. This is a practical bound on
 * worst-case work: every input needs its own one-time spend signature (a WASM operation apiece), so
 * an unbounded set could make a transaction that prices fine and then takes an age to sign on a
 * slow device. 64 sits far above any realistic wallet while keeping that bounded.
 *
 * A wallet fragmented beyond this can still spend — just not everything at once — and the ceiling
 * helpers report the reachable amount rather than letting a MAX fail at review.
 */
export const MAX_STEALTH_INPUTS = 64

/** The minimum a candidate must expose to be selectable. Keeps selection testable without a chain. */
export interface Spendable { value: bigint }

export interface InputSelection<T extends Spendable> {
  /** The outputs to spend, in the order they will be added to the statement. */
  inputs: T[]
  /** Their summed value — the figure change is computed against. */
  total: bigint
}

/**
 * Choose stealth outputs covering `target`.
 *
 * THE ORDER OF PREFERENCE, and why each step is where it is:
 *
 *   1. An EXACT single match, if one exists. One input, no change output, smallest possible
 *      transaction — and no change means no opportunity to compute one wrongly.
 *   2. Otherwise the SMALLEST single output that covers the target. One input still, and it locks
 *      the least value; it also leaves the wallet's larger outputs intact for later.
 *   3. Otherwise accumulate LARGEST-FIRST until covered. Largest-first minimises the number of
 *      inputs, which is what the signing cost and MAX_STEALTH_INPUTS both care about.
 *
 * Refuses rather than improvising when the wallet cannot cover the target, or when covering it
 * would need more inputs than the cap — both with the actual numbers, because a spend deserves to
 * fail with a reason the user can act on.
 *
 * DETERMINISTIC for a given candidate list: sorts are stable and the input order is the indexer's,
 * so the transaction priced by the dry run is built from the same inputs as the one submitted.
 */
export function selectStealthInputs<T extends Spendable>(utxos: T[], target: bigint): InputSelection<T> {
  if (target <= 0n) throw new Error('Spend target must be greater than zero.')

  // Zero-value outputs cannot help cover anything and would only inflate the input count.
  const usable = utxos.filter(u => u.value > 0n)
  if (usable.length === 0) {
    throw new Error('No private funds found. This wallet holds no spendable outputs.')
  }

  const available = usable.reduce((s, u) => s + u.value, 0n)
  if (available < target) {
    throw new Error(
      `Not enough private funds. This needs ${target} µtTARI (amount + network fee), ` +
      `and the wallet holds ${available} µtTARI across ${usable.length} output(s).`,
    )
  }

  // 1 — exact single match.
  const exact = usable.find(u => u.value === target)
  if (exact) return { inputs: [exact], total: exact.value }

  // 2 — smallest single output that covers it.
  const covering = usable.filter(u => u.value > target).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  const single = covering[0]
  if (single) return { inputs: [single], total: single.value }

  // 3 — largest-first accumulation.
  const descending = [...usable].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))
  const inputs: T[] = []
  let total = 0n
  for (const u of descending) {
    inputs.push(u)
    total += u.value
    if (total >= target) break
  }

  // `available >= target` was checked above, so the loop always reaches the target; the only way to
  // arrive here over budget is needing too many inputs to get there.
  if (inputs.length > MAX_STEALTH_INPUTS) {
    throw new Error(
      `Your private balance is spread across too many small outputs to spend ${target} µtTARI in one ` +
      `transaction (it would need ${inputs.length}, and the limit is ${MAX_STEALTH_INPUTS}). ` +
      `Try a smaller amount.`,
    )
  }

  return { inputs, total }
}

/**
 * The largest amount reachable in ONE transfer, given the outputs a wallet holds.
 *
 * The sum of the largest MAX_STEALTH_INPUTS outputs — because selection accumulates largest-first,
 * so that is the most it can ever gather within the cap. On any wallet with fewer outputs than the
 * cap this is simply the whole balance, which is the ordinary case.
 *
 * Callers subtract their own fee reserve; this is the gross figure.
 */
export function reachableTotal(outputValues: readonly bigint[]): bigint {
  return [...outputValues]
    .filter(v => v > 0n)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
    .slice(0, MAX_STEALTH_INPUTS)
    .reduce((sum, v) => sum + v, 0n)
}
