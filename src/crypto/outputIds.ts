// Reading back the substate ids of the outputs a transaction is about to create.
//
// ── WHY THIS IS WORTH A MODULE ───────────────────────────────────────────────
//
// Every builder in this directory constructs its outputs client-side, through
// `generateOutputsStatement(specs, revealed)`, and the resulting statement carries each output's
// Pedersen commitment. That means the wallet can know — BEFORE submitting — the exact substate id
// of every UTXO the transaction will create, including the ones it is creating for itself.
//
// Those self-output ids are the whole basis of receive reconciliation. The scan returns every UTXO
// this wallet owns and cannot say which are ours by construction, because a confidential output
// carries no sender. Subtracting the ids recorded at action time leaves the ones somebody else
// sent us — an exact subtraction, not a heuristic.
//
// The commitment is unrecoverable afterwards: it lives in a closure inside the builder and is
// discarded when the build returns. This is read at the only moment it exists.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
//
// Nothing here participates in building, pricing, proving, signing or submitting a transaction. It
// reads a value that is already computed and hands it back. `confidentialSend` has done exactly
// this for the recipient's output since M10.1 (to build a payment-linked message reference); this
// generalises that one-liner so all four builders can report their own outputs the same way.

import { RESOURCE_HEX } from './stealthUtxos'

/** The shape `outputsStatement.parsed()` returns, as far as we need it. */
interface ParsedOutputs {
  outputs?: { output?: { commitment?: string } }[]
}

/** Same format `walletScanner` builds for a scanned UTXO, so the two sets compare directly. */
export function utxoSubstateIdFromCommitment(commitmentHex: string): string {
  return `utxo_${RESOURCE_HEX}_${commitmentHex}`
}

/**
 * Every output's substate id, in statement order.
 *
 * `[]` and `null` mean different things and the caller must keep them apart:
 *   []    the statement genuinely declares no outputs (an exact-cover spend).
 *   null  the statement could not be read, or an entry had no commitment. A HOLE — the caller must
 *         not record a partial list as if it were complete, because a missing id later reads as a
 *         payment from a stranger.
 */
export function readOutputSubstateIds(outputsStatement: { parsed(): unknown }): string[] | null {
  let parsed: ParsedOutputs
  try {
    parsed = outputsStatement.parsed() as ParsedOutputs
  } catch { return null }

  const outputs = parsed?.outputs
  if (!Array.isArray(outputs)) return null

  const ids: string[] = []
  for (const o of outputs) {
    const commitment = o?.output?.commitment
    // ALL OR NOTHING. A list missing one id is more dangerous than no list, so a single unreadable
    // entry discards the whole thing rather than producing a subtraction set with a gap in it.
    if (typeof commitment !== 'string' || commitment.length === 0) return null
    ids.push(utxoSubstateIdFromCommitment(commitment))
  }
  return ids
}
