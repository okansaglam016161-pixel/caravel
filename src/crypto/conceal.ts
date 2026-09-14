// CONCEAL — move revealed (public) TARI into stealth (private) outputs. M2.
//
// The safe direction: value ends up MORE private than it started, and nothing about it is
// irreversible in the way revealing is. Structurally it is faucet.ts's claim minus one instruction:
//
//     createAccount(ownerPk)                            → 'account'   [idempotent — reuses existing]
//     callMethod(account, 'withdraw', [TARI, amount])   → 'bucket'    revealed OUT of the vault
//     StealthTransfer { revealedInputBucket: 'bucket' } → 'fee_bucket'
//     PayFeeFromBucket { fee_bucket }
//
// The claim additionally calls the faucet's `take` to fill the vault first; a standalone conceal
// spends a balance that is already there. Everything else — the statement construction, the zero
// input mask, the dry-run-then-rebuild fee discovery — is the claim's, unchanged.
//
// ── THE INVARIANT THAT MATTERS ────────────────────────────────────────────────
//
// The engine checks, with NO tolerance (tari-ootle: runtime/working_state.rs:2062-2074):
//
//     bucket.unlocked_amount() == statement.inputs_statement.revealed_amount
//
// The bucket comes from the `withdraw` instruction; the revealed amount comes from
// buildInputsStatement. Two derivations of "the same" number is exactly how that check starts
// failing, so there is only ONE: planConceal computes the split once, and the single
// `withdrawAmount` it returns is threaded to both places. assertConcealSplit re-checks it
// immediately before the transaction is built, so a future edit that reintroduces a second
// derivation trips an assertion here rather than an opaque engine rejection on-chain.

import {
  Mask,
  Network,
  StealthTransferStatement,
  TARI_RESOURCE_ADDRESS,
  TransactionBuilder,
  WasmStealthCrypto,
  amountLiteral,
  createOutput,
  resolveTransaction,
  resourceAddressLiteral,
  sealTransaction,
  signBalanceProof,
  signTransaction,
  stealthTransferInstruction,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { extractAccountAddress } from './accountAddress'
import { loadAccountAddress, saveAccountAddress } from './accountStore'
import { resolveAccountInputs } from './substates'
import { nextMaxEpoch } from './epoch'
import { dryRunFee, withFeeMargin } from './feeProbe'
import { readOutputSubstateIds } from './outputIds'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'

/**
 * Fee reserved for the DRY RUN only — never submitted for real, and refunded as overcharge in the
 * simulation. Mirrors the faucet's probe for the same reason: an under-funded probe aborts before
 * the network has priced the whole transaction, reporting a cost far below the truth.
 */
const FEE_PROBE_MICROTARI = 50_000n

/**
 * Smallest amount that may be concealed, in µtTARI (0.1 tTARI).
 *
 * Not arbitrary: the dry run reserves FEE_PROBE_MICROTARI out of the amount being moved, so an
 * amount at or below the probe cannot be simulated at all — the withdraw would have to produce a
 * negative stealth output. This floor sits comfortably above both the probe and every measured real
 * fee (~13–16k), so the probe always has room and the user gets a clear refusal instead of a
 * confusing simulation failure.
 */
export const MIN_CONCEAL_MICROTARI = 100_000n

export type ConcealOutcome = 'Commit' | 'Reject' | 'Timeout'

export interface ConcealResult {
  txId: string
  outcome: ConcealOutcome
  /** What actually landed in stealth (µtTARI) — the amount moved minus the fee. */
  concealedAmount: bigint
  /** Fee actually reserved for this transaction (µtTARI). */
  feeMicrotari: bigint
  /**
   * Substate ids of the outputs this transaction creates FOR US.
   *
   * READ-ONLY REPORTING — nothing about the transaction changes. It surfaces commitments the build
   * already computes and previously discarded, so the activity journal can record them and receive
   * reconciliation can later subtract our own outputs from the scan. See outputIds.ts.
   *
   * `[]` means the transaction genuinely creates none. `undefined` means the statement could not be
   * read, which the journal stores as a hole rather than as "none".
   */
  selfOutputIds?: string[]
  /** Account address read from the committed result — the free capture for pre-M1 wallets. */
  accountAddress?: string
}

export interface ConcealParams {
  /**
   * Total revealed µtTARI to move OUT of the vault. The fee is paid FROM this, so what lands
   * private is `amount - fee`. Defined this way so "conceal everything" is expressible exactly —
   * pass the whole revealed balance and the withdraw can never exceed it.
   */
  amountMicrotari: bigint
  onProgress?: (msg: string) => void
}

// ── The fund-critical arithmetic, isolated so it can be tested ────────────────

export interface ConcealSplit {
  /** Revealed µtTARI leaving the vault. IS the statement's revealed input — one value, both uses. */
  withdrawAmount: bigint
  /** Stealth output: what ends up private. */
  stealthAmount: bigint
  /** Revealed output: becomes the fee bucket. */
  feeMicrotari: bigint
}

/**
 * Split an amount into its stealth output and its fee, for a given fee.
 *
 * The whole `amount` leaves the vault; the fee is carved out of it as the transaction's revealed
 * output, and the remainder becomes the stealth output. So `withdrawAmount === amount` always, and
 * that is the number the engine will compare against the bucket.
 *
 * Throws rather than returning a degenerate split: a fee at or above the amount would mean a
 * zero-or-negative stealth output, and a StealthTransfer with no stealth output is not a conceal.
 */
export function planConceal(amountMicrotari: bigint, feeMicrotari: bigint): ConcealSplit {
  if (amountMicrotari <= 0n) throw new Error('Amount must be greater than zero.')
  if (feeMicrotari <= 0n) throw new Error('Fee must be greater than zero.')
  if (feeMicrotari >= amountMicrotari) {
    throw new Error(`The network fee (${feeMicrotari} µtTARI) is not covered by the amount being moved (${amountMicrotari} µtTARI).`)
  }
  return {
    withdrawAmount: amountMicrotari,
    stealthAmount: amountMicrotari - feeMicrotari,
    feeMicrotari,
  }
}

/**
 * Re-check the split's arithmetic immediately before it is used to build a transaction.
 *
 * Redundant by construction today — planConceal cannot produce a split that fails this. That is the
 * point: it is a tripwire for a future edit that computes the withdraw amount separately from the
 * statement's revealed input. Failing here is a caught bug; failing on-chain is a rejected
 * transaction whose reason is a bucket-mismatch string from the engine.
 */
export function assertConcealSplit(split: ConcealSplit): void {
  const { withdrawAmount, stealthAmount, feeMicrotari } = split
  if (withdrawAmount <= 0n || stealthAmount <= 0n || feeMicrotari <= 0n) {
    throw new Error(`conceal: non-positive component in split (withdraw ${withdrawAmount}, stealth ${stealthAmount}, fee ${feeMicrotari})`)
  }
  if (stealthAmount + feeMicrotari !== withdrawAmount) {
    throw new Error(`conceal: split does not balance — stealth ${stealthAmount} + fee ${feeMicrotari} !== withdraw ${withdrawAmount}`)
  }
}

// ── Transaction ───────────────────────────────────────────────────────────────

/**
 * The instruction recipe, lifted out so the pricing build and the real build are provably the same
 * transaction shape and can only differ in the fee threaded through them — the same discipline
 * faucet.ts's buildClaim uses, for the same reason.
 *
 * `withdrawAmount` appears exactly once here, and the caller passes the same value into
 * buildInputsStatement. That single-use is what upholds the engine's equality check.
 */
function buildConceal(
  maxEpoch: number,
  ownerPkHex: string,
  withdrawAmount: bigint,
  statement: StealthTransferStatement,
  declaredInputs: string[],
) {
  return new TransactionBuilder(Network.Esmeralda, maxEpoch)
    .withFeeInstructionsBuilder((b) =>
      b
        // Create-or-reuse: the engine derives the address from the owner key and returns the
        // existing component if there is one, so this is safe to issue on every conceal.
        .createAccount(ownerPkHex)
        .saveVar('account')
        .callMethod({ fromWorkspace: 'account', methodName: 'withdraw' }, [
          resourceAddressLiteral(TARI_RESOURCE_ADDRESS),
          amountLiteral(withdrawAmount),
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
    // ── THE INPUTS ARE NOT OPTIONAL ──
    //
    // `CreateAccount` only REUSES an existing account when that component is declared as an input.
    // Without it the engine loads nothing, mints a fresh empty account in the working state, and the
    // `withdraw` below panics with "No vault for resource". Declaring the component gets past that
    // and then the vault must be declared too, or the withdraw fails with "SubstateNotFound".
    //
    // resolveTransaction does NOT fill these in — it was measured returning `inputs: []` for exactly
    // this transaction shape. Both ids have to be known and named here.
    .withInputs(declaredInputs.map(substate_id => ({ substate_id, version: null })))
}

/** Poll the indexer for the conceal tx's decision, reading the account address from the same body. */
async function pollOutcome(txId: string, ownerPkHex: string): Promise<{ outcome: ConcealOutcome; accountAddress?: string }> {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>(r => setTimeout(r, 4_000))
    try {
      const res = await fetch(`${INDEXER_URL}/transactions/${txId}/result`)
      if (!res.ok) continue
      const json = await res.json() as { result?: { Finalized?: { final_decision?: string } } }
      const decision = json.result?.Finalized?.final_decision
      if (decision === 'Commit') return { outcome: 'Commit', accountAddress: extractAccountAddress(json, ownerPkHex) ?? undefined }
      if (decision) return { outcome: 'Reject' }
    } catch { /* transient */ }
  }
  return { outcome: 'Timeout' }
}

/**
 * A priced, built, signed conceal — everything except pressing send.
 *
 * The flow is deliberately two-phase so the fee a user approves is the fee the transaction pays.
 * A separate "quote the fee" call would have to price one transaction and submit a different one,
 * and any drift between them is either a rejection or a surprise. Here the dry run happens once,
 * during prepare, and `submit` sends the very envelope that was priced.
 */
export interface PreparedConceal {
  /** Measured fee including margin (µtTARI) — what the review screen shows and the tx pays. */
  feeMicrotari: bigint
  /** What will land private: the amount moved minus the fee. */
  concealedAmount: bigint
  /** Total leaving the vault — the withdraw, and the statement's revealed input. */
  withdrawAmount: bigint
  /** Send it. Resolves once the transaction has a final on-chain decision. */
  submit: (onProgress?: (msg: string) => void) => Promise<ConcealResult>
}

/**
 * Price and build a conceal without sending it.
 *
 * Does all the network work that can fail for boring reasons — connecting, resolving the account's
 * vaults, reading the epoch, the dry run — so the review screen can show a real fee and the confirm
 * step is just a submission.
 */
export async function prepareConceal(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  { amountMicrotari, onProgress }: ConcealParams,
): Promise<PreparedConceal> {
  const log = (m: string) => onProgress?.(m)

  if (amountMicrotari < MIN_CONCEAL_MICROTARI) {
    throw new Error(`The smallest amount that can be made private is ${MIN_CONCEAL_MICROTARI} µtTARI (0.10 TARI).`)
  }

  // The account address is a HARD PREREQUISITE, not a nicety: without it the transaction cannot
  // declare the account as an input, and without that declaration CreateAccount mints a fresh empty
  // account and the withdraw panics. Recovery (accountRecovery.ts) runs on unlock and is free, so
  // reaching here without one means the probe could not answer — a network problem, reported as one.
  const accountAddress = loadAccountAddress(ownerAddress)
  if (!accountAddress) {
    throw new Error('This wallet\u2019s account could not be identified, so its public balance cannot be moved. Check your connection and try again.')
  }

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const ownerPkHex = toHexStr(await wallet.getPublicKey())

  // ── THE ACCOUNT MAY NOT EXIST YET, AND THAT IS NOT AN ERROR ────────────────
  //
  // A wallet funded only by RECEIVING holds real stealth UTXOs and has never created an account
  // component — private send and receive never touch one. Declaring a component that is not there
  // aborts with "Substate not found" before anything is signed, which is how every public action on
  // such a wallet used to 404.
  //
  // So: declare the component and its vaults when it EXISTS (CreateAccount then reuses it), and
  // declare NOTHING when it does not (CreateAccount then mints it, exactly as the faucet claim does
  // — which is how every account in Caravel has ever come to exist). Getting that backwards on an
  // account that DOES exist would deposit into a throwaway component and lose the funds silently,
  // so resolveAccountInputs rethrows anything that is not a definite not-found rather than guessing.
  const { declaredInputs } = await resolveAccountInputs(provider, accountAddress)

  // Read ONCE and reused for the dry run and the real submission, exactly as the claim does: the
  // two are seconds apart in a ~10-epoch window, so re-reading buys nothing and letting them differ
  // would mean simulating a transaction that is not the one submitted.
  const maxEpoch = await nextMaxEpoch(provider)

  // The whole build is a function OF the fee — the outputs statement commits to it and the balance
  // proof signs over both — so it runs once to price and once to send.
  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    const split = planConceal(amountMicrotari, feeMicrotari)
    assertConcealSplit(split)

    const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(
      [createOutput({ destination: ownerAddress, amount: split.stealthAmount, resourceAddress: TARI_RESOURCE_ADDRESS })],
      split.feeMicrotari,
    )
    // THE SINGLE VALUE. `split.withdrawAmount` feeds the statement here and the withdraw
    // instruction below; there is no second computation of it anywhere.
    const inputsStatement = await crypto.buildInputsStatement([], split.withdrawAmount)
    // Zero input mask: a conceal has no confidential inputs, only revealed ones.
    const balanceProof = await signBalanceProof(crypto, Mask.zero(), outputMask, inputsStatement, outputsStatement)
    const statement = new StealthTransferStatement(inputsStatement, outputsStatement, balanceProof)

    const builder = buildConceal(maxEpoch, ownerPkHex, split.withdrawAmount, statement, declaredInputs)
    // resolveTransaction still runs, to pin versions on the ids we declared — but it is the explicit
    // declaration above that makes the transaction work, not this.
    const unsigned = await resolveTransaction(provider, builder.buildUnsignedTransaction())
    const signed = await signTransaction([wallet], dryRun ? { ...unsigned, dry_run: true } : unsigned)
    return { envelope: sealTransaction(signed), split, selfOutputIds: readOutputSubstateIds(outputsStatement) ?? undefined }
  }

  log('Estimating network fee\u2026')
  const probe = await buildEnvelope(FEE_PROBE_MICROTARI, true)
  const cost = await dryRunFee(INDEXER_URL, probe.envelope)
  const fee = withFeeMargin(cost)
  // The probe→real fee guard, applied here for the same reason as the other three builders even
  // though this path is the least exposed: its output count is invariant (one stealth output at any
  // fee), so no shape can diverge. What remains true everywhere is that a fee above the reservation
  // was never simulated, and building on an unsimulated number is how the MAX rejection happened.
  if (fee > FEE_PROBE_MICROTARI) {
    throw new Error(
      `The network fee (${fee} µtTARI) exceeds the ${FEE_PROBE_MICROTARI} µtTARI this transaction reserved for it. ` +
      `Fees have risen — try again in a moment.`,
    )
  }
  if (fee >= amountMicrotari) {
    throw new Error(`The network fee (${fee} \u00b5tTARI) exceeds the amount being made private. Try a larger amount.`)
  }

  log('Building\u2026')
  const real = await buildEnvelope(fee, false)

  return {
    feeMicrotari: fee,
    concealedAmount: real.split.stealthAmount,
    withdrawAmount: real.split.withdrawAmount,
    submit: async (onSubmitProgress?: (msg: string) => void) => {
      const slog = (m: string) => onSubmitProgress?.(m)
      slog('Submitting\u2026')
      const sub = await provider.submitTransaction(real.envelope)
      const txId = sub.transaction_id as string

      slog('Confirming on-chain\u2026')
      const { outcome, accountAddress: confirmedAccount } = await pollOutcome(txId, ownerPkHex)
      provider.stopWatcher?.()

      // The free capture: a conceal runs CreateAccount, so a wallet that never stored its address
      // from a claim gets one here. saveAccountAddress is first-write-wins, so a repeat is a no-op.
      if (confirmedAccount) saveAccountAddress(ownerAddress, confirmedAccount)

      return { txId, outcome, concealedAmount: real.split.stealthAmount, feeMicrotari: fee, accountAddress: confirmedAccount, selfOutputIds: real.selfOutputIds }
    },
  }
}

/**
 * Prepare and submit in one call. The one-shot form, for callers with nothing to review.
 */
export async function concealFunds(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  params: ConcealParams,
): Promise<ConcealResult> {
  const prepared = await prepareConceal(wallet, ownerAddress, params)
  return prepared.submit(params.onProgress)
}

function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
