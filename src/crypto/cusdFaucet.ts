// Browser-side claim from the cUSD faucet, signed by the wallet's FAUCET key. The TARI faucet's
// pipeline (crypto/faucet) applied to a second resource — build → signTransaction → sealTransaction
// → indexer submit, no daemon — reused rather than reimplemented, so the two cannot drift.
//
// ── THE ONE DIFFERENCE FROM THE TARI CLAIM ───────────────────────────────────
//
// The TARI claim pays its own fee: the payout is tTARI, so a slice of it covers the fee and a
// zero-balance wallet can claim. A cUSD claim pays out cUSD, which cannot pay a tTARI fee — so the
// FEE COMES FROM THE WALLET'S OWN tTARI, and the whole 10,000 cUSD lands.
//
//     claim(faucetPk)                              → 'payout'       (10,000 cUSD)
//     StealthTransfer(revealed input: 'payout')    → the whole payout to one private cUSD output
//     <a tTARI coin spent in the fee intent, its revealed slice pays the fee>
//
// A wallet with no tTARI therefore cannot claim cUSD, and the UI says so before offering it. This is
// the same split the Trade client uses (caravel-trade scripts/live.ts `claim`), proven live there.
//
// ── WHO MAY CLAIM, ONCE ──────────────────────────────────────────────────────
//
// `claim(claimer)` requires the transaction to be signed by `claimer` and mints-and-burns a receipt
// NFT keyed by `claimer`, so each key claims once ever. Signed by the wallet's faucet key (the TARI
// claim's key too), which keeps the claim and its private output off the public account — the same
// reasoning as crypto/faucet. A wallet that already claimed sees "already claimed", found by the
// receipt read or by the pricing dry run's "Duplicate NFT token id".

import { inputsStillUnspent, substateStillAbsent, submitOnce } from './submitGuard'
import { markLocked, settleLocks } from './spentOutputs'
import { RETRYING_MESSAGE } from './indexerRetry'
import {
  TransactionBuilder, WasmStealthCrypto, Network, Mask, TARI_RESOURCE_ADDRESS,
  StealthInput, StealthTransferStatement, createOutput, generateSealKeypair, publicKeyLiteral,
  sealTransaction, serializeUnsignedTx, signBalanceProof, signTransaction, stealthTransferInstruction,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { CUSD_ASSET } from './assets'
import {
  CUSD_CLAIM_UNITS, CUSD_FAUCET_COMPONENT_ADDRESS, CUSD_FAUCET_RECEIPTS_RESOURCE_ADDRESS,
  CUSD_FAUCET_VAULT_ADDRESS, cusdFaucetReceiptId,
} from './cusdFaucetConfig'
import { feesPaid } from './conceal'
import { nextMaxEpoch } from './epoch'
import { awaitFinality } from './finality'
import { dryRunFee, exactFee, simulateFee, type FeeSimulation } from './feeProbe'
import { INDEXER_URL } from './indexerConfig'
import { readOutputSubstateIds } from './outputIds'
import { confirmer } from './quote'
import { StaticSigner, scanOwnedUtxos, selectStealthInputs } from './stealthUtxos'
import { verifiedRead } from './cusdScan'

export { CUSD_CLAIM_UNITS }

/** Fee reserved for the DRY RUN only — never submitted. Comfortably above the true cost (an
 *  under-funded probe aborts early) and far under any wallet's balance. A dry run charges nothing. */
export const CUSD_FEE_PROBE_MICROTARI = 50_000n
/** The tTARI a wallet must hold to afford the fee. Below this the claim is offered but blocked. */
export const CUSD_CLAIM_FEE_CEILING = 100_000n

export type CusdClaimOutcome = 'Commit' | 'Reject' | 'Timeout'
export interface CusdClaimResult {
  txId: string
  outcome: CusdClaimOutcome
  reason?: string
  /** cUSD base units deposited if committed (the whole claim; the fee came from tTARI). */
  units: bigint
  /** tTARI fee this claim paid. */
  feeMicrotari?: bigint
  /** The cUSD output's substate id — recorded in the cUSD store so the cUSD scan can recover it. */
  cusdOutputIds?: string[]
  /** The tTARI change output — the journal's `selfOutputIds`, recovered by the TARI scan. */
  tariChangeOutputIds?: string[]
  /** The tTARI fee coins this claim spent — the journal's `spentInputIds`, and what to exclude. */
  spentInputIds: string[]
}

export type CusdClaimRefusal = 'already-claimed' | 'empty' | 'unsigned' | 'no-tari'

export function classifyCusdClaimFailure(reason: string): CusdClaimRefusal | null {
  if (/Duplicate NFT token id/i.test(reason)) return 'already-claimed'
  if (/faucet is empty/i.test(reason)) return 'empty'
  if (/out of scope signer badge/i.test(reason)) return 'unsigned'
  return null
}

export function cusdClaimRefusalMessage(r: CusdClaimRefusal): string {
  switch (r) {
    case 'already-claimed': return 'This wallet has already claimed its test cUSD.'
    case 'empty': return 'The cUSD faucet is empty right now. Check back soon.'
    case 'unsigned': return 'The claim could not be signed correctly. Nothing was taken.'
    case 'no-tari': return 'You need a little tTARI to cover the network fee before claiming cUSD. Claim tTARI first.'
  }
}

export class CusdClaimRefused extends Error {
  readonly refusal: CusdClaimRefusal
  constructor(refusal: CusdClaimRefusal) {
    super(cusdClaimRefusalMessage(refusal))
    this.name = 'CusdClaimRefused'
    this.refusal = refusal
  }
}

function hexOf(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
/** Has this wallet's faucet key already claimed cUSD? Read from the receipt, believed only verified. */
export async function readCusdClaimed(claimerPkHex: string, read = verifiedRead): Promise<'claimed' | 'open' | 'unknown'> {
  const r = await read(`/substates/${cusdFaucetReceiptId(claimerPkHex)}`)
  if (r.kind === 'verified') return 'claimed'
  if (r.kind === 'absent') return 'open'
  return 'unknown'
}

export interface PreparedCusdClaim {
  /** cUSD base units the claim pays (a template constant). */
  claimUnits: bigint
  /** tTARI the fee will cost, measured by the dry run; no margin. */
  fee: bigint
  preparedAt: number
  simulate: () => Promise<FeeSimulation>
  confirm: () => Promise<void>
  submit: (onProgress?: (msg: string) => void) => Promise<CusdClaimResult>
}

/**
 * Everything up to submission: the claimed check, input selection for the fee, the dry run, the fee.
 * Nothing is submitted. Throws CusdClaimRefused for a faucet refusal or a wallet with no tTARI.
 */
export async function prepareCusdClaim(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  faucetKey: SecretKeyWallet,
  onProgress?: (msg: string) => void,
): Promise<PreparedCusdClaim> {
  const log = (m: string) => onProgress?.(m)
  const claimerPk = await faucetKey.getPublicKey()
  const claimerPkHex = hexOf(claimerPk)

  log('Checking the faucet…')
  const claimed = await readCusdClaimed(claimerPkHex)
  if (claimed === 'claimed') throw new CusdClaimRefused('already-claimed')

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const maxEpoch = await nextMaxEpoch(provider)

  // The fee is paid from the wallet's own tTARI — the payout is cUSD and cannot cover it.
  log('Finding tTARI for the fee…')
  const tariCoins = await scanOwnedUtxos(crypto, await wallet.getViewSecret(), { walletAddress: ownerAddress })
  if (tariCoins.length === 0) throw new CusdClaimRefused('no-tari')
  // One coin that covers the fee probe; its one-time key signs its own spend and receives the change.
  let selection: ReturnType<typeof selectStealthInputs<typeof tariCoins[number]>>
  try {
    selection = selectStealthInputs(tariCoins, CUSD_FEE_PROBE_MICROTARI)
  } catch { throw new CusdClaimRefused('no-tari') }
  const feeCoins = selection.inputs
  const feeReceiver = feeCoins.find(u => u.spendKey)?.spendKey
  if (!feeReceiver) throw new Error('Could not read the spend key of the tTARI covering the fee. Refresh your balance and try again.')

  // Rebuilt for each fee: both statements commit to it (the cUSD payout's balance, the tTARI fee's).
  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    // The cUSD payout → one private cUSD output of the whole claim. No fee taken from it.
    const { statement: cusdOut, outputMask: cusdMask } = await crypto.generateOutputsStatement(
      [createOutput({ destination: ownerAddress, amount: CUSD_CLAIM_UNITS, resourceAddress: CUSD_ASSET.resource })],
      null,
    )
    const cusdIn = await crypto.buildInputsStatement([], CUSD_CLAIM_UNITS)
    const cusdProof = await signBalanceProof(crypto, Mask.zero(), cusdMask, cusdIn, cusdOut)
    const cusdStatement = new StealthTransferStatement(cusdIn, cusdOut, cusdProof)

    // The tTARI fee intent: spend the selected coin, reveal `fee`, keep the rest as change.
    const feeTotal = selection.total
    const change = feeTotal - feeMicrotari
    const feeChangeOutputs = change > 0n
      ? [createOutput({ destination: ownerAddress, amount: change, resourceAddress: TARI_RESOURCE_ADDRESS })]
      : []
    const { statement: feeOut, outputMask: feeMask } = await crypto.generateOutputsStatement(
      feeChangeOutputs, { amount: feeMicrotari, receiver: feeReceiver! },
    )
    const feeIn = await crypto.buildInputsStatement(feeCoins.map(u => new StealthInput(u.commitment)), 0n)
    const feeInMask = await crypto.aggregateInputMasks(feeCoins.map(u => u.mask))
    const feeProof = await signBalanceProof(crypto, feeInMask, feeMask, feeIn, feeOut)
    const feeStatement = new StealthTransferStatement(feeIn, feeOut, feeProof)

    const builder = new TransactionBuilder(Network.Esmeralda, maxEpoch)
    // FEE INTENT: the tTARI coin pays the network fee.
    builder.addFeeInstruction(stealthTransferInstruction(
      { resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: null, statement: feeStatement },
      () => ({ id: 0, offset: null }),
    ))
    builder.addFeeInstruction({ PutLastInstructionOutputOnWorkspace: { key: 0 } })
    builder.addFeeInstruction({ PayFeeFromBucket: { bucket: { id: 0, offset: null } } })
    // MAIN INTENT: claim the cUSD and turn the payout into our private output.
    builder.addInstruction({ CallMethod: { call: { Address: CUSD_FAUCET_COMPONENT_ADDRESS }, method: 'claim', args: [publicKeyLiteral(claimerPk)] } })
    builder.addInstruction({ PutLastInstructionOutputOnWorkspace: { key: 1 } })
    builder.addInstruction(stealthTransferInstruction(
      { resourceAddress: CUSD_ASSET.resource, revealedInputBucket: 'payout', statement: cusdStatement },
      (name) => (name === 'payout' ? { id: 1, offset: null } : { id: 1, offset: null }),
    ))
    builder.withInputs([
      { substate_id: CUSD_FAUCET_COMPONENT_ADDRESS, version: null },
      { substate_id: CUSD_FAUCET_VAULT_ADDRESS, version: null },
      { substate_id: CUSD_FAUCET_RECEIPTS_RESOURCE_ADDRESS, version: null },
      { substate_id: CUSD_ASSET.resource, version: null },
      { substate_id: TARI_RESOURCE_ADDRESS, version: null },
    ])
    for (const u of feeCoins) builder.addInput({ substate_id: u.substateId, version: null })

    const unsigned = builder.buildUnsignedTransaction()
    const seal = generateSealKeypair()
    const json = serializeUnsignedTx(unsigned)
    // The fee coin's one-time spend signatures, computed over the serialised tx + seal key, exactly
    // as burn.ts / confidentialSend.ts do. The faucet key signs the claim; the StaticSigner carries
    // the fee coin's one-time keys.
    const feeSigs = []
    for (const u of feeCoins) feeSigs.push(await wallet.addStealthSignature(json, u.nonce, seal.public_key, { crypto }))
    const toSign = dryRun ? { ...unsigned, dry_run: true } : unsigned
    const signed = await signTransaction([faucetKey, new StaticSigner(feeSigs)], toSign, seal)
    return {
      envelope: sealTransaction(signed),
      // The cUSD output — recorded in the cUSD store, recovered by the cUSD scan. NEVER the journal
      // (its selfOutputIds are read as TARI).
      cusdOutputIds: readOutputSubstateIds(cusdOut) ?? undefined,
      // The tTARI change from the fee coin — a normal TARI output of ours, so the journal and the
      // TARI scan handle it exactly like any other change.
      tariChangeOutputIds: readOutputSubstateIds(feeOut) ?? undefined,
    }
  }

  log('Estimating network fee…')
  let cost: bigint
  try {
    cost = await dryRunFee(INDEXER_URL, (await buildEnvelope(CUSD_FEE_PROBE_MICROTARI, true)).envelope, { onBusyRetry: () => log(RETRYING_MESSAGE) })
  } catch (e) {
    const refusal = classifyCusdClaimFailure(e instanceof Error ? e.message : String(e))
    if (refusal) throw new CusdClaimRefused(refusal)
    throw e
  }
  const fee = exactFee(cost)
  if (fee > selection.total) throw new CusdClaimRefused('no-tari')

  log('Building claim…')
  const real = await buildEnvelope(fee, false)
  const spentInputIds = feeCoins.map(u => u.substateId)
  const preparedAt = Date.now()
  const simulate = async () => simulateFee(INDEXER_URL, (await buildEnvelope(fee, true)).envelope, { fee })
  // The receipt still absent is the claim-specific risk (claimed elsewhere meanwhile). A spent fee
  // coin is caught by the dry-run simulate and the submit guard below, so one check suffices here.
  const check = confirmer({ preparedAt, simulate, inputs: { landed: substateStillAbsent(cusdFaucetReceiptId(claimerPkHex)) } })

  async function submit(onSubmitProgress?: (msg: string) => void): Promise<CusdClaimResult> {
    const slog = (m: string) => (onSubmitProgress ?? onProgress)?.(m)
    slog('Checking the fee…')
    await check.ensureConfirmed()
    slog('Submitting…')
    const sub = await submitOnce(() => provider.submitTransaction(real.envelope as never), {
      landed: inputsStillUnspent(spentInputIds),
      onBusyRetry: () => slog(RETRYING_MESSAGE),
    })
    const txId = sub.transaction_id as string
    // The fee coins are spent the moment this is submitted — hold them out of the TARI balance now,
    // exactly as a send or burn does, so the balance never counts a coin this claim consumed.
    markLocked(ownerAddress, spentInputIds, txId)
    slog('Confirming on-chain…')
    const { outcome, reason, body } = await awaitFinality(provider, txId)
    provider.stopWatcher?.()
    // The claim runs in the MAIN intent, so a Reject can still have committed the fee intent
    // (AcceptFeeRejectRest): its fee coin was spent then and stays spent (spentOutputs.settleLocks).
    settleLocks(ownerAddress, txId, outcome, body)
    return {
      txId, outcome, reason, units: CUSD_CLAIM_UNITS, feeMicrotari: feesPaid(body) ?? fee,
      cusdOutputIds: real.cusdOutputIds, tariChangeOutputIds: real.tariChangeOutputIds, spentInputIds,
    }
  }

  return { claimUnits: CUSD_CLAIM_UNITS, fee, preparedAt, simulate, confirm: check.confirm, submit }
}

/** Claim 10,000 cUSD into `ownerAddress`, signed by `faucetKey`; fee from the wallet's tTARI. */
export async function claimCusd(
  wallet: SecretKeyWallet,
  ownerAddress: string,
  faucetKey: SecretKeyWallet,
  onProgress?: (msg: string) => void,
): Promise<CusdClaimResult> {
  const prepared = await prepareCusdClaim(wallet, ownerAddress, faucetKey, onProgress)
  return prepared.submit()
}
