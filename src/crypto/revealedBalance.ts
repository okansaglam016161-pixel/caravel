// Reading the REVEALED (public) TARI balance held in a wallet's account vault.
//
// TARI is a Stealth resource, and a stealth resource's value can sit in two places at once: hidden
// in UTXO commitments (what walletScanner.ts sums, and what Caravel has always displayed), and
// REVEALED as a plain integer inside a vault owned by an account component. This module reads the
// second one. It is the only balance on-chain that anyone can read — which is exactly why it is
// worth showing the user.
//
// THE PATH, and why it is two hops. A revealed amount lives in a Vault substate; a Vault is
// reachable only through the account Component that references it. So:
//
//     account component address  (captured at claim time — see accountAddress.ts)
//       → getVaultIdsForAccount   (walks the component's CBOR state for vault ids)
//       → getSubstate(vaultId)    (the Vault substate)
//       → resource_container.Stealth.revealed_amount
//
// AMOUNTS ARE BIGINT, ALWAYS. `Amount` in the ts-bindings is `string | number | bigint` and is
// documented as 128-bit — wider than u64, and far wider than a JS number. The TARI resource's own
// total_supply reads as "18446744073708810601", which is already past Number.MAX_SAFE_INTEGER, so
// `Number()` on an amount is a correctness bug waiting for a large balance. parseAmount below is
// strict about this and refuses anything it cannot convert exactly.
//
// ZERO AND UNAVAILABLE ARE DIFFERENT, and this module keeps them apart. Every STRUCTURAL absence —
// no account address, an account that does not exist yet, an account with no TARI vault, a vault
// holding zero — is a real, common, correct zero and is returned as 0n. A NETWORK failure is not: it
// is thrown, so the caller can say "unavailable" instead of drawing a confident 0. Collapsing those
// two would repeat the exact bug this project's own research pass found in the UTXO scanner, where an
// unreadable output is indistinguishable from an absent one and quietly understates the balance.
//
// ONE STRUCTURAL ABSENCE ARRIVES AS A THROW, and it took a user-visible bug to find it. A wallet that
// has never claimed has an account ADDRESS — accountRecovery derives it from the owner key, whether
// or not the account exists — but no account COMPONENT on chain. Reading that component does not come
// back empty; the indexer answers "substate not found" and the SDK rejects. So every brand-new wallet
// reported "Balance unreadable right now / your public balance couldn't be read" over a balance that
// was simply, verifiably, zero. See isSubstateNotFound below.

import { getVaultIdsForAccount, Network, TARI_RESOURCE_ADDRESS, type Provider } from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import type { SubstateValue } from '@tari-project/ootle-ts-bindings'
import { loadAccountAddress } from './accountStore'

// Same indexer the scan and send paths use. Inlined here as they inline it, rather than introducing
// a shared config module as a side effect of this milestone.
const INDEXER_URL = 'https://ootle-indexer-a.tari.com'

/**
 * An `Amount` converted to bigint EXACTLY, or `null` if it cannot be.
 *
 * Handles all three shapes the union admits:
 *   - bigint   — already exact, used as-is.
 *   - string   — the wire form. Digits only; a decimal point, sign, exponent or stray whitespace is
 *                refused rather than coerced, because BigInt('1.5') throws and BigInt('') is 0n.
 *   - number   — accepted ONLY if it is a safe integer. A number beyond Number.MAX_SAFE_INTEGER has
 *                already lost precision in JSON.parse before we ever see it, so there is no honest
 *                bigint to recover; refusing is the only correct answer.
 *
 * Negatives are refused: `Amount` is documented unsigned, and a negative revealed balance would be
 * a symptom of reading the wrong field, not a value to render.
 */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    return BigInt(value)
  }
  if (typeof value === 'string') {
    // Plain unsigned decimal digits only — no sign, point, exponent, underscore or whitespace.
    if (!/^[0-9]+$/.test(value)) return null
    return BigInt(value)
  }
  return null
}

/**
 * Is this rejection "the thing is not there", as opposed to "we could not find out"?
 *
 * ── THE ONE REJECTION THAT MEANS ZERO ────────────────────────────────────────
 *
 * A substate that does not exist is a FACT about the chain: nothing has ever been written at that
 * address, so there is nothing to hold a balance, so the balance is zero. Every other rejection — a
 * timeout, a 503, DNS, a malformed response — is an absence of INFORMATION, and answering those with
 * a confident 0 is the precise failure this module's header exists to prevent.
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
 * hiding. If the indexer's wording or the SDK's error shape changes, this stops matching and a fresh
 * wallet goes back to reporting "unavailable" over a zero — annoying, visible, and the SAFE direction
 * to fail in: a missed match costs an honest error, never a false zero. Deliberately narrow for that
 * reason. Widen it only with the same care, and never to cover a failure whose meaning is "unknown".
 */
export function isSubstateNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not found/i.test(message) || message.includes('404')
}

/** Narrow an unknown to a plain object without asserting anything about its contents. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * The revealed amount this substate holds for `resourceAddress`, or `null` if it holds none.
 *
 * PURE, and the only place the container shape is interpreted — which is why the whole risk of this
 * milestone concentrates here and why the tests hammer it.
 *
 * MATCHES `Stealth` SPECIFICALLY. TARI is a Stealth resource, so that is the only container whose
 * `revealed_amount` we may read. The other variants are refused rather than guessed at:
 *   - `Fungible` has an `amount`, not a revealed/hidden split — reading it as "revealed" would be a
 *     category error, and TARI is never Fungible.
 *   - `Confidential` DOES carry a `revealed_amount`, and it would be tempting to read it. It is
 *     still refused: encountering one here would mean the resource is not what we think it is, and
 *     a wrong assumption about the container is exactly the kind of thing that should surface as a
 *     visible zero rather than a plausible number.
 *   - `NonFungible` has no amount at all.
 *
 * Returns `null` — not 0n — for "this is not our vault / not a shape we read", so the caller can
 * distinguish "skip it" from "it holds nothing".
 */
export function decodeRevealedAmount(substate: unknown, resourceAddress: string): bigint | null {
  const vault = obj(obj(substate)?.Vault)
  const container = obj(vault?.resource_container)
  if (!container) return null

  const stealth = obj(container.Stealth)
  if (!stealth) return null                                   // Fungible / Confidential / NonFungible
  if (stealth.address !== resourceAddress) return null        // some other resource's vault

  return parseAmount(stealth.revealed_amount)
}

/**
 * How vault ids are resolved for an account. Defaults to the SDK's walker; a test supplies a fake.
 *
 * The same injectable-seam pattern the SDK itself uses for its crypto provider — it keeps the
 * network out of the unit tests without mocking the module graph.
 */
export type VaultIdResolver = (provider: Provider, account: string) => Promise<string[]>

/**
 * The wallet's revealed TARI balance in µtTARI.
 *
 * Returns 0n for every structural absence — see the note at the top of this file:
 *   - `accountAddress` is null: the wallet has never captured one. Overwhelmingly the common case
 *     today, and correct — a wallet that has never concealed holds nothing revealed.
 *   - the account holds no vaults, or none for TARI: nothing has ever been deposited.
 *   - the TARI vault exists and holds zero: the ordinary state after a faucet claim, which converts
 *     its entire payout and leaves the vault at exactly zero.
 *
 * THROWS on a network or indexer failure, deliberately. A thrown error becomes "unavailable" in the
 * UI; a swallowed one would become a confident, wrong "0 public". The single exception is an account
 * component that does not exist — see the vault-id read below, and isSubstateNotFound.
 *
 * Amounts across vaults are SUMMED. The engine keys an account's state by resource, so exactly one
 * TARI vault is expected — but if more than one ever appeared, their sum is the honest answer to
 * "how much revealed TARI does this account hold", and picking one arbitrarily would not be.
 */
export async function readRevealedBalance(
  provider: Provider,
  accountAddress: string | null,
  resolveVaultIds: VaultIdResolver = getVaultIdsForAccount,
): Promise<bigint> {
  if (!accountAddress) return 0n

  // ── A COMPONENT THAT IS NOT THERE HOLDS NOTHING ────────────────────────────
  //
  // This reads the ACCOUNT COMPONENT to find its vaults, and it is the read that a never-claimed
  // wallet fails: it has an address (derived from its owner key) and no component at that address
  // yet. "Not found" here is therefore the same answer as "no account address at all" one line
  // above — nothing has ever been written, so nothing is held — and it is returned as the zero it
  // is. Every other failure still throws, because every other failure means we do not know.
  let vaultIds: string[]
  try {
    vaultIds = await resolveVaultIds(provider, accountAddress)
  } catch (e) {
    if (isSubstateNotFound(e)) return 0n
    throw e
  }
  if (vaultIds.length === 0) return 0n

  // ── AND THE SAME TOLERANCE DELIBERATELY DOES NOT APPLY BELOW ───────────────
  //
  // These ids came OUT of the component's own state, so the component asserts each vault exists. One
  // that then cannot be read is an inconsistency, not an absence, and skipping it would drop a real
  // holding and understate the total — the exact UTXO-scanner bug named in this file's header. A
  // missing vault here therefore throws, like any other unreadable balance.
  let total = 0n
  for (const vaultId of vaultIds) {
    const res = await provider.getSubstate(vaultId)
    const amount = decodeRevealedAmount(res?.substate as SubstateValue | undefined, TARI_RESOURCE_ADDRESS)
    if (amount !== null) total += amount
  }
  return total
}

/**
 * The revealed TARI balance for a wallet, resolved from its stored account address.
 *
 * The app-facing entry point: it owns the store lookup and the indexer connection so callers need
 * to know about neither, exactly as scanWallet owns them for the private balance.
 *
 * Short-circuits to 0n WITHOUT touching the network when no account address has been captured —
 * which is every wallet that claimed before this shipped. Throws on a network failure, so the
 * caller can distinguish unavailable from zero.
 */
export async function fetchRevealedBalance(walletAddress: string): Promise<bigint> {
  const accountAddress = loadAccountAddress(walletAddress)
  if (!accountAddress) return 0n
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  return readRevealedBalance(provider, accountAddress)
}
