// PUBLIC SEND — pay someone from the account vault, into their PRIVATE balance. M8.
//
// ── WHAT THIS IS, IN ONE LINE ─────────────────────────────────────────────────
//
// conceal.ts with the stealth output pointed at somebody else. That is the whole difference, and
// keeping it that small is deliberate: conceal's chain is proven on-chain, and every part of it
// that is not the destination stays untouched.
//
//     createAccount(ownerPk)                            → 'account'   [idempotent — reuses existing]
//     callMethod(account, 'withdraw', [TARI, amount])   → 'bucket'    revealed OUT of the vault
//     StealthTransfer { revealedInputBucket: 'bucket' } → 'fee_bucket'
//     PayFeeFromBucket { fee_bucket }
//
// A conceal sends the stealth output to `ownerAddress`; this sends it to the recipient's. Measured
// at ~18 705 µtTARI by dry run — identical whether the destination is self or a stranger, which is
// the strongest evidence available that it really is the same transaction shape.
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

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'

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
  /** Paid to the network out of the same withdraw. */
  feeMicrotari: bigint
  /** Revealed µtTARI leaving the vault. IS the statement's revealed input — one value, both uses. */
  withdrawAmount: bigint
}

/**
 * Split a public send into what leaves the vault, what arrives, and the fee.
 *
 * THE ASYMMETRY WITH planConceal, and it is the same one reveal has: conceal's `amount` is what
 * LEAVES the vault and the fee is carved out of it. A send's amount is what ARRIVES, so the fee
 * goes ON TOP. Getting these the same way round would quietly short-pay every recipient by the fee.
 */
export function planPublicSend(amountMicrotari: bigint, feeMicrotari: bigint): PublicSendSplit {
  if (amountMicrotari <= 0n) throw new Error('Amount must be greater than zero.')
  if (feeMicrotari <= 0n) throw new Error('Fee must be greater than zero.')
  return {
    recipientAmount: amountMicrotari,
    feeMicrotari,
    withdrawAmount: amountMicrotari + feeMicrotari,
  }
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
  const { recipientAmount, feeMicrotari, withdrawAmount } = split
  if (recipientAmount <= 0n || feeMicrotari <= 0n || withdrawAmount <= 0n) {
    throw new Error(`publicSend: non-positive component in split (amount ${recipientAmount}, fee ${feeMicrotari}, withdraw ${withdrawAmount})`)
  }
  if (recipientAmount + feeMicrotari !== withdrawAmount) {
    throw new Error(`publicSend: split does not balance — amount ${recipientAmount} + fee ${feeMicrotari} !== withdraw ${withdrawAmount}`)
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
    // ── THE INPUTS ARE NOT OPTIONAL (ce04b60's lesson) ──
    //
    // `CreateAccount` only REUSES an existing account when that component is declared as an input.
    // Without it the engine loads nothing, mints a fresh empty account in the working state, and the
    // `withdraw` panics with "No vault for resource". Declaring the component means the vault must
    // be declared too, or the withdraw fails with "SubstateNotFound".
    .withInputs(declaredInputs.map(substate_id => ({ substate_id, version: null })))
}

/** Poll the indexer for the decision, reading the account address from the same body. */
async function pollOutcome(txId: string, ownerPkHex: string): Promise<{ outcome: PublicSendOutcome; accountAddress?: string }> {
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

/** A priced, built, signed public send — everything except pressing send. */
export interface PreparedPublicSend {
  /** Measured fee including margin (µtTARI) — what the review screen shows and the tx pays. */
  feeMicrotari: bigint
  /** What the recipient receives: exactly the amount asked for. */
  recipientAmount: bigint
  /** Total leaving the vault — the withdraw, and the statement's revealed input. */
  withdrawAmount: bigint
  /** Send it. Resolves once the transaction has a final on-chain decision. */
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

  // Read ONCE and reused by the pricing build and the real one, so the transaction that is
  // simulated is the transaction that is sent.
  const maxEpoch = await nextMaxEpoch(provider)

  // The whole build is a function OF the fee — the outputs statement commits to it and the balance
  // proof signs over both — so it runs once to price and once to send.
  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    const split = planPublicSend(amountMicrotari, feeMicrotari)
    assertPublicSendSplit(split)

    // THE ONE LINE THAT DIFFERS FROM A CONCEAL: the destination is the recipient, not ownerAddress.
    const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(
      [createOutput({ destination: recipient.trim(), amount: split.recipientAmount, resourceAddress: TARI_RESOURCE_ADDRESS })],
      split.feeMicrotari,
    )
    // THE SINGLE VALUE. `split.withdrawAmount` feeds the statement here and the withdraw
    // instruction below; there is no second computation of it anywhere.
    const inputsStatement = await crypto.buildInputsStatement([], split.withdrawAmount)
    // Zero input mask: the value comes from a vault, not from confidential inputs.
    const balanceProof = await signBalanceProof(crypto, Mask.zero(), outputMask, inputsStatement, outputsStatement)
    const statement = new StealthTransferStatement(inputsStatement, outputsStatement, balanceProof)

    const builder = buildPublicSend(maxEpoch, ownerPkHex, split.withdrawAmount, statement, declaredInputs)
    const unsigned = await resolveTransaction(provider, builder.buildUnsignedTransaction())
    const signed = await signTransaction([wallet], dryRun ? { ...unsigned, dry_run: true } : unsigned)
    return { envelope: sealTransaction(signed), split }
  }

  log('Estimating network fee…')
  const probe = await buildEnvelope(PUBLIC_SEND_FEE_RESERVE, true)
  const cost = await dryRunFee(INDEXER_URL, probe.envelope)
  const fee = withFeeMargin(cost)

  // ── THE PROBE→REAL FEE GUARD ──
  //
  // This path's OUTPUT COUNT is invariant — one stealth output, always — so it cannot suffer the
  // shape divergence that rejected a MAX send. What it can suffer is a withdraw larger than the one
  // simulated: `withdrawAmount` is `amount + fee`, so a fee above the reservation asks the vault
  // for more than the dry run ever tried, and if the balance does not stretch it fails on-chain
  // AFTER the user has confirmed. Refused here, where nothing has been sent.
  if (fee > PUBLIC_SEND_FEE_RESERVE) {
    throw new Error(
      `The network fee (${fee} µtTARI) exceeds the ${PUBLIC_SEND_FEE_RESERVE} µtTARI this payment reserved for it. ` +
      `Fees have risen — try again, or send a smaller amount.`,
    )
  }

  log('Building…')
  const real = await buildEnvelope(fee, false)

  return {
    feeMicrotari: fee,
    recipientAmount: real.split.recipientAmount,
    withdrawAmount: real.split.withdrawAmount,
    submit: async (onSubmitProgress?: (msg: string) => void) => {
      const slog = (m: string) => onSubmitProgress?.(m)
      slog('Submitting…')
      const sub = await provider.submitTransaction(real.envelope)
      const txId = sub.transaction_id as string

      slog('Confirming on-chain…')
      const { outcome, accountAddress: confirmedAccount } = await pollOutcome(txId, ownerPkHex)
      provider.stopWatcher?.()

      // The free capture: this runs CreateAccount, so a wallet that never stored its address gets
      // one here. saveAccountAddress is first-write-wins, so a repeat is a no-op.
      if (confirmedAccount) saveAccountAddress(ownerAddress, confirmedAccount)

      return {
        txId,
        outcome,
        recipientAmount: real.split.recipientAmount,
        feeMicrotari: fee,
        withdrawAmount: real.split.withdrawAmount,
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
