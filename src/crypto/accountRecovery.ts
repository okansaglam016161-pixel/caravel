// Recovering a wallet's account component address WITHOUT submitting a transaction.
//
// THE PROBLEM. The account address cannot be derived client-side (see accountAddress.ts), so
// Caravel learns it by watching it go past in a transaction result. That works for a wallet that
// claims the faucet while this code is installed, and for nothing else: a wallet that claimed
// earlier, or one restored from its phrase on another device, has a real account holding a real
// revealed balance and no idea what its address is. It would show 0 public forever.
//
// THE MECHANISM, and why it costs nothing. `CreateAccount` derives the address from the owner
// public key alone, deterministically — so a SIMULATION of it produces exactly the address the real
// account has, whether or not that account already exists. A dry run therefore answers the question
// completely:
//
//     build CreateAccount-only  →  POST /transactions/dry-run  →  read up_substates
//
// Verified against a wallet whose address was already known independently: the dry run reported the
// identical component the real claim had created. It needs no inputs, no fee instruction and no
// funds; it commits nothing, changes no state, and moves no value. The only cost is one HTTP
// request, which is why there is no elaborate "should we bother?" heuristic here — see the note on
// recoverAccountAddress.
//
// WHAT IT IS NOT. It does not tell you whether the account EXISTS on-chain, only what its address
// is. A never-claimed wallet therefore stores the address its account WILL have, which is harmless
// and, once the account does exist, already correct.
//
// THIS PARAGRAPH USED TO SAY THE READ PATH HANDLED THAT ON ITS OWN, "because getVaultIdsForAccount
// returns an empty array" for a component that is not there. IT DOES NOT. The SDK returns an empty
// array only when the substate EXISTS and is not a Component; when nothing exists at the address, the
// getSubstate underneath it rejects with "substate not found". So storing an address here made every
// brand-new wallet's public balance read THROW, and the wallet reported "Balance unreadable right
// now" over a balance that was plainly zero.
//
// revealedBalance.ts owns that distinction now — a not-found component reads as the zero it is, while
// every other failure still surfaces as unavailable. Do not re-derive this claim from the SDK's
// signature; it is the getSubstate underneath that decides.

import { Network, TransactionBuilder, sealTransaction, signTransaction } from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { extractAccountAddress } from './accountAddress'
import { loadAccountAddress, saveAccountAddress } from './accountStore'
import { nextMaxEpoch } from './epoch'
import { INDEXER_URL } from './indexerConfig'


/** A dry run is one round trip; this bounds it so a hung request cannot stall an unlock. */
const DRY_RUN_TIMEOUT_MS = 20_000

function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * Ask the network what this wallet's account address is, by simulating its creation.
 *
 * Returns the address, or `null` if the dry run could not answer — a dead indexer, a timeout, a
 * rejected simulation, or a result whose shape we did not recognise. `null` is never fatal: the
 * caller simply carries on not knowing, exactly as it did before.
 *
 * NOTHING IS SUBMITTED. The transaction carries `dry_run: true` inside the sealed envelope and goes
 * to the dry-run endpoint, which simulates and discards. No fee is charged, no substate is written,
 * and the wallet needs no funds — a transaction with no fee instruction at all is fine here, where
 * it would be refused for real submission.
 */
export async function probeAccountAddress(wallet: SecretKeyWallet): Promise<string | null> {
  let envelope: unknown
  let ownerPkHex: string
  try {
    const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
    ownerPkHex = toHexStr(await wallet.getPublicKey())
    const maxEpoch = await nextMaxEpoch(provider)
    // A NO-OP HERE, and kept deliberately. This probe never watches a transaction — it reads the
    // epoch and dry-runs — so there is no SSE stream to release. It stays because the provider is
    // discarded on the next line, and a future edit that adds a watch here would otherwise leak
    // the connection. The five submit paths DO start a watcher (see crypto/finality), and their
    // matching calls are what actually close a stream.
    provider.stopWatcher?.()

    // CreateAccount and nothing else. No withdraw, no transfer, no fee instruction — the simulation
    // never needs to pay for itself, and every instruction omitted is one that cannot fail.
    const builder = new TransactionBuilder(Network.Esmeralda, maxEpoch)
      .withFeeInstructionsBuilder(b => b.createAccount(ownerPkHex).saveVar('account'))
    const unsigned = builder.buildUnsignedTransaction()
    // `dry_run` must ride INSIDE the sealed envelope — see feeProbe.ts for why.
    const signed = await signTransaction([wallet], { ...unsigned, dry_run: true })
    envelope = sealTransaction(signed)
  } catch { return null }

  try {
    const res = await fetch(`${INDEXER_URL}/transactions/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: envelope }),
      signal: AbortSignal.timeout(DRY_RUN_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = await res.json() as unknown
    // The same owner-key and template guards the claim path uses. They matter no less here: a
    // result naming somebody else's component must never be adopted as ours.
    return extractAccountAddress(json, ownerPkHex)
  } catch { return null }
}

/**
 * How the address is discovered. Defaults to the live dry-run probe; a test supplies a fake.
 *
 * The same injectable seam readRevealedBalance uses for its vault resolver — it keeps the network
 * and the SDK out of the policy tests without mocking the module graph. The probe's own guards are
 * tested where they live, against real response shapes, in accountAddress.test.ts.
 */
export type AccountProbe = (wallet: SecretKeyWallet) => Promise<string | null>

/**
 * Ensure this wallet's account address is stored, recovering it if it is not.
 *
 * Returns the address in use — the one already stored, the one just recovered, or `null` if the
 * probe could not answer.
 *
 * WHEN TO CALL IT: on unlock, and only when nothing is stored. That gate is the entire trigger
 * policy, and it is enough because the probe is free. There is deliberately no attempt to guess
 * whether an account "probably exists" first — every signal that could inform such a guess is
 * either unavailable (the indexer has no owner-based lookup) or requires the very address being
 * recovered. Guessing would add a failure mode to save an HTTP request.
 *
 * IDEMPOTENT AND CHEAP ON THE COMMON PATH: a wallet that already has an address short-circuits
 * before touching the network, so this is a no-op for every wallet after the first unlock.
 * saveAccountAddress is first-write-wins, so even a concurrent recovery cannot overwrite a good
 * value with a different one.
 */
export async function recoverAccountAddress(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  probe: AccountProbe = probeAccountAddress,
): Promise<string | null> {
  const stored = loadAccountAddress(ownerAddress)
  if (stored) return stored

  const recovered = await probe(wallet)
  if (recovered) saveAccountAddress(ownerAddress, recovered)
  return recovered
}
