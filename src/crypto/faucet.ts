/**
 * Browser-side testnet faucet claim for a self-custodial wallet.
 * Ported from tarijs-reference examples (stealth/_common.ts `faucetStealth`), same pattern as
 * confidentialSend.ts: build → signTransaction → sealTransaction → indexer submit, self-signed
 * with the wallet's own in-browser key. No daemon.
 *
 * The claim tx creates an account on demand, calls the public faucet's `take`, withdraws the
 * revealed slice, and StealthTransfers it as a confidential deposit to the wallet's own address —
 * the faucet covers BOTH the tokens and the tx fee, so a 0-balance wallet can claim. The result is
 * a confidential UTXO the existing wallet scanner picks up as balance.
 */

import {
  TransactionBuilder,
  WasmStealthCrypto,
  Network,
  Mask,
  TARI_RESOURCE_ADDRESS,
  XTR_FAUCET_COMPONENT_ADDRESS,
  XTR_FAUCET_VAULT_ADDRESS,
  XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  StealthTransferStatement,
  createOutput,
  signBalanceProof,
  stealthTransferInstruction,
  resourceAddressLiteral,
  amountLiteral,
  signTransaction,
  sealTransaction,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import { extractAccountAddress } from './accountAddress'
import { nextMaxEpoch } from './epoch'
import { dryRunFee, withFeeMargin } from './feeProbe'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'
/**
 * What one `XtrFaucet.take` deposits: 1_000_000_000 µtTARI (~1000 tTARI). The claim withdraws
 * EXACTLY this and splits it into the stealth output plus the fee, so `stealthAmount + fee` must
 * always equal it — withdrawing more aborts with `Bucket or vault contained insufficient revealed
 * funds`, which is precisely what a naive "just raise the fee" fix would have caused.
 */
const FAUCET_PAYOUT_MICROTARI = 1_000_000_000n

/**
 * Fee reserved for the DRY RUN only — never submitted for real. It has to be comfortably above the
 * true cost so the simulation runs to completion (an under-funded probe aborts before the network
 * has priced the whole transaction, which is how the first diagnosis of this outage read 2 738
 * when the real figure was 13 211), and comfortably under FAUCET_PAYOUT_MICROTARI so the withdraw
 * still balances. Unconsumed reservation is reported back as overcharge and costs nothing.
 */
const FEE_PROBE_MICROTARI = 50_000n

export type ClaimOutcome = 'Commit' | 'Reject' | 'Timeout'
export interface ClaimResult {
  txId: string
  outcome: ClaimOutcome
  /** The confidential amount deposited (µtTARI) if committed. */
  amount: bigint
  /**
   * The wallet's Ootle ACCOUNT COMPONENT address, read out of the committed result's up-substates.
   *
   * The claim is the one transaction Caravel runs that executes `CreateAccount`, so it is the one
   * chance to learn this address — it cannot be derived client-side (see accountAddress.ts). The
   * caller persists it; nothing here writes to storage, keeping this module free of a storage
   * dependency exactly as it is free of a React one.
   *
   * Undefined whenever the address could not be read: a non-committed outcome, a timed-out poll, or
   * a result shape we did not recognise. Never an error — the claim itself is unaffected.
   */
  accountAddress?: string
}

function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * Poll the indexer for the claim tx's final decision (up to ~32s), and on a commit also read the
 * account component address out of the SAME response.
 *
 * The address extraction rides along here rather than in a second request because this response
 * already contains it — the previous version parsed `final_decision` out of the body and threw the
 * rest away. Nothing about the polling loop or its timings changes.
 */
async function pollOutcome(txId: string, ownerPkHex: string): Promise<{ outcome: ClaimOutcome; accountAddress?: string }> {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>(r => setTimeout(r, 4_000))
    try {
      const res = await fetch(`${INDEXER_URL}/transactions/${txId}/result`)
      if (!res.ok) continue
      const json = await res.json() as { result?: { Finalized?: { final_decision?: string } } }
      const decision = json.result?.Finalized?.final_decision
      if (decision === 'Commit') {
        // Only a COMMIT creates substates. A rejected transaction's result carries no Accept diff,
        // so there is nothing to read and nothing to store.
        return { outcome: 'Commit', accountAddress: extractAccountAddress(json, ownerPkHex) ?? undefined }
      }
      if (decision) return { outcome: 'Reject' }
    } catch { /* transient */ }
  }
  return { outcome: 'Timeout' }
}

/**
 * Claim testnet tTARI into `ownerAddress`, self-signed by `wallet`. Returns once the claim tx has a
 * final on-chain decision — the caller must still rescan to see the balance land.
 */
export async function claimFaucet(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  onProgress?: (msg: string) => void,
): Promise<ClaimResult> {
  const log = (m: string) => onProgress?.(m)

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const ownerPkHex = toHexStr(await wallet.getPublicKey())

  // 0.39: mandatory validity window — the builder cannot be constructed without the chain tip.
  // Read ONCE and used for both the dry run and the real submission: the two are seconds apart and
  // the window is ~10 epochs wide (see crypto/epoch.ts), so re-reading would buy nothing, while
  // letting them differ would mean simulating a transaction that is not the one submitted.
  const maxEpoch = await nextMaxEpoch(provider)

  // Everything downstream of the fee has to be rebuilt when the fee changes — the outputs statement
  // commits to it, the withdraw amount is derived from it, and the balance proof signs over both.
  // So the whole build is a function OF the fee, called once to price the transaction and once to
  // send it. The wasm work is a few hundred milliseconds; paying it twice is the cost of not
  // hardcoding a number that goes stale.
  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    // The withdraw takes the WHOLE payout and splits it; see FAUCET_PAYOUT_MICROTARI.
    const stealthAmount = FAUCET_PAYOUT_MICROTARI - feeMicrotari
    const revealedInputAmount = stealthAmount + feeMicrotari

    const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(
      [createOutput({ destination: ownerAddress, amount: stealthAmount, resourceAddress: TARI_RESOURCE_ADDRESS })],
      feeMicrotari,
    )
    const inputsStatement = await crypto.buildInputsStatement([], revealedInputAmount)
    const balanceProof = await signBalanceProof(crypto, Mask.zero(), outputMask, inputsStatement, outputsStatement)
    const statement = new StealthTransferStatement(inputsStatement, outputsStatement, balanceProof)

    const builder = buildClaim(maxEpoch, ownerPkHex, revealedInputAmount, statement)
    const unsigned = builder.buildUnsignedTransaction()
    // `dry_run` must ride INSIDE the sealed envelope — the dry-run endpoint refuses anything else.
    const signed = await signTransaction([wallet], dryRun ? { ...unsigned, dry_run: true } : unsigned)
    return { envelope: sealTransaction(signed), stealthAmount }
  }

  log('Estimating network fee…')
  const probe = await buildEnvelope(FEE_PROBE_MICROTARI, true)
  const cost = await dryRunFee(INDEXER_URL, probe.envelope)
  const fee = withFeeMargin(cost)
  if (fee >= FAUCET_PAYOUT_MICROTARI) {
    throw new Error(`Network fee (${fee} µtTARI) exceeds the faucet's payout — the faucet cannot cover its own claim.`)
  }

  log('Building claim…')
  const real = await buildEnvelope(fee, false)
  const stealthAmount = real.stealthAmount

  log('Submitting…')
  const sub = await provider.submitTransaction(real.envelope)
  const txId = sub.transaction_id as string

  log('Confirming on-chain…')
  const { outcome, accountAddress } = await pollOutcome(txId, ownerPkHex)
  provider.stopWatcher?.()
  return { txId, outcome, amount: stealthAmount, accountAddress }
}

// The instruction recipe, lifted out so the pricing build and the real build are provably the same
// transaction shape and can only differ in the fee that is threaded through them.
function buildClaim(
  maxEpoch: number,
  ownerPkHex: string,
  revealedInputAmount: bigint,
  statement: StealthTransferStatement,
) {
  return new TransactionBuilder(Network.Esmeralda, maxEpoch)
    .withFeeInstructionsBuilder((b) =>
      b
        .createAccount(ownerPkHex)
        .saveVar('account')
        .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: 'take' }, [{ Workspace: 'account' }])
        .callMethod({ fromWorkspace: 'account', methodName: 'withdraw' }, [
          resourceAddressLiteral(TARI_RESOURCE_ADDRESS),
          amountLiteral(revealedInputAmount),
        ])
        .saveVar('bucket')
        .addInstruction(
          stealthTransferInstruction(
            { resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: 'bucket', statement },
            (name) => b.resolveWorkspaceOffsetId(name),
          ),
        )
        .saveVar('fee_bucket')
        .addInstruction({ PayFeeFromBucket: { bucket: b.resolveWorkspaceOffsetId('fee_bucket') } }),
    )
    .withInputs([
      { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null },
    ])
}
