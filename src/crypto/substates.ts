// What the chain has, and what a transaction may therefore declare.
//
// Two things live here, and they are together because the second is entirely built on the first:
// telling "it is not there" apart from "we could not find out", and deciding what an account-using
// transaction declares as its inputs. Both are about existence, and getting either wrong costs
// money rather than correctness.

import { getVaultIdsForAccount, type Provider } from '@tari-project/ootle'

/**
 * How vault ids are resolved for an account. Defaults to the SDK's walker; a test supplies a fake.
 *
 * The same injectable seam the read path has always used — it keeps the network out of the unit
 * tests without mocking the module graph.
 */
export type VaultIdResolver = (provider: Provider, account: string) => Promise<string[]>

/**
 * Is this rejection "the thing is not there", as opposed to "we could not find out"?
 *
 * ── THE ONLY REJECTION THAT MEANS ABSENCE ────────────────────────────────────
 *
 * A substate that does not exist is a FACT about the chain: nothing has ever been written at that
 * address. Every other rejection — a timeout, a 503, DNS, a malformed response — is an absence of
 * INFORMATION, and answering those as though the thing were absent is how both bugs this predicate
 * was written for turned into user-visible damage.
 *
 * ── MIRRORS THE SDK'S OWN PREDICATE, BECAUSE IT IS NOT EXPORTED ──────────────
 *
 * @tari-project/ootle-indexer draws this exact line internally: getStealthUtxo wraps getSubstate and
 * maps a not-found rejection to null while rethrowing everything else, using a private helper that
 * tests `/not found/i` or a 404. That helper is not on the package's public surface (the only
 * exported *NotFoundError is KeyProviderNotFoundError, which is about signers), so the test is
 * reproduced here rather than imported.
 *
 * ── WHAT TO RE-CHECK ON AN SDK OR INDEXER BUMP ───────────────────────────────
 *
 * This matches on a MESSAGE, which is the fragile part and is worth knowing about rather than
 * hiding. If the indexer's wording or the SDK's error shape changes, this stops matching — and both
 * callers then fail in their SAFE direction: the balance read reports "unavailable" over a zero
 * instead of a confident number, and resolveAccountInputs aborts the transaction instead of
 * provisioning. Deliberately narrow for that reason. Widen it only with the same care, and never to
 * cover a failure whose meaning is "unknown".
 */
export function isSubstateNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not found/i.test(message) || message.includes('404')
}

/** What an account-using transaction should declare, and whether the account is actually there. */
export interface AccountInputs {
  /** True when the account component exists on-chain and was read. */
  exists: boolean
  /**
   * The substate ids to declare — the component and its vaults when it exists, and NOTHING when it
   * does not. Never partially populated: an absent account contributes no ids at all.
   */
  declaredInputs: string[]
}

/**
 * Work out what reveal, conceal and public send may declare as inputs.
 *
 * ── THE MOST DANGEROUS DECISION IN THE WALLET, IN ONE FUNCTION ───────────────
 *
 * `CreateAccount` behaves in two completely different ways depending on what the transaction
 * declared, and only one of them is right in each case:
 *
 *   DECLARED     → the engine loads the existing component and REUSES it. The deposit lands in the
 *                  account the user actually owns.
 *   NOT DECLARED → the engine mints a fresh account in the working state. If one already existed,
 *                  the deposit lands in a component that is thrown away at the end of the
 *                  transaction: it COMMITS, reports success, and the balance never moves. Silent,
 *                  and the money is gone.
 *
 * So declaring is right when the account exists, and NOT declaring is right when it does not —
 * because an account that has never been created cannot be loaded, and declaring it aborts the
 * transaction with "Substate not found" before anything is signed. That is the bug this exists to
 * fix: a wallet funded only by RECEIVING holds real stealth UTXOs and has no account component, so
 * private send and receive worked while every public action 404'd.
 *
 * ── WHY THE ABSENCE BRANCH IS SAFE, AND EXACTLY WHEN IT IS NOT ───────────────
 *
 * Minting is not a special case invented here: it is how every account in Caravel has ever come to
 * exist. The faucet claim issues CreateAccount while declaring only the FAUCET's components, and the
 * account appears as an output of that transaction. This is that same pattern, applied to the other
 * three paths, which until now assumed some earlier faucet claim had already done it.
 *
 * It is safe ONLY on a real not-found. A timeout or a 503 read as "does not exist" would take a
 * wallet that HAS an account, decline to declare it, and deposit into a throwaway — the silent-loss
 * case above, caused by a network blip. So every other failure rethrows and the transaction never
 * gets built. The predicate above is deliberately narrow for this one line's sake.
 *
 * There is no third answer. This either knows the account exists, knows it does not, or raises.
 */
export async function resolveAccountInputs(
  provider: Provider,
  accountAddress: string,
  resolveVaultIds: VaultIdResolver = getVaultIdsForAccount,
): Promise<AccountInputs> {
  let vaultIds: string[]
  try {
    vaultIds = await resolveVaultIds(provider, accountAddress)
  } catch (e) {
    // NOT-FOUND ONLY. Anything else is "we do not know", and a transaction must not be built on a
    // guess about where its money is going.
    if (isSubstateNotFound(e)) return { exists: false, declaredInputs: [] }
    throw e
  }

  // Every vault the account holds is declared rather than picking out the TARI one: an account has
  // few vaults, declaring a spare one costs nothing, and choosing wrongly costs a failed
  // transaction. An account with no vaults yet is normal — a deposit creates the TARI vault, and a
  // substate being created is an output, not an input to declare.
  return { exists: true, declaredInputs: [accountAddress, ...vaultIds] }
}
