// BURN — lock TARI in the Caravel Burn Wallet, forever. From the public balance or from private funds.
//
// ── TWO PATHS, EACH A PROVEN ONE WITH ITS DESTINATION SWAPPED ─────────────────
//
// Nothing here is a new way of spending. Each path is an existing, live-proven transaction shape
// whose output has been pointed at the burn wallet's `deposit(bucket)` instead:
//
//   PUBLIC   publicSend.ts, minus its stealth output:
//
//     createAccount(ownerPk)                       → 'account'  [reuses the existing account]
//     callMethod(account, 'pay_fee', [budget])     the fee, from the vault — REFUNDED down to cost
//     callMethod(account, 'withdraw', [TARI, n])   → 'burn'
//     callMethod(burn_wallet, 'deposit', ['burn']) locked forever
//
//   PRIVATE  confidentialSend.ts, with the recipient's output replaced by a revealed bucket:
//
//     StealthTransfer { revealedInputBucket: null } → bucket 0, revealed `n + fee`, change → us
//     TakeFromBucket(bucket 0, n)                   → bucket 1
//     callMethod(burn_wallet, 'deposit', [bucket 1]) locked forever
//     PayFeeFromBucket(bucket 0)                    what is left in bucket 0: exactly the fee
//
// Everything that made those paths safe comes along unchanged: the dry run that refuses anything
// but a clean Accept, the exact fee, the confirm-time re-check (crypto/quote), the submit guard,
// the coin reservation and spend record on the private side, and the account-input rule on the
// public one.
//
// ── THE PRIVATE BURN IS NOT TIED TO THIS WALLET ──────────────────────────────
//
// As for a private send (4e55d3b): the transaction is signed ONLY by the spent outputs' one-time
// spend keys, and the revealed bucket's receiver is the first of those keys. The wallet's owner key
// neither signs nor receives, so nothing on chain links a private burn to the account. The change
// output comes back to this wallet's stealth address, like any change.
//
// The public burn is account-tied by nature — it withdraws from a named account, readably — and is
// labelled as such everywhere it is offered.
//
// ── EVERYTHING IS IN THE FEE INTENT ──────────────────────────────────────────
//
// So a fee that turns out short is a FREE reject (see feeProbe's exactFee): nothing is persisted and
// nothing is taken. There is no main intent that could commit a fee and burn nothing.

import {
  Network,
  StealthInput,
  StealthTransferStatement,
  TARI_RESOURCE_ADDRESS,
  TransactionBuilder,
  WasmStealthCrypto,
  amountLiteral,
  createOutput,
  generateSealKeypair,
  microTariString,
  resolveTransaction,
  resourceAddressLiteral,
  sealTransaction,
  serializeUnsignedTx,
  signBalanceProof,
  signTransaction,
  stealthTransferInstruction,
  stealthUtxoSubstateId,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { BURN_WALLET_COMPONENT, BURN_WALLET_VAULT } from './burnWallet'
import { feesPaid } from './conceal'
import { MAX_FEE, assertStealthSendSplit, planStealthSend, probeFeeFor } from './confidentialSend'
import { loadAccountAddress } from './accountStore'
import { loadSelectionExcludedIds, newReservationToken, releaseCoins, reserveCoins } from './coinReservations'
import { nextMaxEpoch } from './epoch'
import { dryRunFee, exactFee, priceAtBudget, simulateAtShownFee, simulateFee, type FeeSimulation } from './feeProbe'
import { awaitFinality } from './finality'
import { INDEXER_URL } from './indexerConfig'
import { RETRYING_MESSAGE } from './indexerRetry'
import { readOutputSubstateIds } from './outputIds'
import { PUBLIC_SEND_FEE_RESERVE } from './publicSend'
import { confirmer } from './quote'
import { markLocked, promoteToSpent, release } from './spentOutputs'
import { StaticSigner, scanOwnedUtxos, selectStealthInputs } from './stealthUtxos'
import { resolveAccountInputs } from './substates'
import { inputsStillUnspent, submitOnce, versionsUnchanged } from './submitGuard'

/** Smallest burn, from either balance (µtTARI, 0.1 TARI) — the floor every other amount field uses. */
export const MIN_BURN_MICROTARI = 100_000n

export type BurnSource = 'public' | 'private'
export type BurnOutcome = 'Commit' | 'Reject' | 'Timeout'

export interface BurnResult {
  txId: string
  outcome: BurnOutcome
  /** The network's reason, on a Reject. */
  reason?: string
  /** What was locked in the burn wallet. */
  amountMicrotari: bigint
  /** What was charged, read from the receipt when there is one. */
  feeMicrotari: bigint
  /** Change outputs back to us — `[]` on a public burn, which creates none. */
  selfOutputIds: string[] | null
  /** Stealth outputs consumed — `[]` on a public burn, which spends the vault. */
  spentInputIds: string[]
}

/** A priced, built, signed burn — everything except pressing burn. The same contract every move has. */
export interface PreparedBurn {
  source: BurnSource
  /** What is burned: exactly the amount asked for. */
  amountMicrotari: bigint
  /** The exact fee, from the dry run — what review shows and what is charged. */
  feeMicrotari: bigint
  simulate: (feeMicrotari?: bigint) => Promise<FeeSimulation>
  preparedAt: number
  /** Quote age, inputs unchanged, and a dry run at the exact fee. Throws QuoteChanged — nothing sent. */
  confirm: () => Promise<void>
  release: () => void
  submit: (onProgress?: (msg: string) => void) => Promise<BurnResult>
}

export interface BurnParams {
  amountMicrotari: bigint
  onProgress?: (msg: string) => void
}

function assertAmount(amountMicrotari: bigint) {
  if (amountMicrotari < MIN_BURN_MICROTARI) {
    throw new Error(`The smallest amount you can burn is ${MIN_BURN_MICROTARI} µtTARI (0.10 TARI).`)
  }
}

/** The burn wallet and its vault, declared by both paths — the deposit writes to both. */
const BURN_WALLET_INPUTS = [BURN_WALLET_COMPONENT, BURN_WALLET_VAULT]

// ══ PUBLIC ═══════════════════════════════════════════════════════════════════

/**
 * Price and build a burn from the public balance (the account vault).
 *
 * publicSend's discipline throughout: the account address is a hard prerequisite, its component and
 * vaults are declared exactly when it exists (resolveAccountInputs), the probe reserves
 * PUBLIC_SEND_FEE_RESERVE, and `pay_fee` offers the cost plus a margin the engine refunds.
 */
export async function preparePublicBurn(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  { amountMicrotari, onProgress }: BurnParams,
): Promise<PreparedBurn> {
  const log = (m: string) => onProgress?.(m)
  assertAmount(amountMicrotari)

  const accountAddress = loadAccountAddress(ownerAddress)
  if (!accountAddress) {
    throw new Error('This wallet’s account could not be identified, so its public balance can’t be spent. Check your connection and try again.')
  }

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const ownerPkHex = toHex(await wallet.getPublicKey())
  const { exists, declaredInputs } = await resolveAccountInputs(provider, accountAddress)
  // A burn spends the vault, so there has to be one. (A send would mint the account; a burn from an
  // account that does not exist has nothing to burn.)
  if (!exists) throw new Error('This wallet has no public balance to burn from.')
  const inputs = [...declaredInputs, ...BURN_WALLET_INPUTS]
  const maxEpoch = await nextMaxEpoch(provider)

  async function buildEnvelope(feeBudget: bigint, dryRun: boolean) {
    const builder = new TransactionBuilder(Network.Esmeralda, maxEpoch)
      .withFeeInstructionsBuilder((b) =>
        b
          .createAccount(ownerPkHex)
          .saveVar('account')
          .callMethod({ fromWorkspace: 'account', methodName: 'pay_fee' }, [amountLiteral(feeBudget)])
          .callMethod({ fromWorkspace: 'account', methodName: 'withdraw' }, [
            resourceAddressLiteral(TARI_RESOURCE_ADDRESS),
            amountLiteral(amountMicrotari),
          ])
          .saveVar('burn')
          .callMethod({ componentAddress: BURN_WALLET_COMPONENT, methodName: 'deposit' }, [{ Workspace: 'burn' }]),
      )
      .withInputs(inputs.map(substate_id => ({ substate_id, version: null })))
    const unsigned = await resolveTransaction(provider, builder.buildUnsignedTransaction())
    const signed = await signTransaction([wallet], dryRun ? { ...unsigned, dry_run: true } : unsigned)
    return sealTransaction(signed)
  }

  log('Estimating network fee…')
  // The fee shown is the cost MEASURED AT THE REAL BUDGET (feeProbe.priceAtBudget): a small public
  // balance crosses a storage-size boundary between the 50,000 probe budget and the real one.
  const { fee, budget } = await priceAtBudget(
    async feeBudget => dryRunFee(INDEXER_URL, await buildEnvelope(feeBudget, true), { onBusyRetry: () => log(RETRYING_MESSAGE) }),
    { reserve: PUBLIC_SEND_FEE_RESERVE },
  )

  log('Building…')
  const real = await buildEnvelope(budget, false)
  const preparedAt = Date.now()
  const simulate = async (feeBudget: bigint = budget) => simulateFee(INDEXER_URL, await buildEnvelope(feeBudget, true), { fee: feeBudget })
  const vaults = declaredInputs.filter(id => id.startsWith('vault_'))
  // Held to the FEE SHOWN: a final transaction that would cost anything else re-prices first.
  const check = confirmer({
    preparedAt,
    simulate: async () => simulateAtShownFee(INDEXER_URL, await buildEnvelope(budget, true), { budget, shownFee: fee }),
    inputs: { landed: await versionsUnchanged(vaults) },
  })

  return {
    source: 'public',
    amountMicrotari,
    feeMicrotari: fee,
    simulate,
    preparedAt,
    confirm: check.confirm,
    release: () => {},
    submit: async (onSubmitProgress?: (msg: string) => void) => {
      const slog = (m: string) => onSubmitProgress?.(m)
      slog('Checking the fee…')
      await check.ensureConfirmed()
      slog('Submitting…')
      const sub = await submitOnce(() => provider.submitTransaction(real), {
        landed: await versionsUnchanged(vaults),
        onBusyRetry: () => slog(RETRYING_MESSAGE),
      })
      const txId = sub.transaction_id as string
      slog('Confirming on-chain…')
      const { outcome, reason, body } = await awaitFinality(provider, txId)
      provider.stopWatcher?.()
      return {
        txId, outcome, reason, amountMicrotari,
        feeMicrotari: feesPaid(body) ?? fee,
        selfOutputIds: [],
        spentInputIds: [],
      }
    },
  }
}

// ══ PRIVATE ══════════════════════════════════════════════════════════════════

/**
 * Price and build a burn from private funds.
 *
 * confidentialSend's discipline throughout: selection excludes spent and reserved coins, is made
 * once against amount + MAX_FEE and pinned, the probe keeps the real build's shape (probeFeeFor —
 * one change output either way), the fee is exact, and the coins are reserved until submitted.
 */
export async function preparePrivateBurn(
  wallet: SecretKeyWallet,
  senderAddress: string,
  { amountMicrotari, onProgress }: BurnParams,
): Promise<PreparedBurn> {
  const log = (m: string) => onProgress?.(m)
  assertAmount(amountMicrotari)

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const crypto = new WasmStealthCrypto(Network.Esmeralda)

  log('Finding your private funds…')
  const utxos = await scanOwnedUtxos(crypto, await wallet.getViewSecret(), {
    excluded: loadSelectionExcludedIds(senderAddress),
    walletAddress: senderAddress,
  })
  if (utxos.length === 0) throw new Error('No private funds found to burn.')
  const selection = selectStealthInputs(utxos, amountMicrotari + MAX_FEE)
  const spentInputIds = selection.inputs.map(u => u.substateId)

  // The revealed bucket's receiver: the first input's one-time key, which signs anyway. Never the
  // owner key — see the header.
  const firstKey = selection.inputs.find(u => u.spendKey)?.spendKey
  if (!firstKey) throw new Error('Could not read the spend key of the funds being burned. Refresh your balance and try again.')
  const receiver: Uint8Array = firstKey
  const receiverHex = toHex(receiver)

  const maxEpoch = await nextMaxEpoch(provider)

  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    const split = planStealthSend(amountMicrotari, feeMicrotari, selection.total)
    assertStealthSendSplit(split)

    // The only stealth output is change back to us; the burned amount and the fee leave revealed.
    const outputs = split.changeAmount > 0n
      ? [createOutput({ destination: senderAddress, amount: split.changeAmount, resourceAddress: TARI_RESOURCE_ADDRESS })]
      : []
    const { statement: outsStmt, outputMask } = await crypto.generateOutputsStatement(
      outputs,
      { amount: amountMicrotari + feeMicrotari, receiver },
    )
    const selfOutputIds = readOutputSubstateIds(outsStmt) ?? undefined
    const insStmt = await crypto.buildInputsStatement(selection.inputs.map(u => new StealthInput(u.commitment)), 0n)
    const inputMask = await crypto.aggregateInputMasks(selection.inputs.map(u => u.mask))
    const proof = await signBalanceProof(crypto, inputMask, outputMask, insStmt, outsStmt)
    const stmt = new StealthTransferStatement(insStmt, outsStmt, proof)

    // Bucket 0 holds `amount + fee`. TakeFromBucket moves exactly `amount` into bucket 1 for the
    // deposit; what is left in bucket 0 is, by construction, exactly the fee.
    const builder = new TransactionBuilder(Network.Esmeralda, maxEpoch)
    builder.addFeeInstruction(stealthTransferInstruction(
      { resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: null, statement: stmt },
      () => ({ id: 0, offset: null }),
    ))
    builder.addFeeInstruction({ PutLastInstructionOutputOnWorkspace: { key: 0 } })
    builder.addFeeInstruction({
      TakeFromBucket: { input_bucket: { id: 0, offset: null }, amount: microTariString(amountMicrotari), output_bucket: 1 },
    })
    builder.addFeeInstruction({
      CallMethod: {
        call: { Address: BURN_WALLET_COMPONENT },
        method: 'deposit',
        args: [{ Workspace: { id: 1, offset: null } }],
      },
    })
    builder.addFeeInstruction({ PayFeeFromBucket: { bucket: { id: 0, offset: null } } })
    for (const id of BURN_WALLET_INPUTS) builder.addInput({ substate_id: id, version: null })
    for (const u of selection.inputs) {
      builder.addInput({ substate_id: stealthUtxoSubstateId(TARI_RESOURCE_ADDRESS, u.commitment), version: null })
    }

    const unsignedTx = await resolveTransaction(provider, builder.buildUnsignedTransaction())
    const sealKP = generateSealKeypair()
    const unsignedJson = serializeUnsignedTx(unsignedTx)
    const oneTimeSigs = []
    for (const u of selection.inputs) {
      oneTimeSigs.push(await wallet.addStealthSignature(unsignedJson, u.nonce, sealKP.public_key, { crypto }))
    }
    if (!oneTimeSigs.some(sig => String(sig.public_key).toLowerCase() === receiverHex)) {
      throw new Error('The burn’s receiver is not among its signers. Nothing was sent.')
    }
    const toSign = dryRun ? { ...unsignedTx, dry_run: true } : unsignedTx
    const signed = await signTransaction([new StaticSigner(oneTimeSigs)], toSign, sealKP)
    return { envelope: sealTransaction(signed), selfOutputIds }
  }

  log('Estimating network fee…')
  const reserved = probeFeeFor(selection.total, amountMicrotari)
  const cost = await dryRunFee(INDEXER_URL, (await buildEnvelope(reserved, true)).envelope, { onBusyRetry: () => log(RETRYING_MESSAGE) })
  const fee = exactFee(cost)
  if (fee > reserved) {
    throw new Error(`The network fee (${fee} µtTARI) exceeds the ${MAX_FEE} µtTARI ceiling. Fees have risen — try again later.`)
  }

  const real = await buildEnvelope(fee, false)
  const preparedAt = Date.now()
  const simulate = async (feeMicrotari: bigint = fee) =>
    simulateFee(INDEXER_URL, (await buildEnvelope(feeMicrotari, true)).envelope, { fee: feeMicrotari })
  const check = confirmer({ preparedAt, simulate: () => simulate(fee), inputs: { ids: spentInputIds } })

  const reservation = newReservationToken()
  if (!reserveCoins(senderAddress, spentInputIds, reservation)) {
    releaseCoins(senderAddress, reservation)
    throw new Error('Another payment being prepared is using some of these funds. Try again in a moment.')
  }

  return {
    source: 'private',
    amountMicrotari,
    feeMicrotari: fee,
    simulate,
    preparedAt,
    confirm: check.confirm,
    release: () => releaseCoins(senderAddress, reservation),
    submit: async (onSubmitProgress?: (msg: string) => void) => {
      const slog = (m: string) => onSubmitProgress?.(m)
      slog('Checking the fee…')
      await check.ensureConfirmed()
      slog('Submitting…')
      const sub = await submitOnce(() => provider.submitTransaction(real.envelope), {
        landed: inputsStillUnspent(spentInputIds),
        onBusyRetry: () => slog(RETRYING_MESSAGE),
      })
      const txId = sub.transaction_id as string
      // The spend record, resolved in the function that submits — see confidentialSend.
      markLocked(senderAddress, spentInputIds, txId)
      releaseCoins(senderAddress, reservation)
      slog('Confirming on-chain…')
      const { outcome, reason, body } = await awaitFinality(provider, txId)
      provider.stopWatcher?.()
      if (outcome === 'Commit') promoteToSpent(senderAddress, txId)
      else if (outcome === 'Reject') release(senderAddress, txId)
      return {
        txId, outcome, reason, amountMicrotari,
        feeMicrotari: feesPaid(body) ?? fee,
        selfOutputIds: real.selfOutputIds ?? null,
        spentInputIds,
      }
    },
  }
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
