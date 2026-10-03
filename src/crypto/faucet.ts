/**
 * Browser-side claim from Caravel's own testnet faucet, self-signed by the wallet's in-browser key.
 * Same pipeline as confidentialSend.ts: build → signTransaction → sealTransaction → indexer submit.
 * No daemon.
 *
 * The faucet is the `CaravelFaucet` component in faucetConfig.ts. Tari's built-in faucet
 * (`XtrFaucet.take`) is no longer used.
 *
 * ── THE TRANSACTION ──────────────────────────────────────────────────────────
 *
 * Everything runs in the FEE phase, in this order:
 *
 *     faucet.claim(ownerPk)                         → 'payout'      (a bucket of claim_amount)
 *     StealthTransfer(revealed input: 'payout')     → 'fee_bucket'
 *         private output  claim_amount − fee  → this wallet's own address
 *         revealed output fee                 → receiver = ownerPk
 *     PayFeeFromBucket('fee_bucket')
 *
 * The payout covers the fee, so a wallet with a zero balance can claim. There is no CreateAccount:
 * the payout lands as a private coin, which needs no account component, and the account is created
 * by the first make-public / public send as it already is for a wallet funded by receiving.
 *
 * Because it is all fee phase, a refused claim — already claimed, paused, empty — is a plain
 * Reject and costs the claimant nothing.
 *
 * ── WHO MAY CLAIM ────────────────────────────────────────────────────────────
 *
 * `claim(claimer)` requires the transaction to be signed by `claimer`, and mints-and-burns a receipt
 * NFT whose id is `claimer`, so each key claims once, ever. The wallet signs with its owner key and
 * names that same key, which is also the receiver of the fee slice — since Ootle 0.42 the engine only
 * creates that bucket if the receiver's badge is in the transaction's auth scope.
 */

import { substateStillAbsent, submitOnce } from './submitGuard'
import { RETRYING_MESSAGE } from './indexerRetry'
import {
  TransactionBuilder,
  WasmStealthCrypto,
  Network,
  Mask,
  TARI_RESOURCE_ADDRESS,
  StealthTransferStatement,
  createOutput,
  signBalanceProof,
  stealthTransferInstruction,
  publicKeyLiteral,
  signTransaction,
  sealTransaction,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import { nextMaxEpoch } from './epoch'
import { dryRunFee, withFeeMargin } from './feeProbe'
import { readOutputSubstateIds } from './outputIds'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { awaitFinality } from './finality'
import { INDEXER_URL } from './indexerConfig'
import {
  FAUCET_COMPONENT_ADDRESS,
  FAUCET_RECEIPTS_RESOURCE_ADDRESS,
  FAUCET_VAULT_ADDRESS,
  faucetReceiptId,
} from './faucetConfig'
import { markFaucetClaimed, readFaucetStatus } from './faucetStatus'

/**
 * Fee reserved for the DRY RUN only — never submitted for real. It has to be comfortably above the
 * true cost so the simulation runs to completion (an under-funded probe aborts before the network
 * has priced the whole transaction), and far under the claim amount so the statement still
 * balances. Unconsumed reservation is reported back as overcharge and costs nothing.
 */
export const FEE_PROBE_MICROTARI = 50_000n

export type ClaimOutcome = 'Commit' | 'Reject' | 'Timeout'
export interface ClaimResult {
  txId: string
  outcome: ClaimOutcome
  /**
   * What the network said when it refused, verbatim inside a sentence — see crypto/txResult.
   * Present on `Reject` and absent on `Commit`/`Timeout`.
   */
  reason?: string
  /** The private amount deposited (µtTARI) if committed: the claim amount less the fee. */
  amount: bigint
  /** Fee this claim paid (µtTARI), out of the payout. Recorded by the journal at action time. */
  feeMicrotari?: bigint
  /**
   * Substate ids of the outputs this transaction creates FOR US — see outputIds.ts. `[]` means it
   * creates none; `undefined` means the statement could not be read.
   */
  selfOutputIds?: string[]
}

// ── REFUSALS ─────────────────────────────────────────────────────────────────

/** The reasons the faucet itself refuses a claim, as opposed to the network failing. */
export type ClaimRefusal = 'already-claimed' | 'paused' | 'empty' | 'unsigned'

/**
 * Recognise the faucet's own refusals in a network reason, in whatever wrapping it arrives — a
 * dry-run error message, a reject reason, a describeRejectReason string. Returns null for anything
 * else, which the caller shows as the network wrote it.
 *
 * The phrases are the engine's and the template's own:
 *   "Duplicate NFT token id"                 the receipt for this key already exists
 *   "Faucet is paused"                       claim()'s pause assert
 *   "Faucet is empty"                        claim()'s balance assert
 *   "unknown or out of scope signer badge"   the claimer did not sign — a bug on our side
 */
export function classifyClaimFailure(reason: string): ClaimRefusal | null {
  if (/Duplicate NFT token id/i.test(reason)) return 'already-claimed'
  if (/Faucet is paused/i.test(reason)) return 'paused'
  if (/Faucet is empty/i.test(reason)) return 'empty'
  if (/out of scope signer badge/i.test(reason)) return 'unsigned'
  return null
}

/** What to tell the user for each refusal. None of them took anything from the wallet. */
export function claimRefusalMessage(refusal: ClaimRefusal): string {
  switch (refusal) {
    case 'already-claimed': return 'This wallet has already claimed its test funds.'
    case 'paused': return 'The faucet is paused right now. Check back soon.'
    case 'empty': return 'The faucet is empty right now. Check back soon.'
    case 'unsigned': return 'The claim could not be signed correctly. Nothing was taken.'
  }
}

/** Thrown when the faucet refuses before anything is submitted. `refusal` says why. */
export class FaucetClaimRefused extends Error {
  readonly refusal: ClaimRefusal
  constructor(refusal: ClaimRefusal) {
    super(claimRefusalMessage(refusal))
    this.name = 'FaucetClaimRefused'
    this.refusal = refusal
  }
}

function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * Claim testnet tTARI into `ownerAddress`, self-signed by `wallet`. Returns once the claim tx has a
 * final on-chain decision — the caller must still rescan to see the balance land.
 *
 * Throws FaucetClaimRefused if the faucet would refuse (already claimed, paused, empty), found
 * either by the status read or by the pricing dry run — in both cases before anything is
 * submitted. Any other throw is a network or build failure.
 */
export async function claimFaucet(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  onProgress?: (msg: string) => void,
): Promise<ClaimResult> {
  const prepared = await prepareClaim(wallet, ownerAddress, onProgress)
  return prepared.submit()
}

/** A claim that has been checked and priced, and not yet submitted. */
export interface PreparedClaim {
  /** What the faucet pays per claim (µtTARI), read live. */
  claimAmount: bigint
  /** What the dry run measured the transaction to cost (µtTARI), before the margin. */
  dryRunCost: bigint
  /** The fee the real transaction will reserve (µtTARI): the cost plus margin. */
  fee: bigint
  /** What lands in the wallet as a private coin: claimAmount − fee. */
  privateAmount: bigint
  /** Build at `fee`, submit, and wait for the final decision. The only step that writes. */
  submit: () => Promise<ClaimResult>
}

/**
 * Everything up to submission: status read, dry run, fee. Nothing is submitted — the dry run is a
 * simulation, and it is the authoritative check, since it runs claim() itself.
 *
 * Throws exactly as claimFaucet does before submission.
 */
export async function prepareClaim(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  onProgress?: (msg: string) => void,
): Promise<PreparedClaim> {
  const log = (m: string) => onProgress?.(m)

  const ownerPk = await wallet.getPublicKey()
  const ownerPkHex = toHexStr(ownerPk)

  // The claim amount is read live: the faucet's admin can change it, and the statement below has to
  // balance against the bucket claim() returns to the µtTARI.
  log('Checking the faucet…')
  const status = await readFaucetStatus(ownerAddress, ownerPkHex)
  if (status.kind === 'claimed') throw new FaucetClaimRefused('already-claimed')
  if (status.kind === 'paused') throw new FaucetClaimRefused('paused')
  if (status.kind === 'empty') throw new FaucetClaimRefused('empty')
  if (status.kind === 'unknown') throw new Error(`Could not reach the faucet: ${status.reason}. Nothing was claimed.`)
  const claimAmount = status.claimAmount

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const crypto = new WasmStealthCrypto(Network.Esmeralda)

  // 0.39: mandatory validity window. Read ONCE and used for both the dry run and the real
  // submission, so the simulated transaction is the one submitted.
  const maxEpoch = await nextMaxEpoch(provider)

  // Everything downstream of the fee is rebuilt when the fee changes — the outputs statement commits
  // to it and the balance proof signs over it — so the build is a function OF the fee, run once to
  // price and once to send.
  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    const privateAmount = claimAmount - feeMicrotari
    const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(
      [createOutput({ destination: ownerAddress, amount: privateAmount, resourceAddress: TARI_RESOURCE_ADDRESS })],
      { amount: feeMicrotari, receiver: ownerPk },
    )
    const inputsStatement = await crypto.buildInputsStatement([], claimAmount)
    const balanceProof = await signBalanceProof(crypto, Mask.zero(), outputMask, inputsStatement, outputsStatement)
    const statement = new StealthTransferStatement(inputsStatement, outputsStatement, balanceProof)

    const unsigned = buildClaim(maxEpoch, ownerPkHex, statement).buildUnsignedTransaction()
    // `dry_run` must ride INSIDE the sealed envelope — the dry-run endpoint refuses anything else.
    const signed = await signTransaction([wallet], dryRun ? { ...unsigned, dry_run: true } : unsigned)
    return { envelope: sealTransaction(signed), privateAmount, selfOutputIds: readOutputSubstateIds(outputsStatement) ?? undefined }
  }

  log('Estimating network fee…')
  const probe = await buildEnvelope(FEE_PROBE_MICROTARI, true)
  let cost: bigint
  try {
    cost = await dryRunFee(INDEXER_URL, probe.envelope, { onBusyRetry: () => log(RETRYING_MESSAGE) })
  } catch (e) {
    // The dry run is the authoritative check: it runs claim() itself. A refusal here is the faucet
    // answering, not the network failing — and a duplicate is a chain fact worth keeping.
    const refusal = classifyClaimFailure(e instanceof Error ? e.message : String(e))
    if (refusal === 'already-claimed') markFaucetClaimed(ownerAddress)
    if (refusal) throw new FaucetClaimRefused(refusal)
    throw e
  }
  const fee = withFeeMargin(cost)
  if (fee >= claimAmount) {
    throw new Error(`Network fee (${fee} µtTARI) exceeds the faucet's payout — the faucet cannot cover its own claim.`)
  }

  async function submit(): Promise<ClaimResult> {
    log('Building claim…')
    const real = await buildEnvelope(fee, false)

    log('Submitting…')
    // A claim creates this key's receipt, so while every indexer says it is absent the claim has not landed.
    const sub = await submitOnce(() => provider.submitTransaction(real.envelope), {
      landed: substateStillAbsent(faucetReceiptId(ownerPkHex)),
      onBusyRetry: () => log(RETRYING_MESSAGE),
    })
    const txId = sub.transaction_id as string

    log('Confirming on-chain…')
    // TOLD, NOT ASKED — see crypto/finality. A fee-only commit is still a failure.
    const { outcome, reason } = await awaitFinality(provider, txId)
    provider.stopWatcher?.()

    // Both of these are the chain saying this key has now claimed.
    if (outcome === 'Commit' || (reason && classifyClaimFailure(reason) === 'already-claimed')) markFaucetClaimed(ownerAddress)

    return { txId, outcome, reason, amount: real.privateAmount, feeMicrotari: fee, selfOutputIds: real.selfOutputIds }
  }

  return { claimAmount, dryRunCost: cost, fee, privateAmount: claimAmount - fee, submit }
}

/**
 * The instruction recipe, lifted out so the pricing build and the real build are provably the same
 * transaction shape, differing only in the statement (which carries the fee). Exported for tests.
 */
export function buildClaim(maxEpoch: number, ownerPkHex: string, statement: StealthTransferStatement) {
  return new TransactionBuilder(Network.Esmeralda, maxEpoch)
    .withFeeInstructionsBuilder((b) =>
      b
        .callMethod({ componentAddress: FAUCET_COMPONENT_ADDRESS, methodName: 'claim' }, [publicKeyLiteral(hexToBytes(ownerPkHex))])
        .saveVar('payout')
        .addInstruction(
          stealthTransferInstruction(
            { resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: 'payout', statement },
            (name) => b.resolveWorkspaceOffsetId(name),
          ),
        )
        .saveVar('fee_bucket')
        .addInstruction({ PayFeeFromBucket: { bucket: b.resolveWorkspaceOffsetId('fee_bucket') } }),
    )
    .withInputs([
      { substate_id: FAUCET_COMPONENT_ADDRESS, version: null },
      { substate_id: FAUCET_VAULT_ADDRESS, version: null },
      { substate_id: FAUCET_RECEIPTS_RESOURCE_ADDRESS, version: null },
    ])
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
