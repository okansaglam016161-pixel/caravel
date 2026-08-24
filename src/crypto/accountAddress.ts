// Recovering the Ootle ACCOUNT COMPONENT address from a committed transaction result.
//
// WHY THIS EXISTS AT ALL. Caravel is stealth-only: it has never needed an account component for
// anything, and has never known its own account's address. Reading a REVEALED balance does need it
// — a revealed amount lives in a vault, and a vault is reachable only through the component that
// owns it.
//
// AND IT CANNOT BE DERIVED CLIENT-SIDE. The engine computes the address as
//
//     hasher32("ComponentAddress").chain(template_address).chain(public_key)
//
// over a DomainSeparatedBorshHasher<TariEngineHashDomain("com.tari.ootle.engine", v0), Blake2b<U32>>
// (tari-ootle: crates/engine_types/src/component.rs:47). The shipped SDK exposes no equivalent —
// neither @tari-project/ootle 0.3.0 nor ootle-wasm 0.39.1 exports the derivation or the account
// template address — and reproducing the hash by inspection was tried and failed against a known
// key→address pair. A near-miss reimplementation is worse than none: it yields a well-formed
// address that points at nothing, or at somebody else's component.
//
// SO WE READ IT OFF THE WIRE INSTEAD. A transaction that runs `CreateAccount` reports the resulting
// component in its result's up-substates, and the claim flow already fetches exactly that response
// to read `final_decision` — it simply discarded everything else. This function is the "everything
// else".
//
// TWO CHECKS, BOTH LOAD-BEARING. An up-substate list can hold components we did not create (a
// transaction may touch several), so a match on the `component_` prefix alone is not enough:
//
//   1. template_address is the ACCOUNT template — so we cannot latch onto some other component kind.
//   2. owner_rule is ByPublicKey and equals OUR public key — so we cannot latch onto a stranger's
//      account and later read (or, in a future milestone, try to spend from) the wrong balance.
//
// Everything here is defensive: the input is untrusted network JSON, every level is checked, and
// anything unexpected yields `null` rather than a guess. `null` is an ordinary outcome — a
// transaction with no CreateAccount has no account to report — and callers treat it as "not known
// yet", never as an error.

/**
 * The built-in account template. Components created by `CreateAccount` carry this as their
 * `template_address`; it is the all-zero address (tari-ootle: ACCOUNT_TEMPLATE_ADDRESS).
 */
export const ACCOUNT_TEMPLATE_ADDRESS = '0'.repeat(64)

/** Narrow an unknown to a plain object without asserting anything about its contents. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * The up-substates of a transaction result, or `[]` for any other shape.
 *
 * TWO NESTINGS, because the two endpoints that carry this do not agree:
 *
 *   committed  /transactions/{id}/result   result.Finalized.execution_result.finalize.result.Accept
 *   dry run    /transactions/dry-run       result.finalize.result.Accept
 *
 * Both are walked one checked step at a time rather than with a cast, and both are tried — the
 * caller should not have to know which endpoint its JSON came from. A rejected transaction has
 * `Reject` instead of `Accept` under either nesting and correctly yields nothing.
 */
function upSubstates(resultJson: unknown): unknown[] {
  const root = obj(resultJson)
  const result = obj(root?.result)

  // Committed shape.
  const finalized = obj(result?.Finalized)
  const committed = obj(obj(obj(obj(finalized?.execution_result)?.finalize)?.result)?.Accept)?.up_substates
  if (Array.isArray(committed)) return committed

  // Dry-run shape — shallower, and carries no `Finalized` wrapper.
  const dryRun = obj(obj(obj(result?.finalize)?.result)?.Accept)?.up_substates
  if (Array.isArray(dryRun)) return dryRun

  return []
}

/**
 * The account component address this transaction created (or re-used) for `ownerPublicKeyHex`, or
 * `null` if the result carries none.
 *
 * `CreateAccount` is create-or-reuse in the engine, so a repeat claim reports the SAME address it
 * reported the first time — this is idempotent, not first-write-only.
 */
export function extractAccountAddress(resultJson: unknown, ownerPublicKeyHex: string): string | null {
  if (!ownerPublicKeyHex) return null

  for (const entry of upSubstates(resultJson)) {
    // Each entry is the wire form of [SubstateId, Substate].
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [substateId, substate] = entry as [unknown, unknown]
    if (typeof substateId !== 'string' || !substateId.startsWith('component_')) continue

    const component = obj(obj(obj(substate)?.substate)?.Component)
    const header = obj(component?.header)
    if (!header) continue

    // Check 1 — it is an ACCOUNT, not some other component that happens to be ours.
    if (header.template_address !== ACCOUNT_TEMPLATE_ADDRESS) continue

    // Check 2 — it is OURS. Only the ByPublicKey rule can be compared to a key we hold; any other
    // owner rule is not something we can claim, so it is skipped rather than assumed.
    const ownerKey = obj(header.owner_rule)?.ByPublicKey
    if (typeof ownerKey !== 'string' || ownerKey !== ownerPublicKeyHex) continue

    return substateId
  }
  return null
}
