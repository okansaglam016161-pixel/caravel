// REVEAL — move stealth (private) TARI into the account's revealed (public) balance. M3.
//
// THE IRREVERSIBLE DIRECTION. A conceal can be undone by revealing again; a reveal cannot be undone
// at all. The amount lands as a plain integer in a vault owned by a component whose address is
// derived from this wallet's public key, and it stays world-readable in the chain's history forever
// — including for anyone who later learns which account is yours. So the number the user typed is
// the number that gets published, exactly, and every guard in this file exists to keep it that way.
//
// ── VERIFIED ON-CHAIN ─────────────────────────────────────────────────────────
//
// Proven architecture: tx 723d6720fb6225a3b7910c9076fb1026f591e910b098ab1fc8587f88a0623481,
// committed on Esmeralda 2026-08-25. A 1 TARI reveal, reconciling to the microtari — both
// invariants below, checked against the network's own record rather than against this file:
//
//   revealed_output_amount   1_014_537  =  1_000_000 amount + 14_537 fee          [invariant 1]
//   3_985_544 input − 1_014_537 revealed − 2_971_007 change  =  0                 [invariant 2]
//
// The vault went DOWN at v3 and UP at v4 — not up at v0 — which is the proof that CreateAccount
// REUSED the declared account rather than minting a fresh one. That failure is silent (the deposit
// would land in a component thrown away at the end of the transaction), so it is worth naming the
// evidence that rules it out.
//
// The 2_971_007 change output trial-decrypts with this wallet's view key, and a dry run SPENDING it
// was accepted by the network — so its recovered mask produces a valid balance proof and its nonce
// a valid one-time spend signature. The change is not stranded.
//
// The input's value is the one figure not directly readable: the spent substate is pruned. It
// follows from the two verified figures, and from the engine having verified the balance proof —
// which IS the check that inputs = outputs + change, and is the only thing that checks it.
//
// FEE OVERCHARGE IS NOT REFUNDED, as on the send path. The receipt reported total_fees_paid 14_537
// against total_fee_overcharge 4_596 (actual consumption 9_941), and there was no refund among the
// up-substates — the vault rose by exactly 1_000_000. The reserved fee is what the wallet pays, and
// what the UI must therefore show.
//
// ── WHY REVEAL IS STRUCTURALLY BIGGER THAN CONCEAL ────────────────────────────
//
// Conceal is faucet-claim-minus-one-instruction: withdraw revealed funds, hand the bucket to a
// StealthTransfer, pay the fee out of the same bucket. The stealth side is an OUTPUT, so there are
// no inputs to select and no change to compute.
//
// Reveal inverts every one of those. The stealth side is now the INPUT, so:
//
//   * real inputs — the transfer spends actual UTXOs, so the statement carries real commitments and
//     the balance proof is signed with the REAL aggregated input mask, not Mask.zero() (conceal has
//     no confidential inputs at all, which is why it can use a zero mask);
//   * one-time authorization — each spent UTXO needs its own spend-key signature, derived against
//     that output's public nonce;
//   * CHANGE — inputs almost never sum to exactly what is being revealed, so the remainder has to
//     come back as a fresh stealth output. This is the fund-critical path: value that is not sent
//     to an output and not paid as a fee is simply gone;
//   * and the revealed output is BIGGER than the fee, so the surplus has to be put somewhere. The
//     StealthTransfer emits one revealed bucket worth `amount + fee`; PayFeeFromBucket would burn
//     the whole thing. It has to be SPLIT, which is what makes this milestone need two instructions
//     nothing in Caravel has used before:
//
//     createAccount(ownerPk)                            → 'account'   [idempotent — reuses existing]
//     StealthTransfer { revealedInputBucket: null, … }  → 'bucket'    revealed = amount + fee
//     TakeFromBucket(bucket, TARI, amount)              → 'to_deposit'
//     callMethod(account, 'deposit', ['to_deposit'])    → amount lands revealed in the vault
//     PayFeeFromBucket { bucket }                       → the remaining `fee` pays for the tx
//
// ── THE INVARIANTS THAT MATTER ────────────────────────────────────────────────
//
// There are two here, where conceal had one, and they are checked by different things:
//
//   1. amount + fee === revealedOutput
//      Checked by the ENGINE, through the bucket. The StealthTransfer's revealed output amount is
//      what lands in 'bucket'; TakeFromBucket then removes exactly `amount` and PayFeeFromBucket
//      consumes what is left. If `revealedOutput` were computed anywhere other than as
//      `amount + fee`, the leftover would not be the fee and the transaction fails — or worse,
//      succeeds while paying a fee that is not the fee that was quoted.
//
//   2. inputTotal === revealedOutput + changeAmount   (inputs − outputs − change = 0)
//      Checked by the BALANCE PROOF, and by nothing else. The engine cannot see the input values —
//      they are hidden in commitments and carried by masks — so it verifies the proof instead. A
//      change amount computed one µtTARI too small does not fail loudly; it produces a proof over a
//      different equation, and the transaction is rejected with no hint about where the value went.
//      A change amount computed too LARGE cannot even be proved. There is no tolerance and no
//      second opinion: this arithmetic is the only thing standing between the user and lost funds.
//
// planReveal computes both ONCE, from one set of inputs, and assertRevealSplit re-checks them
// immediately before the transaction is built — so a future edit that re-derives any of these
// numbers separately trips an assertion here rather than an opaque rejection on-chain.

import {
  Network,
  OotleWallet,
  StealthInput,
  StealthTransferStatement,
  TARI_RESOURCE_ADDRESS,
  TransactionBuilder,
  WasmStealthCrypto,
  createOutput,
  generateSealKeypair,
  microTariString,
  resolveTransaction,
  sealTransaction,
  serializeUnsignedTx,
  signBalanceProof,
  signTransaction,
  stealthTransferInstruction,
  stealthUtxoSubstateId,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { extractAccountAddress } from './accountAddress'
import { loadAccountAddress, saveAccountAddress } from './accountStore'
import { resolveAccountInputs } from './substates'
import { nextMaxEpoch } from './epoch'
import { dryRunFee, withFeeMargin } from './feeProbe'
import { readOutputSubstateIds } from './outputIds'
import { probeFeeFor } from './confidentialSend'
import {
  StaticSigner, reachableTotal, scanOwnedUtxos, selectStealthInputs, type OwnedUtxo,
} from './stealthUtxos'
import { awaitFinality } from './finality'
import { loadExcludedIds, markLocked, promoteToSpent, release } from './spentOutputs'
import { INDEXER_URL } from './indexerConfig'


/**
 * Fee reserved while PRICING a reveal, and the amount MAX holds back (µtTARI).
 *
 * Unlike conceal — where the probe is carved out of the amount being moved — a reveal pays its fee
 * out of the STEALTH INPUTS, so this is what the input selection must cover on top of the amount.
 * It is deliberately far above every fee measured on this network (~13–20k), because the probe has
 * to be generous enough for the simulation to run to completion: an under-funded probe aborts
 * before the network has priced the whole transaction and reports a cost far below the truth.
 *
 * It doubles as MAX's reserve — see maxRevealable. Whatever the probe does not consume comes back
 * as stealth change, so over-reserving costs nothing but a slightly larger change output.
 */
export const REVEAL_FEE_RESERVE = 50_000n

/**
 * Stealth change MAX deliberately leaves behind (µtTARI, 0.001 TARI).
 *
 * MAX would otherwise select inputs summing to exactly `amount + reserve`, and the PRICING build —
 * which reserves the full probe — would then have zero change and therefore NO stealth output at
 * all. That case is representable (the crypto layer produces `outputs: []` with a zero output mask,
 * and the balance equation still holds), but the SDK's own high-level builder refuses to construct
 * it, which is a strong hint that the engine path is not well travelled. Reveal is irreversible and
 * this is not the milestone to find out on a user's funds.
 *
 * So MAX holds back one more crumb than the probe needs, and every build on the MAX path — pricing
 * and real — carries a genuine stealth change output. The cost is that "reveal everything" leaves
 * ~0.051 TARI private rather than zero. Nothing is lost; it stays spendable, and the UI says so.
 */
export const MIN_STEALTH_CHANGE = 1_000n

/**
 * Smallest amount that may be revealed (µtTARI, 0.1 TARI).
 *
 * HONESTLY LABELLED: unlike MIN_CONCEAL_MICROTARI this is NOT structural. Conceal's floor exists
 * because its probe is carved out of the amount, so a smaller amount cannot be simulated at all.
 * Reveal's fee comes from the inputs, so a 1 µtTARI reveal would simulate fine.
 *
 * It is a judgement instead, and it is kept identical to conceal's so that both directions of the
 * same "Move funds" control behave the same way. Revealing less than the fee it costs is a bad
 * trade the user cannot undo, and a floor is a clearer way to say so than a warning they will click
 * past.
 */
export const MIN_REVEAL_MICROTARI = 100_000n

export type RevealOutcome = 'Commit' | 'Reject' | 'Timeout'

export interface RevealResult {
  txId: string
  outcome: RevealOutcome
  /**
   * What the network said when it refused, verbatim inside a sentence — see crypto/txResult.
   *
   * Present on `Reject` and absent on `Commit`/`Timeout`. It is the only account anyone gets of why
   * a transaction failed, so it is carried out of the poll rather than logged and dropped: a fee
   * taken for nothing, or a rejection, is exactly the moment a user deserves the real reason.
   */
  reason?: string
  /** What was made public (µtTARI) — exactly the amount asked for. */
  revealedAmount: bigint
  /** Fee reserved for this transaction (µtTARI), paid out of the stealth inputs. */
  feeMicrotari: bigint
  /** Stealth change returned to the wallet (µtTARI). */
  changeAmount: bigint
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
  /**
   * Substate ids of the stealth outputs this reveal CONSUMED.
   *
   * Same field and same reason as the send path's — see confidentialSend. A reveal spends real
   * stealth inputs, so it has exactly the same obligation to record them.
   */
  spentInputIds: string[]
  /** Account address read from the committed result — the free capture for pre-M1 wallets. */
  accountAddress?: string
}

export interface RevealParams {
  /**
   * µtTARI to make PUBLIC. Defined as what LANDS, not what is spent — the opposite of conceal, and
   * deliberately so: this number is published permanently, so it must be the number the user chose,
   * with the fee taken from elsewhere (the stealth inputs) rather than silently out of it.
   */
  amountMicrotari: bigint
  onProgress?: (msg: string) => void
}

// ── The fund-critical arithmetic, isolated so it can be tested ────────────────

export interface RevealSplit {
  /** Lands revealed in the vault. Caller-chosen and PUBLISHED — never adjusted behind their back. */
  amount: bigint
  /** Paid to the network, from the same revealed bucket. */
  feeMicrotari: bigint
  /** The StealthTransfer's revealed output: `amount + fee`. ONE derivation, threaded everywhere. */
  revealedOutput: bigint
  /** Sum of the stealth inputs being spent. */
  inputTotal: bigint
  /** Stealth output back to the wallet: `inputTotal − revealedOutput`. Zero means exact cover. */
  changeAmount: bigint
}

/**
 * Split a reveal into its revealed output, its fee and its stealth change.
 *
 * THE ASYMMETRY WITH planConceal, which is the whole point of this function: conceal carves the fee
 * OUT of the amount (`stealth = amount − fee`), because there the amount is what leaves the vault.
 * Reveal adds the fee ON TOP (`revealedOutput = amount + fee`), because here the amount is what
 * arrives — and what arrives is what the chain publishes. Getting these two the same way round
 * would publish a number the user never chose.
 *
 * Throws rather than returning a degenerate split: a reveal whose inputs cannot cover
 * `amount + fee` has no valid balance equation, and one with a negative change is not a
 * transaction at all.
 */
export function planReveal(amountMicrotari: bigint, feeMicrotari: bigint, inputTotal: bigint): RevealSplit {
  if (amountMicrotari <= 0n) throw new Error('Amount must be greater than zero.')
  if (feeMicrotari <= 0n) throw new Error('Fee must be greater than zero.')

  const revealedOutput = amountMicrotari + feeMicrotari
  if (inputTotal < revealedOutput) {
    throw new Error(
      `The selected private funds (${inputTotal} µtTARI) do not cover the amount plus the network fee ` +
      `(${amountMicrotari} + ${feeMicrotari} = ${revealedOutput} µtTARI).`,
    )
  }

  return {
    amount: amountMicrotari,
    feeMicrotari,
    revealedOutput,
    inputTotal,
    changeAmount: inputTotal - revealedOutput,
  }
}

/**
 * Re-check both invariants immediately before the split is used to build a transaction.
 *
 * Redundant by construction today — planReveal cannot produce a split that fails this. That is the
 * point: it is a tripwire for a future edit that computes the revealed output, or the change,
 * separately from the amount and the fee. Failing here is a caught bug. Failing on-chain is, for
 * invariant 1, a rejection; for invariant 2, an unprovable balance equation whose error message
 * says nothing about the value that went missing.
 */
export function assertRevealSplit(split: RevealSplit): void {
  const { amount, feeMicrotari, revealedOutput, inputTotal, changeAmount } = split

  if (amount <= 0n || feeMicrotari <= 0n || revealedOutput <= 0n) {
    throw new Error(`reveal: non-positive component in split (amount ${amount}, fee ${feeMicrotari}, revealed ${revealedOutput})`)
  }
  // Change MAY be zero — exact cover is legal — but never negative.
  if (changeAmount < 0n) {
    throw new Error(`reveal: negative change (${changeAmount}) — inputs ${inputTotal} do not cover revealed output ${revealedOutput}`)
  }
  // Invariant 1 — what the engine checks through the bucket.
  if (amount + feeMicrotari !== revealedOutput) {
    throw new Error(`reveal: revealed output does not balance — amount ${amount} + fee ${feeMicrotari} !== revealed ${revealedOutput}`)
  }
  // Invariant 2 — what ONLY the balance proof checks. inputs − outputs − change = 0.
  if (revealedOutput + changeAmount !== inputTotal) {
    throw new Error(`reveal: value would be lost — revealed ${revealedOutput} + change ${changeAmount} !== inputs ${inputTotal}`)
  }
}

/**
 * The largest amount MAX may offer, given the OUTPUTS the wallet actually holds.
 *
 * TAKES THE OUTPUTS, NOT THE TOTAL. A transfer can spend at most MAX_STEALTH_INPUTS of them, so on
 * a wallet fragmented past that cap the balance is not reachable in one transaction — and offering
 * it anyway is the "available-then-broken" failure the M4 report ruled unacceptable. For any wallet
 * within the cap (which is nearly all of them, at 64) this is simply the whole balance.
 *
 * Reserves the fee probe AND MIN_STEALTH_CHANGE, so the priced build and the real one both carry a
 * stealth change output. Returns 0n when nothing is reachable — treat that as "MAX unavailable",
 * never as an amount. EXACT BIGINT: this feeds an amount field whose value is published permanently.
 */
export function maxRevealable(outputValues: readonly bigint[]): bigint {
  const reachable = reachableTotal(outputValues)
  const reserve = REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE
  return reachable > reserve ? reachable - reserve : 0n
}

// ── Transaction ───────────────────────────────────────────────────────────────

// Workspace slots, in the order the fee-instruction builder allocates them. The builder hands out
// ids sequentially from 0 and has no public way to ask for the next one, so `to_deposit` — whose id
// TakeFromBucket must carry as a raw number — is written out explicitly and the two NAMED slots are
// asserted against their expected ids at build time. If a future SDK changes the allocation order,
// that assertion fires here instead of the transaction silently depositing the wrong bucket.
export const WS_ACCOUNT = 0
export const WS_BUCKET = 1
export const WS_TO_DEPOSIT = 2

/**
 * The workspace slots the fee-instruction builder must hand out, in order.
 *
 * EXPORTED SO IT CAN BE TESTED. The guard below is fund-critical — depositing the wrong bucket
 * sends the surplus somewhere it cannot be recovered from — and until M9 it was asserted at runtime
 * and verified by nothing, which is the same profile as the probe-shape bug: a claim stated
 * confidently, believed, and never checked. `assertWorkspaceLayout` is that guard, lifted out so a
 * test can pin the three ids without needing a live builder.
 */
export function assertWorkspaceLayout(accountSlotId: number, bucketSlotId: number): void {
  if (accountSlotId !== WS_ACCOUNT || bucketSlotId !== WS_BUCKET) {
    throw new Error(
      `reveal: unexpected workspace layout (account ${accountSlotId}, bucket ${bucketSlotId}) — ` +
      `the TakeFromBucket output slot ${WS_TO_DEPOSIT} can no longer be assumed free.`,
    )
  }
}

/**
 * The instruction recipe, lifted out so the pricing build and the real build are provably the same
 * transaction shape and can only differ in the fee threaded through them — the same discipline
 * conceal.ts and faucet.ts use, for the same reason.
 *
 * `split.amount` appears exactly once, in TakeFromBucket; `split.revealedOutput` appears only in the
 * statement the caller passes in. Neither is recomputed here.
 */
function buildReveal(
  maxEpoch: number,
  ownerPkHex: string,
  split: RevealSplit,
  statement: StealthTransferStatement,
  declaredInputs: string[],
  stealthInputs: OwnedUtxo[],
) {
  return new TransactionBuilder(Network.Esmeralda, maxEpoch)
    .withFeeInstructionsBuilder((b) => {
      // Create-or-reuse: the engine derives the address from the owner key and returns the existing
      // component if there is one, so this is safe to issue on every reveal — and it is what makes
      // a reveal possible at all for a wallet that has never held a revealed balance.
      b.createAccount(ownerPkHex).saveVar('account')

      // The transfer itself. `revealedInputBucket: null` — nothing revealed goes IN; the revealed
      // side is entirely an output, worth `amount + fee`, which lands in the bucket saved below.
      b.addInstruction(
        stealthTransferInstruction(
          { resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: null, statement },
          (name) => b.resolveWorkspaceOffsetId(name),
        ),
      ).saveVar('bucket')

      // Guard the hand-written workspace id below against a change in the builder's allocation
      // order. Cheap, and the failure it prevents is a deposit of the wrong bucket.
      const accountSlot = b.resolveWorkspaceOffsetId('account')
      const bucketSlot = b.resolveWorkspaceOffsetId('bucket')
      assertWorkspaceLayout(accountSlot.id, bucketSlot.id)

      // ── THE SPLIT ──
      // The bucket holds `amount + fee`. Take exactly the amount out into its own bucket; whatever
      // is left in 'bucket' is, by invariant 1, exactly the fee.
      //
      // The amount is encoded as a decimal STRING rather than left to the serializer's bigint
      // handling: `Amount` is 128-bit on the wire and this is the one number in the transaction the
      // chain publishes, so its encoding is made explicit rather than incidental.
      b.addInstruction({
        TakeFromBucket: {
          input_bucket: bucketSlot,
          amount: microTariString(split.amount),
          output_bucket: WS_TO_DEPOSIT,
        },
      })

      // The surplus goes into the account's TARI vault, where it is a plain readable integer.
      // The bucket is referenced by its resolved slot directly — TakeFromBucket allocates a raw
      // numeric workspace id rather than a named one, so there is no name for `{ Workspace: 'x' }`
      // to resolve. `NamedArg` accepts a fully-formed WorkspaceOffsetId for exactly this case.
      b.callMethod({ fromWorkspace: 'account', methodName: 'deposit' }, [
        { Workspace: { id: WS_TO_DEPOSIT, offset: null } },
      ])

      // And the remainder — the fee — pays for the transaction.
      b.addInstruction({ PayFeeFromBucket: { bucket: bucketSlot } })

      return b
    })
    // ── THE INPUTS ARE NOT OPTIONAL ──
    //
    // `CreateAccount` only REUSES an existing account when that component is declared as an input.
    // Without it the engine loads nothing, mints a fresh empty account in the working state, and the
    // deposit lands in a component that is thrown away — the reveal would appear to succeed and the
    // balance would never move. Declaring the component means its vaults must be declared too, or
    // the deposit fails with "SubstateNotFound". (ce04b60's lesson, and it bites harder here: a
    // conceal that mis-declares fails loudly on withdraw, a reveal quietly deposits into nowhere.)
    //
    // Each stealth UTXO being spent is declared as well, so it is resolved and LOCKED alongside —
    // the same declaration the send path makes for its single input.
    .withInputs([
      ...declaredInputs.map(substate_id => ({ substate_id, version: null })),
      ...stealthInputs.map(u => ({
        substate_id: stealthUtxoSubstateId(TARI_RESOURCE_ADDRESS, u.commitment),
        version: null,
      })),
    ])
}


/**
 * A priced, built, signed reveal — everything except pressing send.
 *
 * Two-phase for the same reason conceal is: the fee a user approves must be the fee the transaction
 * pays. It matters more here. A separate "quote" call would price one transaction and submit
 * another, and on this path the difference between them is the difference between the amount the
 * user saw and the amount the chain publishes.
 */
export interface PreparedReveal {
  /** Measured fee including margin (µtTARI) — what the review screen shows and the tx pays. */
  feeMicrotari: bigint
  /** What will be published: exactly the amount asked for. */
  revealedAmount: bigint
  /** Total revealed output — `amount + fee` — which the bucket must hold. */
  revealedOutput: bigint
  /** Stealth change coming back to the wallet. */
  changeAmount: bigint
  /** How many stealth outputs are being spent. Shown so the user can see what is being consumed. */
  inputCount: number
  /** Total value of the stealth inputs being spent. */
  inputTotal: bigint
  /** Send it. Resolves once the transaction has a final on-chain decision. */
  submit: (onProgress?: (msg: string) => void) => Promise<RevealResult>
}

/**
 * Price and build a reveal without sending it.
 *
 * Does all the network work that can fail for boring reasons — connecting, scanning for spendable
 * outputs, resolving the account's vaults, reading the epoch, the dry run — so the review screen can
 * show a real fee and the confirm step is nothing but a submission.
 */
export async function prepareReveal(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  { amountMicrotari, onProgress }: RevealParams,
): Promise<PreparedReveal> {
  const log = (m: string) => onProgress?.(m)

  if (amountMicrotari < MIN_REVEAL_MICROTARI) {
    throw new Error(`The smallest amount that can be made public is ${MIN_REVEAL_MICROTARI} µtTARI (0.10 TARI).`)
  }

  // The account address is a HARD PREREQUISITE. A reveal has to deposit into a specific account
  // component, and it has to declare that component as an input for CreateAccount to reuse it —
  // without the address there is nothing to declare and the deposit would land in a throwaway
  // account. Recovery (accountRecovery.ts) runs on unlock and is free, so reaching here without one
  // means the probe could not answer: a network problem, reported as one.
  const accountAddress = loadAccountAddress(ownerAddress)
  if (!accountAddress) {
    throw new Error('This wallet’s account could not be identified, so funds cannot be made public. Check your connection and try again.')
  }

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const ownerPkHex = toHexStr(await wallet.getPublicKey())
  const viewSecret = await wallet.getViewSecret()

  log('Finding your private funds…')
  // EXCLUDING WHAT WE HAVE ALREADY SPENT — see the same note in confidentialSend, and
  // crypto/spentOutputs. A reveal selects from the identical set, so it inherits the identical bug
  // if it does not exclude.
  const utxos = await scanOwnedUtxos(crypto, viewSecret, {
    excluded: loadExcludedIds(ownerAddress),
    walletAddress: ownerAddress,
  })

  // SELECTED ONCE, AGAINST THE RESERVE, AND PINNED. The fee is not known until the dry run, and the
  // dry run needs a transaction — so the selection is made against the generous reserve and the
  // SAME inputs are used for the real build. Re-selecting at the measured fee would change the
  // transaction's shape, which would change its fee, which would change the selection: a loop with
  // no fixed point, and a priced transaction that is not the one submitted. Because the measured
  // fee is smaller than the reserve, the pinned inputs still cover it — the surplus simply comes
  // back as a slightly larger change output. The guard below re-checks that rather than assuming it.
  const selection = selectStealthInputs(utxos, amountMicrotari + REVEAL_FEE_RESERVE)

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

  // Read ONCE and reused for the dry run and the real submission, exactly as conceal does: the two
  // are seconds apart in a ~10-epoch window, so re-reading buys nothing and letting them differ
  // would mean simulating a transaction that is not the one submitted.
  const maxEpoch = await nextMaxEpoch(provider)

  // The whole build is a function OF the fee — the outputs statement commits to the revealed amount
  // (which includes the fee) and the balance proof signs over both sides — so it runs once to price
  // and once to send.
  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    const split = planReveal(amountMicrotari, feeMicrotari, selection.total)
    assertRevealSplit(split)

    // THE CHANGE OUTPUT. Everything the inputs are worth beyond `amount + fee` must come back, or
    // it is destroyed. `split.changeAmount` is the only place that number exists.
    const outputs = split.changeAmount > 0n
      ? [createOutput({ destination: ownerAddress, amount: split.changeAmount, resourceAddress: TARI_RESOURCE_ADDRESS })]
      : []

    // THE SINGLE VALUE. `split.revealedOutput` is the statement's revealed output here, and the
    // bucket the instructions split below; there is no second computation of it anywhere.
    const { statement: outsStmt, outputMask } = await crypto.generateOutputsStatement(outputs, split.revealedOutput)

    // REAL stealth inputs — commitments of UTXOs actually being spent — and 0n revealed input,
    // because nothing revealed goes into a reveal. (Conceal is the mirror image: no stealth inputs,
    // a revealed input equal to the withdraw.)
    const insStmt = await crypto.buildInputsStatement(selection.inputs.map(u => new StealthInput(u.commitment)), 0n)

    // REAL aggregated input mask, NOT Mask.zero(). The engine cannot see the input values; the
    // proof over these masks is what establishes inputs − outputs − change = 0. Order must match
    // the commitment order above, which is why both map over `selection.inputs`.
    const inputMask = await crypto.aggregateInputMasks(selection.inputs.map(u => u.mask))

    const proof = await signBalanceProof(crypto, inputMask, outputMask, insStmt, outsStmt)
    const stmt = new StealthTransferStatement(insStmt, outsStmt, proof)

    const builder = buildReveal(maxEpoch, ownerPkHex, split, stmt, declaredInputs, selection.inputs)
    const unsignedTx = await resolveTransaction(provider, builder.buildUnsignedTransaction())

    // ONE-TIME SPEND AUTHORIZATION, one per input. Each stealth output is unlocked by a key derived
    // from ITS sender's public nonce, so a multi-input spend needs one signature per input; they are
    // handed to signTransaction together, which concatenates every signer's output.
    //
    // The signatures hash over the NON-dry-run serialization in both cases, exactly as the proven
    // send path does — `dry_run` rides inside the sealed envelope, added at signing time below.
    const sealKP = generateSealKeypair()
    const unsignedJson = serializeUnsignedTx(unsignedTx)
    const oneTimeSigs = []
    for (const u of selection.inputs) {
      oneTimeSigs.push(await wallet.addStealthSignature(unsignedJson, u.nonce, sealKP.public_key, { crypto }))
    }

    const ootleWallet = new OotleWallet()
      .registerKeyProvider(ownerAddress, wallet)
      .setDefaultSigner(ownerAddress)

    const toSign = dryRun ? { ...unsignedTx, dry_run: true } : unsignedTx
    const signed = await signTransaction([ootleWallet, new StaticSigner(oneTimeSigs)], toSign, sealKP)
    return { envelope: sealTransaction(signed), split, selfOutputIds: readOutputSubstateIds(outsStmt) ?? undefined }
  }

  log('Estimating network fee…')
  // SAME SHAPE AS THE REAL BUILD. Reserving the full probe fee can leave zero change, and a reveal
  // with zero change emits NO stealth output at all — a structurally different (and cheaper)
  // transaction than the one submitted. Outputs dominate the fee (PER_OUTPUT 6 000 000 points vs
  // PER_INPUT 42 000), so pricing one fewer understates it badly enough to be rejected for
  // underpayment. MIN_STEALTH_CHANGE happens to keep MAX's probe change positive today, which is
  // luck rather than design — probeFeeFor makes it structural.
  const probe = await buildEnvelope(probeFeeFor(selection.total, amountMicrotari, REVEAL_FEE_RESERVE), true)
  const cost = await dryRunFee(INDEXER_URL, probe.envelope)
  const fee = withFeeMargin(cost)

  // ── THE PROBE→REAL FEE GUARD ──
  //
  // A fee above what the probe RESERVED was never simulated, and on this path the consequence is
  // structural rather than merely unpriced: the probe reserves the largest fee the transaction can
  // pay, so its change is the smallest the real build can have. Let the real fee exceed it and the
  // real change can fall to zero — which here emits NO stealth output at all, a different (and
  // cheaper) transaction than the one that was priced. That is the same failure that rejected a MAX
  // send, one step worse. Every builder in this codebase now refuses it in the same place.
  const reserved = probeFeeFor(selection.total, amountMicrotari, REVEAL_FEE_RESERVE)
  if (fee > reserved) {
    throw new Error(
      `The network fee (${fee} µtTARI) is higher than this reveal reserved for it (${reserved} µtTARI). ` +
      `Fees have risen — try a smaller amount.`,
    )
  }

  // The pinned selection was made against the reserve. If fees have risen past it, the inputs may
  // no longer cover `amount + fee` — refuse with the real numbers rather than build a transaction
  // whose balance equation cannot close.
  if (amountMicrotari + fee > selection.total) {
    throw new Error(
      `The network fee (${fee} µtTARI) is higher than this reveal reserved for it. ` +
      `Revealing ${amountMicrotari} µtTARI would need ${amountMicrotari + fee} µtTARI of private funds, ` +
      `and the selected outputs hold ${selection.total}. Try a smaller amount.`,
    )
  }

  log('Building…')
  const real = await buildEnvelope(fee, false)

  // The pinned selection is what the real envelope was built from, so these are exactly the
  // outputs this transaction consumes. Read here, at the only point where both the selection and
  // the built transaction are known to agree.
  const spentInputIds = selection.inputs.map(u => u.substateId)

  return {
    feeMicrotari: fee,
    revealedAmount: real.split.amount,
    revealedOutput: real.split.revealedOutput,
    changeAmount: real.split.changeAmount,
    inputCount: selection.inputs.length,
    inputTotal: selection.total,
    submit: async (onSubmitProgress?: (msg: string) => void) => {
      const slog = (m: string) => onSubmitProgress?.(m)
      slog('Submitting…')
      const sub = await provider.submitTransaction(real.envelope)
      const txId = sub.transaction_id as string

// ── THE SPEND RECORD, RESOLVED IN THE SAME FUNCTION THAT SUBMITS ─────────────
//
// Locking happens HERE rather than at the UI call site, and that is a correctness requirement
// rather than a convenience. `markLocked` has to run between submitting and hearing back, and this
// function does not return until it HAS heard back — so a call site could not lock in that window
// even if it wanted to. Leaving it to the caller would also mean every future call site has to
// remember, and the cost of forgetting is a transaction the chain rejects after taking its fee.
//
// The verdict mapping is the reference wallet's (crypto/spentOutputs, OutputStatus):
//   Commit  → promoteToSpent   the locks become facts.
//   Reject  → release          the inputs were never consumed; give them back. Note this covers
//                              AcceptFeeRejectRest, where the fee committed and nothing moved —
//                              txResult.ts folds that into `Reject`, and it is the right call
//                              here: the coins are untouched.
//   Timeout → LEAVE LOCKED     not a verdict. Since the wait moved to the SSE watcher
//                              (crypto/finality, 180s) a timeout is rare and means nothing was
//                              legible — not that the transaction failed — so unlocking on one
//                              would risk handing a spent coin back to the next selection.
      markLocked(ownerAddress, spentInputIds, txId)

      slog('Confirming on-chain…')
      // TOLD, NOT ASKED — see crypto/finality. The verdict is still read by crypto/txResult, so
      // a fee-only commit is still a failure and not a success.
      const { outcome, reason, body } = await awaitFinality(provider, txId)
      // Only an ACCEPT creates substates, so only an Accept can name the account component.
      const confirmedAccount = outcome === 'Commit' && body !== null
        ? extractAccountAddress(body, ownerPkHex) ?? undefined
        : undefined
      provider.stopWatcher?.()

      if (outcome === 'Commit') promoteToSpent(ownerAddress, txId)
      else if (outcome === 'Reject') release(ownerAddress, txId)

      // The free capture, as conceal does it: a reveal runs CreateAccount, so a wallet that never
      // stored its address gets one here. saveAccountAddress is first-write-wins, so a repeat is a
      // no-op.
      if (confirmedAccount) saveAccountAddress(ownerAddress, confirmedAccount)

      return {
        txId,
        outcome,
        reason,
        revealedAmount: real.split.amount,
        feeMicrotari: fee,
        changeAmount: real.split.changeAmount,
        accountAddress: confirmedAccount,
        selfOutputIds: real.selfOutputIds,
        spentInputIds,
      }
    },
  }
}

/** Prepare and submit in one call. The one-shot form, for callers with nothing to review. */
export async function revealFunds(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  params: RevealParams,
): Promise<RevealResult> {
  const prepared = await prepareReveal(wallet, ownerAddress, params)
  return prepared.submit(params.onProgress)
}

function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
