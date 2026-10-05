/**
 * Browser-side confidential stealth send.
 * Ported from tarijs-reference/examples/node/src/stealth/confidential-send.ts
 *
 * Proven architecture: tx 836369ed… committed on Esmeralda 2026-07-19.
 * N UTXOs → recipient + change + fee, all inside fee_instructions (single StealthTransfer).
 * No revealed balance, no account component.
 *
 * ── IT USED TO SPEND EXACTLY ONE OUTPUT, AND THAT WAS A MISTAKE ──────────────
 *
 * The reference example this was ported from spent a single UTXO, and the port inherited it as
 * though it were a rule: "Each single UTXO must exceed the send amount plus the fee." It is not a
 * rule. The engine allows 1000 inputs per transfer statement
 * (tari-ootle engine_types/src/limits.rs, STEALTH_LIMITS.max_inputs), inputs cost ~143× less than
 * outputs to verify, and dry runs spending 1, 2, 5, 8, 12 and 15 real outputs were all accepted
 * with the cost moving only 24 642 → 25 539 µtTARI across the range.
 *
 * The cost of believing otherwise was concrete: a wallet holding 1107 TARI across 15 outputs could
 * send at most 245 in one payment — the largest single output — and MAX offered a figure that was
 * guaranteed to fail. Selection is now the same accumulate-largest-first routine reveal.ts has used
 * since M3, shared from stealthUtxos.ts so the two cannot drift.
 */

import { inputsStillUnspent, submitOnce } from './submitGuard'
import { RETRYING_MESSAGE } from './indexerRetry'
import {
  OotleWallet,
  Network,
  TARI_RESOURCE_ADDRESS,
  StealthInput,
  StealthTransferStatement,
  TransactionBuilder,
  WasmStealthCrypto,
  createOutput,
  generateSealKeypair,
  resolveTransaction,
  sealTransaction,
  serializeUnsignedTx,
  signBalanceProof,
  signTransaction,
  stealthTransferInstruction,
  stealthUtxoSubstateId,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import { nextMaxEpoch } from './epoch'
import { dryRunFee, simulateFee, withFeeMargin, type FeeSimulation } from './feeProbe'
import { readOutputSubstateIds } from './outputIds'
// The owned-UTXO scan lives in stealthUtxos.ts so the send and reveal paths share ONE input
// discovery. It was moved out of this file unchanged; nothing about the behaviour here differs.
import {
  MAX_STEALTH_INPUTS, RESOURCE_HEX, StaticSigner, reachableTotal, scanOwnedUtxos, selectStealthInputs,
} from './stealthUtxos'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { awaitFinality } from './finality'
import { markLocked, promoteToSpent, release } from './spentOutputs'
import { loadSelectionExcludedIds, newReservationToken, releaseCoins, reserveCoins } from './coinReservations'
import { confirmer } from './quote'
import { INDEXER_URL } from './indexerConfig'


/**
 * CEILING, not the fee. The fee actually paid is discovered per transaction by dry run (see
 * crypto/feeProbe.ts) and shown exactly before confirming — 0.39's fee tables moved enough to break
 * every hardcoded figure, so this is only the upper bound: what the balance guards reserve, and what
 * the dry run reserves while pricing. It is never shown as a fee. A transaction whose measured fee
 * exceeds it is refused with a clear message rather than submitted to fail on-chain.
 *
 * RAISED FROM 10 000, WHICH 0.39 HAD ALREADY BROKEN. A send measured on esmeralda on 2026-08-20
 * cost 16 138 µtTARI (dry run predicted 16 580; reserved 20 725 with margin), so the old ceiling was
 * below even the bare cost — the send path was as broken as the faucet, it just had not been tried
 * yet. 50 000 leaves ~2.4x headroom over that measurement. Headroom is close to free here: the
 * ceiling only has to be covered by the spending UTXO, and 0.05 tTARI is noise against a ~1 000
 * tTARI faucet claim — whereas too tight a ceiling reproduces this outage on the next fee change.
 */
export const MAX_FEE = 50_000n   // 0.05 tTARI
const MICROTARI_PER_TARI = 1_000_000n

export type SendOutcome = 'Commit' | 'Reject' | 'Timeout'
export interface SendResult {
  txId: string
  outcome: SendOutcome
  /**
   * What the network said when it refused, verbatim inside a sentence — see crypto/txResult.
   *
   * Present on `Reject` and absent on `Commit`/`Timeout`. It is the only account anyone gets of why
   * a transaction failed, so it is carried out of the poll rather than logged and dropped: a fee
   * taken for nothing, or a rejection, is exactly the moment a user deserves the real reason.
   */
  reason?: string
  // Substate id of the RECIPIENT's output UTXO (specs[0]), derived from the outputs statement.
  // Used by M10.1 payment-linked messages to reference this exact output. Undefined only if the
  // commitment could not be read from the statement.
  recipientUtxoId?: string
  // Actual fee paid (µtTARI), read from the committed tx's fee receipt. Undefined if the poll
  // timed out or the receipt didn't carry it; callers fall back to the estimate.
  feeMicrotari?: bigint
  /**
   * Substate ids of the outputs this send creates FOR US — the change output, if there is one.
   *
   * READ-ONLY REPORTING. Nothing about the transaction changes; this surfaces a commitment the
   * build already computes and previously discarded. The activity journal records it so receive
   * reconciliation can later subtract our own outputs from the scan. See outputIds.ts.
   *
   * `[]` means exact cover — no change output exists. `undefined` means the statement could not be
   * read, which the journal stores as a hole rather than as "none".
   */
  selfOutputIds?: string[]
  /**
   * Substate ids of the stealth outputs this send CONSUMED.
   *
   * The field whose absence was the bug: `selection.inputs` used to live and die inside this
   * function, so nothing downstream could record what had been spent and the balance went on
   * counting it. Always populated — the inputs are chosen before anything is built — and recorded
   * by this module into crypto/spentOutputs before the verdict is known.
   */
  spentInputIds: string[]
}

export interface SendParams {
  recipient: string
  /**
   * What the recipient receives — exactly, never adjusted. Ignored when `sendAll` is set, where
   * the amount is whatever the reachable outputs hold once the fee is paid.
   */
  amountMicrotari: bigint
  /**
   * "Send all" — MAX. Spend every output selection can reach (the largest MAX_STEALTH_INPUTS) and
   * send their total minus the EXACT fee, with no change output. See prepareConfidentialSend.
   */
  sendAll?: boolean
  memo?: string
  payRef?: string
  onProgress?: (msg: string) => void
  /** How the fee is set from the measured cost. Default: feeProbe.withFeeMargin. */
  feeFor?: (costMicrotari: bigint) => bigint
  /**
   * PROOF ONLY — the harness's `prove-short-fee`, which submits a deliberately short fee to show
   * that the network rejects it and charges nothing. Skips the confirm-time check that would
   * otherwise (correctly) refuse to send it. Never set by the app.
   */
  unsafeSkipConfirm?: boolean
}

/** A priced, built, signed private send — everything except pressing send. */
export interface PreparedConfidentialSend {
  /** Measured fee including margin (µtTARI) — what the review screen shows and the tx pays. */
  feeMicrotari: bigint
  /** What the pricing dry run measured, before the margin (µtTARI). */
  dryRunCost: bigint
  /** What the recipient receives. The typed amount, or on `sendAll` the reachable total − fee. */
  recipientAmount: bigint
  /** Back to the sender: `inputTotal − amount − fee`. Zero on `sendAll` (and on exact cover). */
  changeAmount: bigint
  /** How many stealth outputs are being spent. */
  inputCount: number
  /** Their total value. */
  inputTotal: bigint
  /** Substate ids of the outputs this send will consume. */
  spentInputIds: string[]
  /** Dry-run a twin of the real transaction at `feeMicrotari` (default: the prepared fee). Free. */
  simulate: (feeMicrotari?: bigint) => Promise<FeeSimulation>
  /** When it was priced. Past QUOTE_MAX_AGE_MS the confirm check refuses it (crypto/quote). */
  preparedAt: number
  /**
   * The confirm-time check: quote age, inputs still unspent, and a dry run of the final transaction
   * at the exact fee. Throws QuoteChanged — NOTHING SENT — when it no longer holds; re-prepare.
   */
  confirm: () => Promise<void>
  /** Let go of the coins this prepare reserved (cancel, or before re-pricing). Idempotent. */
  release: () => void
  /**
   * Send THE envelope that was priced. Runs the confirm check first unless confirm() just passed.
   * Resolves once the transaction has a final decision.
   */
  submit: (onProgress?: (msg: string) => void) => Promise<SendResult>
}

// ── main export ───────────────────────────────────────────────────────────────

/** Prepare and submit in one call. The one-shot form, for callers with nothing to review. */
export async function sendConfidential(
  wallet: SecretKeyWallet,
  senderAddress: string,
  params: SendParams,
): Promise<SendResult> {
  const prepared = await prepareConfidentialSend(wallet, senderAddress, params)
  return prepared.submit(params.onProgress)
}

/**
 * Price and build a private send without sending it.
 *
 * The same two-phase shape as prepareReveal: scanning, selection, the dry run and the REAL build
 * all happen here, so the review screen shows the exact fee the transaction pays, and `submit`
 * sends the very envelope that was priced — no rebuild, no re-selection, no second fee.
 */
export async function prepareConfidentialSend(
  wallet: SecretKeyWallet,
  senderAddress: string,
  params: SendParams,
): Promise<PreparedConfidentialSend> {
  const { recipient, memo, payRef, onProgress, sendAll = false, feeFor = withFeeMargin, unsafeSkipConfirm = false } = params
  const log = (msg: string) => onProgress?.(msg)

  // Connect indexer first — lets ootle-secret-key-wallet __tla tick before wallet ops
  log('Connecting to indexer…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })

  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const viewSecret = await wallet.getViewSecret()
  // The fee leaves the statement as a revealed output, and since Ootle 0.42 that bucket is only
  // created for a receiver whose badge is in the auth scope: the sender's owner key, which signs
  // this transaction through `ootleWallet` below. (Not StaticSigner — its getPublicKey is zeros.)
  const ownerPk = await wallet.getPublicKey()

  log('Scanning for your UTXOs…')
  // EXCLUDING WHAT WE HAVE ALREADY SPENT. `/utxos` keeps listing a spent output until the indexer
  // catches up, and selecting one builds a transaction the chain can only reject ("Input substate
  // utxo_... is down") after taking its fee. See crypto/spentOutputs.
  // AND WHAT ANOTHER PREPARED TRANSACTION IS HOLDING — see crypto/coinReservations.
  const utxos = await scanOwnedUtxos(crypto, viewSecret, {
    excluded: loadSelectionExcludedIds(senderAddress),
    walletAddress: senderAddress,
  })
  if (utxos.length === 0) throw new Error('No owned UTXOs found. Your wallet may need a balance from the faucet.')

  // SELECTED ONCE, AGAINST THE CEILING, AND PINNED — the same discipline reveal.ts uses. The fee is
  // not known until the dry run, so selection is made against MAX_FEE and the SAME inputs are used
  // for the real build. Re-selecting at the measured fee would change the transaction's shape,
  // which would change its fee, which would change the selection: a loop with no fixed point.
  // Because the measured fee is below the ceiling, the pinned inputs still cover it and the surplus
  // simply comes back as a slightly larger change output.
  //
  // SEND ALL takes every output selection can reach instead, and has no change at all: the amount
  // is what is left of their total once the fee is paid.
  const selection = sendAll ? selectAllReachable(utxos) : selectStealthInputs(utxos, params.amountMicrotari + MAX_FEE)
  if (sendAll && selection.total <= MAX_FEE) {
    throw new Error(`Your private balance (${selection.total} µtTARI) is too small to cover a network fee.`)
  }
  log(`Spending ${describeMicrotari(selection.total)} TARI from ${selection.inputs.length} payment${selection.inputs.length === 1 ? '' : 's'} you’ve received`)

  const spentInputIds = selection.inputs.map(u => u.substateId)

  /** What the recipient gets at a given fee. Fixed for a typed amount; the remainder on send-all. */
  const amountAt = (feeMicrotari: bigint) => sendAll ? selection.total - feeMicrotari : params.amountMicrotari

  log('Building transaction…')
  // 0.39: mandatory validity window — read ONCE and reused by the pricing build and the real one,
  // so the transaction that is simulated is the transaction that is sent. See crypto/epoch.ts.
  const maxEpoch = await nextMaxEpoch(provider)

  // The fee is committed to by the outputs statement and signed over by the balance proof, so it
  // cannot be patched in afterwards — the whole build is a function OF the fee, run once to price
  // the transaction and once to send it. `recipientUtxoId` is read from the REAL build's statement:
  // the two builds use fresh output masks, so the probe's commitment names a UTXO that will never
  // exist and announcing it would point every payment message at nothing.
  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    const amountMicrotari = amountAt(feeMicrotari)
    const split = planStealthSend(amountMicrotari, feeMicrotari, selection.total)
    assertStealthSendSplit(split)

    const recipientOutput = createOutput({
      destination: recipient,
      amount: amountMicrotari,
      resourceAddress: TARI_RESOURCE_ADDRESS,
      ...(memo ? {
        memo: payRef
          ? { PayRefAndBytes: { pay_ref: payRef, message: memo } }
          : { Message: memo },
      } : {}),
    })

    // A zero-value change output would create a worthless UTXO, so exact cover emits none. The
    // recipient's output is always present, so the statement never has zero outputs.
    const { statement: outsStmt, outputMask } = await crypto.generateOutputsStatement(
      split.changeAmount > 0n
        ? [recipientOutput, createOutput({ destination: senderAddress, amount: split.changeAmount, resourceAddress: TARI_RESOURCE_ADDRESS })]
        : [recipientOutput],
      { amount: feeMicrotari, receiver: ownerPk },
    )

    // Recipient's output is specs[0]; read its on-wire Pedersen commitment from the outputs
    // statement and build the substate id in the same format scanUtxos/decryptOwnedUtxo use.
    // (Shape confirmed by the library's own wasm-crypto tests: outputs[i].output.commitment.)
    let recipientUtxoId: string | undefined
    try {
      const parsedOuts = outsStmt.parsed() as { outputs?: { output?: { commitment?: string } }[] }
      const commitmentHex = parsedOuts.outputs?.[0]?.output?.commitment
      if (commitmentHex) recipientUtxoId = `utxo_${RESOURCE_HEX}_${commitmentHex}`
    } catch { /* leave undefined — caller treats a missing id as "cannot announce this payment" */ }

    // OUR side of the same statement. specs[0] is the recipient's output, so everything after it
    // is change back to us — one entry when there is change, none on exact cover.
    const allOutputIds = readOutputSubstateIds(outsStmt)
    const selfOutputIds = allOutputIds === null ? undefined : allOutputIds.slice(1)

    // EVERY selected input, in one statement. Commitment order and mask order must match, which is
    // why both map over the same `selection.inputs` array.
    const insStmt = await crypto.buildInputsStatement(selection.inputs.map(u => new StealthInput(u.commitment)), 0n)
    const inputMask = await crypto.aggregateInputMasks(selection.inputs.map(u => u.mask))
    const proof   = await signBalanceProof(crypto, inputMask, outputMask, insStmt, outsStmt)
    const stmt    = new StealthTransferStatement(insStmt, outsStmt, proof)

    const builder = new TransactionBuilder(Network.Esmeralda, maxEpoch)
    builder.addFeeInstruction(
      stealthTransferInstruction(
        { resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: null, statement: stmt },
        () => ({ id: 0, offset: null }),
      ),
    )
    builder.addFeeInstruction({ PutLastInstructionOutputOnWorkspace: { key: 0 } })
    builder.addFeeInstruction({ PayFeeFromBucket: { bucket: { id: 0, offset: null } } })
    // Each spent output is declared so it is resolved and LOCKED alongside the others.
    for (const u of selection.inputs) {
      builder.addInput({ substate_id: stealthUtxoSubstateId(TARI_RESOURCE_ADDRESS, u.commitment), version: null })
    }

    const unsignedTx   = await resolveTransaction(provider, builder.buildUnsignedTransaction())
    const sealKP       = generateSealKeypair()
    const unsignedJson = serializeUnsignedTx(unsignedTx)
    // ONE SIGNATURE PER INPUT. Each stealth output is unlocked by a key derived from ITS sender's
    // public nonce, so the set must be complete — a missing one is a rejected transaction, not a
    // partial spend. signTransaction concatenates whatever each signer returns.
    const oneTimeSigs = []
    for (const u of selection.inputs) {
      oneTimeSigs.push(await wallet.addStealthSignature(unsignedJson, u.nonce, sealKP.public_key, { crypto }))
    }

    const ootleWallet = new OotleWallet()
      .registerKeyProvider(senderAddress, wallet)
      .setDefaultSigner(senderAddress)

    // `dry_run` must ride INSIDE the sealed envelope — the dry-run endpoint refuses anything else.
    const toSign  = dryRun ? { ...unsignedTx, dry_run: true } : unsignedTx
    const signed  = await signTransaction([ootleWallet, new StaticSigner(oneTimeSigs)], toSign, sealKP)
    return { envelope: sealTransaction(signed), split, recipientUtxoId, selfOutputIds }
  }

  log('Estimating network fee…')
  // Priced with (almost always) the ceiling reserved, which is also what the selection above set
  // aside — so a probe can never fail for want of funds the real send would have had. The "almost"
  // is what keeps the probe the same SHAPE as the real send; see probeFeeFor. On send-all the
  // probe reserves the full ceiling and, like the real send, has no change: one output either way.
  const reserved = sendAll ? MAX_FEE : probeFeeFor(selection.total, params.amountMicrotari)
  const probe = await buildEnvelope(reserved, true)
  const cost  = await dryRunFee(INDEXER_URL, probe.envelope, { onBusyRetry: () => log(RETRYING_MESSAGE) })
  const fee   = feeFor(cost)
  // AGAINST WHAT THE PROBE RESERVED, not the raw ceiling. Two things follow from that, and the
  // second is the one that matters: a fee above the reservation was never simulated, and — because
  // the probe reserves the LARGEST fee this transaction may pay — a real fee at or below it always
  // leaves at least as much change as the probe had. Since probeFeeFor guarantees the probe a
  // change output, the real build provably has one too, and the priced shape is the submitted shape.
  if (fee > reserved) {
    throw new Error(
      `Network fee (${fee} µtTARI) exceeds this wallet's ${MAX_FEE} µtTARI ceiling. ` +
      `Fees have risen — the ceiling in confidentialSend.ts needs raising.`,
    )
  }
  log(`Network fee: ${fee} µtTARI`)

  const real = await buildEnvelope(fee, false)
  const preparedAt = Date.now()
  const simulate = async (feeMicrotari: bigint = fee) =>
    simulateFee(INDEXER_URL, (await buildEnvelope(feeMicrotari, true)).envelope, { fee: feeMicrotari })
  const check = confirmer({ preparedAt, simulate: () => simulate(fee), inputs: { ids: spentInputIds } })

  // HELD FROM HERE until submitted, released, or expired — so nothing else selects these coins while
  // this payment sits on a review screen. Selection above already skipped every live hold, so a
  // clash means two prepares raced in the last few seconds; the first to reserve keeps the coins.
  const reservation = newReservationToken()
  if (!reserveCoins(senderAddress, spentInputIds, reservation)) {
    releaseCoins(senderAddress, reservation)
    throw new Error('Another payment being prepared is using some of these funds. Try again in a moment.')
  }

  return {
    feeMicrotari: fee,
    dryRunCost: cost,
    recipientAmount: real.split.recipientAmount,
    changeAmount: real.split.changeAmount,
    inputCount: selection.inputs.length,
    inputTotal: selection.total,
    spentInputIds,
    simulate,
    preparedAt,
    confirm: check.confirm,
    release: () => releaseCoins(senderAddress, reservation),
    submit: async (onSubmitProgress?: (msg: string) => void) => {
      const slog = (m: string) => onSubmitProgress?.(m)
      slog('Checking the fee…')
      if (!unsafeSkipConfirm) await check.ensureConfirmed()
      slog('Submitting transaction…')
      const sub = await submitOnce(() => provider.submitTransaction(real.envelope), {
        landed: inputsStillUnspent(spentInputIds),
        onBusyRetry: () => slog(RETRYING_MESSAGE),
      })
      const txId = sub.transaction_id as string
      slog('Submitted — waiting for the network to finalise it…')

      // ── THE SPEND RECORD, RESOLVED IN THE SAME FUNCTION THAT SUBMITS ─────────────
      //
      // Locking happens HERE rather than at the UI call site, and that is a correctness requirement
      // rather than a convenience. `markLocked` has to run between submitting and hearing back, and
      // this function does not return until it HAS heard back — so a call site could not lock in
      // that window even if it wanted to.
      //
      // The verdict mapping is the reference wallet's (crypto/spentOutputs, OutputStatus):
      //   Commit  → promoteToSpent   the locks become facts.
      //   Reject  → release          the inputs were never consumed; give them back. Note this covers
      //                              AcceptFeeRejectRest, where the fee committed and nothing moved —
      //                              txResult.ts folds that into `Reject`, and it is the right call
      //                              here: the coins are untouched.
      //   Timeout → LEAVE LOCKED     not a verdict. A timeout means nothing was legible — not that
      //                              the transaction failed — so unlocking on one would risk handing
      //                              a spent coin back to the next selection.
      markLocked(senderAddress, spentInputIds, txId)
      // The spend record holds them now; the review-time hold is done.
      releaseCoins(senderAddress, reservation)

      // TOLD, NOT ASKED — see crypto/finality.
      const { outcome, reason, body } = await awaitFinality(provider, txId)
      // The fee lives at Finalized.execution_result.finalize.fee_receipt. `total_fees_paid` is the
      // RESERVED amount — the overcharge is not refunded (see feeProbe's margin note) — so it is
      // the prepared fee, and the honest number to show.
      const feePaid = (body as {
        result?: { Finalized?: { execution_result?: { finalize?: { fee_receipt?: { total_fees_paid?: number | string } } } } }
      } | null)?.result?.Finalized?.execution_result?.finalize?.fee_receipt?.total_fees_paid
      const feeMicrotari = feePaid != null ? BigInt(feePaid) : undefined
      provider.stopWatcher?.()

      if (outcome === 'Commit') promoteToSpent(senderAddress, txId)
      else if (outcome === 'Reject') release(senderAddress, txId)

      return { txId, outcome, reason, recipientUtxoId: real.recipientUtxoId, feeMicrotari, selfOutputIds: real.selfOutputIds, spentInputIds }
    },
  }
}

/**
 * Every output selection can reach in one transaction — the largest MAX_STEALTH_INPUTS — for
 * "send all". The same set reachableTotal sums, so MAX and the build agree on what "all" is.
 */
export function selectAllReachable<T extends { value: bigint }>(utxos: T[]): { inputs: T[]; total: bigint } {
  const inputs = utxos
    .filter(u => u.value > 0n)
    .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))
    .slice(0, MAX_STEALTH_INPUTS)
  if (inputs.length === 0) throw new Error('No private funds found. This wallet holds no spendable outputs.')
  return { inputs, total: inputs.reduce((sum, u) => sum + u.value, 0n) }
}

// ── The fund-critical arithmetic, isolated so it can be tested ────────────────

export interface StealthSendSplit {
  /** What the recipient receives. Caller-chosen; never adjusted behind their back. */
  recipientAmount: bigint
  /** Paid to the network. */
  feeMicrotari: bigint
  /** Sum of the outputs being spent. */
  inputTotal: bigint
  /** Back to the sender: `inputTotal − amount − fee`. Zero means exact cover. */
  changeAmount: bigint
}

/**
 * Split a send across the selected inputs.
 *
 * THE ONLY THING THAT CHECKS THIS IS THE BALANCE PROOF. The engine cannot see the input values —
 * they are hidden in commitments and carried by masks — so it verifies the proof instead. A change
 * amount one microtari too small does not fail loudly; it produces a proof over a different
 * equation and the transaction is rejected with no hint about where the value went. Too LARGE
 * cannot be proved at all. Across many inputs there are more ways to get the sum wrong, which is
 * exactly why the arithmetic is in one function with an assertion rather than inline.
 */
export function planStealthSend(amountMicrotari: bigint, feeMicrotari: bigint, inputTotal: bigint): StealthSendSplit {
  if (amountMicrotari <= 0n) throw new Error('Amount must be greater than zero.')
  if (feeMicrotari <= 0n) throw new Error('Fee must be greater than zero.')
  const needed = amountMicrotari + feeMicrotari
  if (inputTotal < needed) {
    throw new Error(
      `The selected private funds (${inputTotal} µtTARI) do not cover the amount plus the network fee ` +
      `(${amountMicrotari} + ${feeMicrotari} = ${needed} µtTARI).`,
    )
  }
  return { recipientAmount: amountMicrotari, feeMicrotari, inputTotal, changeAmount: inputTotal - needed }
}

/**
 * Re-check the split immediately before it is used to build a transaction.
 *
 * Redundant by construction today — planStealthSend cannot produce a split that fails this. That is
 * the point: it is a tripwire for a future edit that computes the change separately from the inputs
 * and the amount.
 */
export function assertStealthSendSplit(split: StealthSendSplit): void {
  const { recipientAmount, feeMicrotari, inputTotal, changeAmount } = split
  if (recipientAmount <= 0n || feeMicrotari <= 0n) {
    throw new Error(`stealthSend: non-positive component (amount ${recipientAmount}, fee ${feeMicrotari})`)
  }
  if (changeAmount < 0n) {
    throw new Error(`stealthSend: negative change (${changeAmount}) — inputs ${inputTotal} do not cover the spend`)
  }
  // inputs − outputs − change − fee = 0, stated the way the balance proof needs it.
  if (recipientAmount + feeMicrotari + changeAmount !== inputTotal) {
    throw new Error(
      `stealthSend: value would be lost — amount ${recipientAmount} + fee ${feeMicrotari} + change ${changeAmount} !== inputs ${inputTotal}`,
    )
  }
}

/**
 * Smallest change the PROBE is allowed to leave, so it always carries a change output.
 *
 * One microtari is enough: the probe is discarded and only its COST is used, so the value is
 * irrelevant — the output merely has to EXIST.
 */
const PROBE_MIN_CHANGE = 1n

/**
 * The fee the PRICING build reserves.
 *
 * ── WHY THIS IS NOT SIMPLY THE CEILING ───────────────────────────────────────
 *
 * The probe must be STRUCTURALLY IDENTICAL to the transaction that gets submitted — same inputs,
 * and the same number of OUTPUTS. Outputs are what a transfer pays for: PER_OUTPUT is 6 000 000
 * metering points against PER_INPUT's 42 000, about 143×. A probe with one output fewer than the
 * real send understates the fee by roughly 6 300 µtTARI, which the 25% margin cannot absorb.
 *
 * That is not hypothetical. Reserving the full ceiling makes the probe's change exactly zero at
 * MAX — because MAX is defined as `reachable − MAX_FEE`, so `inputTotal − amount − MAX_FEE = 0` —
 * and a zero change emits no change output. The real send, whose measured fee is far below the
 * ceiling, then has real change and two outputs. Measured on Esmeralda: a 14-input send priced
 * 12 025 as one output and cost 18 332 as two, and the transaction was rejected with
 * "Required fees 16546 but 14791 paid".
 *
 * ── WHY LOWERING THE PROBE FEE IS SOUND ──────────────────────────────────────
 *
 * The probe reserves the LARGEST fee the transaction can pay, so the probe's change is the
 * SMALLEST change the real build can have. Guaranteeing the probe at least one microtari of change
 * therefore guarantees the real build has change too, and the two shapes match. The probe's
 * reserved fee only has to be generous enough for the simulation to complete, and one microtari
 * below the ceiling is still ~2× every fee measured on this network.
 */
export function probeFeeFor(inputTotal: bigint, amountMicrotari: bigint, ceiling: bigint = MAX_FEE): bigint {
  const headroom = inputTotal - amountMicrotari
  return headroom - ceiling >= PROBE_MIN_CHANGE ? ceiling : headroom - PROBE_MIN_CHANGE
}

/**
 * The largest TYPED amount a confidential send can carry, given the outputs the wallet holds.
 *
 * A typed amount is priced with the full MAX_FEE ceiling reserved on top of it, so this is the
 * reachable total (the largest MAX_STEALTH_INPUTS outputs — not the balance) minus that ceiling.
 * MAX itself no longer uses it: MAX is `sendAll`, which spends the same reachable set and sends
 * its total minus the EXACT fee, so nothing is held back for a ceiling that is never paid.
 *
 * Returns 0n when no output can carry a payment at all — treat that as "nothing sendable".
 */
export function maxStealthSend(outputValues: readonly bigint[]): bigint {
  const reachable = reachableTotal(outputValues)
  return reachable > MAX_FEE ? reachable - MAX_FEE : 0n
}

/**
 * µtTARI → a TARI decimal, for the progress log the user actually reads.
 *
 * BIGINT ONLY. The old line did `Number(total) / Number(MICROTARI_PER_TARI)`, which is the one
 * thing this codebase does not do with an amount: past 2^53 µtTARI the division silently rounds,
 * and the number it rounds is the size of the spend being reported. It was "only a log line", but
 * the whole rail exists because that argument is how the first wrong amount always gets in.
 *
 * String arithmetic, no float anywhere: whole part, then six padded fractional digits.
 */
export function describeMicrotari(microtari: bigint): string {
  const whole = microtari / MICROTARI_PER_TARI
  const frac = (microtari % MICROTARI_PER_TARI).toString().padStart(6, '0')
  return `${whole}.${frac}`
}

export function tariToMicrotari(tari: number): bigint {
  return BigInt(Math.round(tari * Number(MICROTARI_PER_TARI)))
}
