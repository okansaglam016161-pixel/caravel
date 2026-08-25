// REVEAL — move stealth (private) TARI into the account's revealed (public) balance. M3.
//
// THE IRREVERSIBLE DIRECTION. A conceal can be undone by revealing again; a reveal cannot be undone
// at all. The amount lands as a plain integer in a vault owned by a component whose address is
// derived from this wallet's public key, and it stays world-readable in the chain's history forever
// — including for anyone who later learns which account is yours. So the number the user typed is
// the number that gets published, exactly, and every guard in this file exists to keep it that way.
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
  getVaultIdsForAccount,
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
import { nextMaxEpoch } from './epoch'
import { dryRunFee, withFeeMargin } from './feeProbe'
import { StaticSigner, scanOwnedUtxos, type OwnedUtxo } from './stealthUtxos'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'

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

/**
 * Most stealth inputs one reveal may spend.
 *
 * Every input adds a commitment to the statement, a one-time signature to the envelope, and cost to
 * the fee. Unbounded, a wallet holding many small outputs would build a transaction that prices
 * fine in simulation and is then refused for size AFTER the user confirmed an irreversible action.
 * A bound turns that into an honest refusal beforehand. 8 covers any realistic wallet here; a user
 * who genuinely needs more can reveal twice, or consolidate with a self-send first.
 */
export const MAX_STEALTH_INPUTS = 8

export type RevealOutcome = 'Commit' | 'Reject' | 'Timeout'

export interface RevealResult {
  txId: string
  outcome: RevealOutcome
  /** What was made public (µtTARI) — exactly the amount asked for. */
  revealedAmount: bigint
  /** Fee reserved for this transaction (µtTARI), paid out of the stealth inputs. */
  feeMicrotari: bigint
  /** Stealth change returned to the wallet (µtTARI). */
  changeAmount: bigint
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
 * The largest amount MAX may offer for a given private balance.
 *
 * Reserves the fee probe AND MIN_STEALTH_CHANGE, so the priced build and the real one both carry a
 * stealth change output (see MIN_STEALTH_CHANGE). Returns 0n when the balance cannot cover the
 * reserve at all, which the caller should treat as "MAX is not available", never as an amount.
 *
 * EXACT BIGINT, and it must stay that way: this feeds an amount field whose value is published
 * permanently, and the M2 lesson was that routing a balance through a display formatter overshoots
 * it. Nothing here rounds.
 */
export function maxRevealable(privateTotal: bigint): bigint {
  const reserve = REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE
  return privateTotal > reserve ? privateTotal - reserve : 0n
}

// ── Stealth input selection ───────────────────────────────────────────────────

/** The minimum a candidate must expose to be selectable. Keeps selection testable without a chain. */
export interface Spendable { value: bigint }

export interface InputSelection<T extends Spendable> {
  /** The UTXOs to spend, in the order they will be added to the statement. */
  inputs: T[]
  /** Their summed value — the `inputTotal` planReveal balances against. */
  total: bigint
}

/**
 * Choose stealth UTXOs covering `target` (= amount + fee).
 *
 * THE ORDER OF PREFERENCE, and why each step is where it is:
 *
 *   1. An EXACT single match, if one exists. One input, no change output, smallest possible
 *      transaction — and no change means no opportunity to compute one wrongly.
 *   2. Otherwise the SMALLEST single UTXO that covers the target. One input still, and it locks the
 *      least value; it also leaves the wallet's larger outputs intact for later. This mirrors what
 *      the send path has always done.
 *   3. Otherwise accumulate LARGEST-FIRST until covered. Largest-first minimises the number of
 *      inputs, which is what the fee and MAX_STEALTH_INPUTS both care about.
 *
 * Refuses rather than improvising when the wallet cannot cover the target, or when covering it
 * would need more inputs than MAX_STEALTH_INPUTS — both with the actual numbers, because an
 * irreversible action deserves to fail with a reason the user can act on.
 *
 * DETERMINISTIC for a given candidate list: sorts are stable and the input order is the indexer's,
 * so the transaction priced by the dry run is built from the same inputs as the one submitted.
 */
export function selectStealthInputs<T extends Spendable>(utxos: T[], target: bigint): InputSelection<T> {
  if (target <= 0n) throw new Error('Reveal target must be greater than zero.')

  // Zero-value outputs cannot help cover anything and would only inflate the input count.
  const usable = utxos.filter(u => u.value > 0n)
  if (usable.length === 0) {
    throw new Error('No private funds found to reveal. This wallet holds no spendable stealth outputs.')
  }

  const available = usable.reduce((s, u) => s + u.value, 0n)
  if (available < target) {
    throw new Error(
      `Not enough private funds. This reveal needs ${target} µtTARI (amount + network fee), ` +
      `and the wallet holds ${available} µtTARI across ${usable.length} output(s).`,
    )
  }

  // 1 — exact single match.
  const exact = usable.find(u => u.value === target)
  if (exact) return { inputs: [exact], total: exact.value }

  // 2 — smallest single UTXO that covers it.
  const covering = usable.filter(u => u.value > target).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  const single = covering[0]
  if (single) return { inputs: [single], total: single.value }

  // 3 — largest-first accumulation.
  const descending = [...usable].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))
  const inputs: T[] = []
  let total = 0n
  for (const u of descending) {
    inputs.push(u)
    total += u.value
    if (total >= target) break
  }

  // `available >= target` was checked above, so the loop always reaches the target; the only way to
  // arrive here over budget is needing too many inputs to get there.
  if (inputs.length > MAX_STEALTH_INPUTS) {
    throw new Error(
      `Your private balance is spread across too many small outputs to reveal ${target} µtTARI in one ` +
      `transaction (it would need ${inputs.length}, and the limit is ${MAX_STEALTH_INPUTS}). ` +
      `Reveal a smaller amount, or send yourself a payment first to consolidate.`,
    )
  }

  return { inputs, total }
}

// ── Transaction ───────────────────────────────────────────────────────────────

// Workspace slots, in the order the fee-instruction builder allocates them. The builder hands out
// ids sequentially from 0 and has no public way to ask for the next one, so `to_deposit` — whose id
// TakeFromBucket must carry as a raw number — is written out explicitly and the two NAMED slots are
// asserted against their expected ids at build time. If a future SDK changes the allocation order,
// that assertion fires here instead of the transaction silently depositing the wrong bucket.
const WS_ACCOUNT = 0
const WS_BUCKET = 1
const WS_TO_DEPOSIT = 2

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
      if (accountSlot.id !== WS_ACCOUNT || bucketSlot.id !== WS_BUCKET) {
        throw new Error(
          `reveal: unexpected workspace layout (account ${accountSlot.id}, bucket ${bucketSlot.id}) — ` +
          `the TakeFromBucket output slot ${WS_TO_DEPOSIT} can no longer be assumed free.`,
        )
      }

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

/** Poll the indexer for the reveal tx's decision, reading the account address from the same body. */
async function pollOutcome(txId: string, ownerPkHex: string): Promise<{ outcome: RevealOutcome; accountAddress?: string }> {
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
  const utxos = await scanOwnedUtxos(crypto, viewSecret)

  // SELECTED ONCE, AGAINST THE RESERVE, AND PINNED. The fee is not known until the dry run, and the
  // dry run needs a transaction — so the selection is made against the generous reserve and the
  // SAME inputs are used for the real build. Re-selecting at the measured fee would change the
  // transaction's shape, which would change its fee, which would change the selection: a loop with
  // no fixed point, and a priced transaction that is not the one submitted. Because the measured
  // fee is smaller than the reserve, the pinned inputs still cover it — the surplus simply comes
  // back as a slightly larger change output. The guard below re-checks that rather than assuming it.
  const selection = selectStealthInputs(utxos, amountMicrotari + REVEAL_FEE_RESERVE)

  // Every vault the account holds is declared, rather than picking out the TARI one: an account has
  // few vaults, declaring a spare one costs nothing, and choosing wrongly costs a failed
  // transaction. An account with NO vaults yet is normal here — the deposit creates the TARI vault,
  // and a substate being created is an output, not an input to declare.
  const vaultIds = await getVaultIdsForAccount(provider, accountAddress)
  const declaredInputs = [accountAddress, ...vaultIds]

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
    return { envelope: sealTransaction(signed), split }
  }

  log('Estimating network fee…')
  const probe = await buildEnvelope(REVEAL_FEE_RESERVE, true)
  const cost = await dryRunFee(INDEXER_URL, probe.envelope)
  const fee = withFeeMargin(cost)

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

      slog('Confirming on-chain…')
      const { outcome, accountAddress: confirmedAccount } = await pollOutcome(txId, ownerPkHex)
      provider.stopWatcher?.()

      // The free capture, as conceal does it: a reveal runs CreateAccount, so a wallet that never
      // stored its address gets one here. saveAccountAddress is first-write-wins, so a repeat is a
      // no-op.
      if (confirmedAccount) saveAccountAddress(ownerAddress, confirmedAccount)

      return {
        txId,
        outcome,
        revealedAmount: real.split.amount,
        feeMicrotari: fee,
        changeAmount: real.split.changeAmount,
        accountAddress: confirmedAccount,
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
