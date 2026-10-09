// PUBLIC SEND — pay someone from the account vault, into their PRIVATE balance. M8.
//
// ── WHAT THIS IS, IN ONE LINE ─────────────────────────────────────────────────
//
// conceal.ts with the stealth output pointed at somebody else. That is the whole difference, and
// keeping it that small is deliberate: conceal's chain is proven on-chain, and every part of it
// that is not the destination stays untouched.
//
//     createAccount(ownerPk)                            → 'account'   [idempotent — reuses existing]
//     callMethod(account, 'pay_fee', [budget])          the fee, from the vault — REFUNDED down to cost
//     callMethod(account, 'withdraw', [TARI, amount])   → 'bucket'    revealed OUT of the vault
//     StealthTransfer { revealedInputBucket: 'bucket' } no revealed output; nothing left over
//
// A conceal sends the stealth output to `ownerAddress`; this sends it to the recipient's — the same
// transaction shape. Like a conceal it pays its fee from the vault with the account's REFUNDABLE
// `pay_fee`, so only the real cost is taken (see conceal.ts for the engine references).
//
// ── THE DESTINATION IS ALWAYS PRIVATE, AND THAT IS A FEATURE ──────────────────
//
// Value lands as a confidential UTXO at the recipient's stealth address, exactly as an ordinary
// send does. They reveal it themselves if they want it public. Nothing here needs their account
// component, so there is no derivation in the send path, no "their account must exist yet" trap,
// and no way to publish someone else's balance on their behalf. A stealth address always works.
//
// WHAT IS PUBLIC ABOUT IT, honestly: the SENDER's side. The withdraw is a plain instruction naming
// this account and a readable amount, so an observer learns that this account paid out that much.
// What they do not learn is who received it — the output is a commitment at a one-time address.
//
// ── THE INVARIANT THAT MATTERS ────────────────────────────────────────────────
//
// The engine checks, with NO tolerance (tari-ootle: runtime/working_state.rs:2062-2074):
//
//     bucket.unlocked_amount() == statement.inputs_statement.revealed_amount
//
// The bucket comes from `withdraw`; the revealed amount from buildInputsStatement. Two derivations
// of "the same" number is exactly how that check starts failing, so there is only ONE:
// planPublicSend computes the split once and the single `withdrawAmount` is threaded to both.

import { submitOnce, versionsUnchanged } from './submitGuard'
import { confirmer } from './quote'
import { feesPaid } from './conceal'
import { RETRYING_MESSAGE } from './indexerRetry'
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
import { dryRunFee, priceAtBudget, simulateAtShownFee, simulateFee, type FeeSimulation } from './feeProbe'
import { awaitFinality } from './finality'
import { INDEXER_URL } from './indexerConfig'


/**
 * Fee reserved for the DRY RUN only, and the amount MAX holds back (µtTARI).
 *
 * The probe is carved out of the WITHDRAW, not out of what the recipient receives — the recipient's
 * amount is whatever the sender typed, in every build. So this only has to be covered by the public
 * balance, and it is deliberately far above every fee measured on this network (~13–20k) so the
 * simulation always runs to completion. An under-funded probe aborts before the network has priced
 * the whole transaction and reports a cost far below the truth.
 */
export const PUBLIC_SEND_FEE_RESERVE = 50_000n

/**
 * Smallest amount that may be sent from the public balance (µtTARI, 0.1 TARI).
 *
 * A judgement, not a structural limit — unlike conceal's floor, the probe here is not taken from
 * the amount, so a smaller send would simulate fine. It is kept identical to the conceal and reveal
 * floors so every amount field in the wallet behaves the same way, and because sending less than
 * the fee it costs is a bad trade.
 */
export const MIN_PUBLIC_SEND_MICROTARI = 100_000n

export type PublicSendOutcome = 'Commit' | 'Reject' | 'Timeout'

export interface PublicSendResult {
  txId: string
  outcome: PublicSendOutcome
  /**
   * What the network said when it refused, verbatim inside a sentence — see crypto/txResult.
   *
   * Present on `Reject` and absent on `Commit`/`Timeout`. It is the only account anyone gets of why
   * a transaction failed, so it is carried out of the poll rather than logged and dropped: a fee
   * taken for nothing, or a rejection, is exactly the moment a user deserves the real reason.
   */
  reason?: string
  /** What the recipient receives (µtTARI) — exactly the amount asked for. */
  recipientAmount: bigint
  /** Fee reserved for this transaction (µtTARI), paid out of the same withdraw. */
  feeMicrotari: bigint
  /** Total that left the vault — `amount + fee`. */
  withdrawAmount: bigint
  /** Account address read from the committed result — the free capture for pre-M1 wallets. */
  accountAddress?: string
}

export interface PublicSendParams {
  /** The recipient's `otl_esm_` stealth address. Validated before anything is built. */
  recipient: string
  /**
   * µtTARI the RECIPIENT receives. Defined as what ARRIVES, not what is spent — the fee is added on
   * top, out of the public balance. Anything else would deliver a different number than the sender
   * typed into a payment field.
   */
  amountMicrotari: bigint
  onProgress?: (msg: string) => void
}

// ── Recipient validation, before a single byte is built ───────────────────────

/** Minimal shape of the WASM address parser, so tests need no WASM. */
export type OotleAddressParser = (address: string) => { owner_key: Uint8Array; view_key: Uint8Array; network: number }

/**
 * Check a recipient address is a real stealth address on THIS network.
 *
 * FUND-CRITICAL AND UNRECOVERABLE IF WRONG. `createOutput` derives the one-time output key from the
 * destination's keys; a mis-parsed address produces a perfectly valid commitment that only somebody
 * else — or nobody — can open. There is no bounce and no error at spend time, so the check has to
 * happen here, before the transaction exists.
 *
 * THE NETWORK BYTE IS THE ONE PEOPLE FORGET. A mainnet address is well-formed and parses cleanly;
 * paying it from a testnet wallet would build a transaction that commits to keys whose owner is not
 * watching this chain. bech32m catches a typo; only this catches a wrong-network paste.
 *
 * Throws with a message fit to show a user. Returns nothing — the address string itself is what the
 * builder passes on, so there is no second representation to drift.
 */
export function assertValidRecipient(
  recipient: string,
  parse: OotleAddressParser,
  network: Network = Network.Esmeralda,
): void {
  const trimmed = recipient.trim()
  if (!trimmed) throw new Error('Enter the address you want to pay.')

  let parsed: { owner_key: Uint8Array; view_key: Uint8Array; network: number }
  try {
    parsed = parse(trimmed)
  } catch {
    throw new Error('That doesn’t look like a valid Tari address. Check it and try again.')
  }

  if (parsed.network !== network) {
    throw new Error('That address belongs to a different Tari network, so it can’t receive this payment.')
  }
  // Defence in depth: a parser that returned short keys would otherwise reach createOutput.
  if (parsed.owner_key?.length !== 32 || parsed.view_key?.length !== 32) {
    throw new Error('That address is malformed and can’t receive a payment.')
  }
}

// ── The fund-critical arithmetic, isolated so it can be tested ────────────────

export interface PublicSendSplit {
  /** What the recipient receives. Caller-chosen; never adjusted behind their back. */
  recipientAmount: bigint
  /** What `pay_fee` offers from the vault. The engine takes the cost and refunds the rest. */
  feeBudget: bigint
  /** Withdrawn into the bucket. IS the statement's revealed input — and, with no revealed output, the recipient's amount. */
  withdrawAmount: bigint
}

/**
 * Split a public send into the withdraw, what arrives, and the fee budget.
 *
 * The amount is what ARRIVES, so the fee goes ON TOP — the one rule every action follows (planReveal
 * and planConceal too). It is paid separately from the vault by `pay_fee(budget)`, refunded down to
 * the cost, so the bucket holds exactly the amount and the vault gives up `amount + cost`.
 */
export function planPublicSend(amountMicrotari: bigint, feeBudget: bigint): PublicSendSplit {
  if (amountMicrotari <= 0n) throw new Error('Amount must be greater than zero.')
  if (feeBudget <= 0n) throw new Error('Fee must be greater than zero.')
  return { recipientAmount: amountMicrotari, feeBudget, withdrawAmount: amountMicrotari }
}

/**
 * Re-check the split immediately before it is used to build a transaction.
 *
 * Redundant by construction today — planPublicSend cannot produce a split that fails this. That is
 * the point: it is a tripwire for a future edit that computes the withdraw amount separately from
 * the statement's revealed input. Failing here is a caught bug; failing on-chain is a rejection
 * whose reason is a bucket-mismatch string from the engine.
 */
export function assertPublicSendSplit(split: PublicSendSplit): void {
  const { recipientAmount, feeBudget, withdrawAmount } = split
  if (recipientAmount <= 0n || feeBudget <= 0n || withdrawAmount <= 0n) {
    throw new Error(`publicSend: non-positive component in split (amount ${recipientAmount}, fee ${feeBudget}, withdraw ${withdrawAmount})`)
  }
  // No revealed output: everything withdrawn into the bucket goes to the recipient.
  if (recipientAmount !== withdrawAmount) {
    throw new Error(`publicSend: split does not balance — amount ${recipientAmount} !== withdraw ${withdrawAmount}`)
  }
}

/**
 * The largest amount MAX may offer for a given public balance.
 *
 * Reserves the probe, because the withdraw is `amount + fee` and the vault has to cover it while
 * pricing. Returns 0n when the balance cannot cover the reserve — treat that as "MAX unavailable",
 * never as an amount. EXACT BIGINT; nothing here rounds.
 */
export function maxPublicSend(publicBalance: bigint): bigint {
  return publicBalance > PUBLIC_SEND_FEE_RESERVE ? publicBalance - PUBLIC_SEND_FEE_RESERVE : 0n
}

// ── Transaction ───────────────────────────────────────────────────────────────

/**
 * The instruction recipe, lifted out so the pricing build and the real build are provably the same
 * transaction shape and can only differ in the fee threaded through them — conceal.ts's discipline,
 * for the same reason.
 *
 * `withdrawAmount` appears exactly once here, and the caller passes the same value into
 * buildInputsStatement. That single-use is what upholds the engine's equality check.
 */
function buildPublicSend(
  maxEpoch: number,
  ownerPkHex: string,
  withdrawAmount: bigint,
  feeBudget: bigint,
  statement: StealthTransferStatement,
  declaredInputs: string[],
) {
  return new TransactionBuilder(Network.Esmeralda, maxEpoch)
    .withFeeInstructionsBuilder((b) =>
      b
        // Create-or-reuse: the engine derives the address from the owner key and returns the
        // existing component if there is one, so this is safe to issue on every send.
        .createAccount(ownerPkHex)
        .saveVar('account')
        // REFUNDABLE: the vault offers `feeBudget`, the engine takes the cost, the rest goes back.
        .callMethod({ fromWorkspace: 'account', methodName: 'pay_fee' }, [amountLiteral(feeBudget)])
        .callMethod({ fromWorkspace: 'account', methodName: 'withdraw' }, [
          resourceAddressLiteral(TARI_RESOURCE_ADDRESS),
          amountLiteral(withdrawAmount),
        ])
        .saveVar('bucket')
        // No revealed output, so the transfer returns no bucket — nothing to save or pay from.
        .addInstruction(
          stealthTransferInstruction(
            { resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: 'bucket', statement },
            (name) => b.resolveWorkspaceOffsetId(name),
          ),
        ),
    )
    // ── THE INPUTS ARE NOT OPTIONAL (ce04b60's lesson) ──
    //
    // `CreateAccount` only REUSES an existing account when that component is declared as an input.
    // Without it the engine loads nothing, mints a fresh empty account in the working state, and the
    // `withdraw` panics with "No vault for resource". Declaring the component means the vault must
    // be declared too, or the withdraw fails with "SubstateNotFound".
    .withInputs(declaredInputs.map(substate_id => ({ substate_id, version: null })))
}


/** A priced, built, signed public send — everything except pressing send. */
export interface PreparedPublicSend {
  /** The exact measured cost (µtTARI) — what the review screen shows and what is charged. */
  feeMicrotari: bigint
  /** What `pay_fee` offers from the vault. Above the cost by a buffer that is REFUNDED, never shown. */
  feeBudget: bigint
  /** What the recipient receives: exactly the amount asked for. */
  recipientAmount: bigint
  /** Total leaving the public balance: the amount plus the fee. */
  withdrawAmount: bigint
  /** What the pricing dry run measured, before the margin (µtTARI). */
  dryRunCost: bigint
  /**
   * Dry-run a twin of the real transaction at `feeMicrotari` (default: the prepared fee) and return
   * the verdict. Free — nothing is submitted. The confirm step runs it at the exact fee; the harness
   * runs it at the cost and one below to find the boundary.
   */
  simulate: (feeMicrotari?: bigint) => Promise<FeeSimulation>
  /** When it was priced. Past QUOTE_MAX_AGE_MS the confirm check refuses it (crypto/quote). */
  preparedAt: number
  /**
   * The confirm-time check: quote age, inputs unchanged, and a dry run of the final transaction at
   * the exact fee. Throws QuoteChanged — NOTHING SENT — when it no longer holds; re-prepare.
   */
  confirm: () => Promise<void>
  /** Let go of whatever this prepare holds (cancel, or before re-pricing). Idempotent. */
  release: () => void
  /** Send it — the confirm check first, unless confirm() just passed. Resolves on a final decision. */
  submit: (onProgress?: (msg: string) => void) => Promise<PublicSendResult>
}

/**
 * Price and build a public send without sending it.
 *
 * Two-phase for the same reason conceal is: the fee a user approves must be the fee the transaction
 * pays. Everything that can fail for a boring reason — a bad address, a missing account, a dead
 * indexer, a rejected simulation — happens here, before the confirm.
 *
 * THE DRY RUN IS LOAD-BEARING HERE IN A WAY IT WAS NOT BEFORE. This is the first path whose
 * simulation depends on substates beyond our own account, so a fee-intent-commit rejection is a
 * live possibility rather than a theoretical one. dryRunFee refuses to price anything that is not a
 * clean Accept (M5) — without that fix this path could have quoted a cheap fee for a transaction
 * that would take the fee and deliver nothing.
 */
export async function preparePublicSend(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  parseAddress: OotleAddressParser,
  { recipient, amountMicrotari, onProgress }: PublicSendParams,
): Promise<PreparedPublicSend> {
  const log = (m: string) => onProgress?.(m)

  // FIRST, before anything is built or any network call is made.
  assertValidRecipient(recipient, parseAddress)

  if (amountMicrotari < MIN_PUBLIC_SEND_MICROTARI) {
    throw new Error(`The smallest amount you can send from your public balance is ${MIN_PUBLIC_SEND_MICROTARI} µtTARI (0.10 TARI).`)
  }

  // The account address is a HARD PREREQUISITE: without it the transaction cannot declare the
  // account as an input, and without that declaration CreateAccount mints a fresh empty account and
  // the withdraw panics. Recovery runs on unlock and is free, so reaching here without one means
  // the probe could not answer — a network problem, reported as one.
  const accountAddress = loadAccountAddress(ownerAddress)
  if (!accountAddress) {
    throw new Error('This wallet’s account could not be identified, so its public balance can’t be spent. Check your connection and try again.')
  }

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  // The owner key signs for the account — the withdraw and the vault-paid fee both need it.
  const ownerPk = await wallet.getPublicKey()
  const ownerPkHex = toHexStr(ownerPk)

  // ── THE ACCOUNT MAY NOT EXIST YET, AND THAT IS NOT AN ERROR ────────────────
  //
  // A wallet funded only by RECEIVING holds real stealth UTXOs and has never created an account
  // component — private send and receive never touch one. Declaring a component that is not there
  // aborts with "Substate not found" before anything is signed, which is how every public action on
  // such a wallet used to 404.
  //
  // So: declare the component and its vaults when it EXISTS (CreateAccount then reuses it), and
  // declare NOTHING when it does not (CreateAccount then mints it — which is how an account comes to
  // exist in Caravel; the faucet claim no longer creates one). Getting that backwards on an
  // account that DOES exist would deposit into a throwaway component and lose the funds silently,
  // so resolveAccountInputs rethrows anything that is not a definite not-found rather than guessing.
  const { declaredInputs } = await resolveAccountInputs(provider, accountAddress)

  // Read ONCE and reused by the pricing build and the real one, so the transaction that is
  // simulated is the transaction that is sent.
  const maxEpoch = await nextMaxEpoch(provider)

  // The whole build is a function OF the fee — the outputs statement commits to it and the balance
  // proof signs over both — so it runs once to price and once to send.
  async function buildEnvelope(feeBudget: bigint, dryRun: boolean) {
    const split = planPublicSend(amountMicrotari, feeBudget)
    assertPublicSendSplit(split)

    // THE ONE LINE THAT DIFFERS FROM A CONCEAL: the destination is the recipient, not ownerAddress.
    // No revealed output: the fee is paid from the vault, not out of this transfer.
    const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(
      [createOutput({ destination: recipient.trim(), amount: split.recipientAmount, resourceAddress: TARI_RESOURCE_ADDRESS })],
      null,
    )
    // THE SINGLE VALUE. `split.withdrawAmount` feeds the statement here and the withdraw
    // instruction below; there is no second computation of it anywhere.
    const inputsStatement = await crypto.buildInputsStatement([], split.withdrawAmount)
    // Zero input mask: the value comes from a vault, not from confidential inputs.
    const balanceProof = await signBalanceProof(crypto, Mask.zero(), outputMask, inputsStatement, outputsStatement)
    const statement = new StealthTransferStatement(inputsStatement, outputsStatement, balanceProof)

    const builder = buildPublicSend(maxEpoch, ownerPkHex, split.withdrawAmount, split.feeBudget, statement, declaredInputs)
    const unsigned = await resolveTransaction(provider, builder.buildUnsignedTransaction())
    const signed = await signTransaction([wallet], dryRun ? { ...unsigned, dry_run: true } : unsigned)
    return { envelope: sealTransaction(signed), split }
  }

  log('Estimating network fee…')
  // THE FEE SHOWN IS THE COST AT THE REAL BUDGET — see feeProbe.priceAtBudget. `pay_fee` offers the
  // cost plus a small buffer the engine refunds, capped by the reserve the amount left in the vault
  // (maxPublicSend); the cost is measured at that very budget, because the budget moves it.
  //
  // ── THE PROBE→REAL FEE GUARD ──
  //
  // A cost above the reservation asks the vault for more than the dry run ever tried, and if the
  // balance does not stretch it fails on-chain AFTER the user has confirmed. priceAtBudget refuses
  // it here, where nothing has been sent.
  const priced = await priceAtBudget(
    async budget => dryRunFee(INDEXER_URL, (await buildEnvelope(budget, true)).envelope, { onBusyRetry: () => log(RETRYING_MESSAGE) }),
    { reserve: PUBLIC_SEND_FEE_RESERVE },
  )
  const fee = priced.fee
  const cost = priced.probeCost
  const budget = priced.budget

  log('Building…')
  const real = await buildEnvelope(budget, false)
  const preparedAt = Date.now()
  // The twin carries a BUDGET; the requirement is checked against it (feeProbe.simulateFee).
  const simulate = async (feeBudget: bigint = budget) => simulateFee(INDEXER_URL, (await buildEnvelope(feeBudget, true)).envelope, { fee: feeBudget })
  // THE VAULT VERSIONS THE REAL BUILD PINNED. A vault that moves before confirm (a receive, another
  // tab's move) makes the pinned transaction stale, so the confirm check refuses it and re-prices.
  const vaultsAsBuilt = await versionsUnchanged(declaredInputs.filter(id => id.startsWith('vault_')))
  // Held to the FEE SHOWN: a final transaction that would cost anything else re-prices first.
  const check = confirmer({
    preparedAt,
    simulate: async () => simulateAtShownFee(INDEXER_URL, (await buildEnvelope(budget, true)).envelope, { budget, shownFee: fee }),
    inputs: { landed: vaultsAsBuilt },
  })

  return {
    feeMicrotari: fee,
    dryRunCost: cost,
    simulate,
    preparedAt,
    confirm: check.confirm,
    // Spends a vault, not selected coins: nothing is reserved, so there is nothing to release.
    release: () => {},
    feeBudget: budget,
    recipientAmount: real.split.recipientAmount,
    withdrawAmount: real.split.recipientAmount + fee,
    submit: async (onSubmitProgress?: (msg: string) => void) => {
      const slog = (m: string) => onSubmitProgress?.(m)
      slog('Checking the fee…')
      await check.ensureConfirmed()
      slog('Submitting…')
      // Snapshot the account vaults this spends from, so a busy refusal can be checked against them.
      const landed = await versionsUnchanged(declaredInputs.filter(id => id.startsWith('vault_')))
      const sub = await submitOnce(() => provider.submitTransaction(real.envelope), {
        landed,
        onBusyRetry: () => slog(RETRYING_MESSAGE),
      })
      const txId = sub.transaction_id as string

      slog('Confirming on-chain…')
      // TOLD, NOT ASKED — see crypto/finality. The verdict is still read by crypto/txResult, so
      // a fee-only commit is still a failure and not a success.
      const { outcome, reason, body } = await awaitFinality(provider, txId)
      // Only an ACCEPT creates substates, so only an Accept can name the account component.
      const confirmedAccount = outcome === 'Commit' && body !== null
        ? extractAccountAddress(body, ownerPkHex) ?? undefined
        : undefined
      provider.stopWatcher?.()

      // The free capture: this runs CreateAccount, so a wallet that never stored its address gets
      // one here. saveAccountAddress is first-write-wins, so a repeat is a no-op.
      if (confirmedAccount) saveAccountAddress(ownerAddress, confirmedAccount)

      return {
        txId,
        outcome,
        reason,
        recipientAmount: real.split.recipientAmount,
        // WHAT WAS CHARGED, from the receipt — the budget is refunded down to the cost.
        feeMicrotari: feesPaid(body) ?? fee,
        withdrawAmount: real.split.recipientAmount + (feesPaid(body) ?? fee),
        accountAddress: confirmedAccount,
      }
    },
  }
}

function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
