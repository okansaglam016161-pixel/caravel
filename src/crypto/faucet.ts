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
import { nextMaxEpoch } from './epoch'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'
const STEALTH_FAUCET_FEE = 1_000n

/** The faucet's per-`take` dispense is 1_000_000_000 µtTARI (~1000 tTARI); claim it all minus the fee. */
export const CLAIM_AMOUNT_MICROTARI = 999_999_000n

export type ClaimOutcome = 'Commit' | 'Reject' | 'Timeout'
export interface ClaimResult {
  txId: string
  outcome: ClaimOutcome
  /** The confidential amount deposited (µtTARI) if committed. */
  amount: bigint
}

function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** Poll the indexer for the claim tx's final decision (up to ~32s). */
async function pollOutcome(txId: string): Promise<ClaimOutcome> {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>(r => setTimeout(r, 4_000))
    try {
      const res = await fetch(`${INDEXER_URL}/transactions/${txId}/result`)
      if (!res.ok) continue
      const json = await res.json() as { result?: { Finalized?: { final_decision?: string } } }
      const decision = json.result?.Finalized?.final_decision
      if (decision === 'Commit') return 'Commit'
      if (decision) return 'Reject'
    } catch { /* transient */ }
  }
  return 'Timeout'
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
  const stealthAmount = CLAIM_AMOUNT_MICROTARI
  const revealedInputAmount = stealthAmount + STEALTH_FAUCET_FEE

  log('Connecting…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const ownerPkHex = toHexStr(await wallet.getPublicKey())

  log('Building claim…')
  // revealed_amount = stealth_out + fee, so the on-chain withdraw lines up with the outputs side.
  const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(
    [createOutput({ destination: ownerAddress, amount: stealthAmount, resourceAddress: TARI_RESOURCE_ADDRESS })],
    STEALTH_FAUCET_FEE,
  )
  const inputsStatement = await crypto.buildInputsStatement([], revealedInputAmount)
  const balanceProof = await signBalanceProof(crypto, Mask.zero(), outputMask, inputsStatement, outputsStatement)
  const statement = new StealthTransferStatement(inputsStatement, outputsStatement, balanceProof)

  // 0.39: mandatory validity window — the builder needs the chain tip before it exists. `provider`
  // has been connected since the top of this function, so the read slots in here without reordering
  // anything; it sits AFTER the balance proof above so the window is not spent on local wasm work.
  const maxEpoch = await nextMaxEpoch(provider)

  const builder = new TransactionBuilder(Network.Esmeralda, maxEpoch)
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

  const unsigned = builder.buildUnsignedTransaction()
  log('Signing (in-browser)…')
  const signed = await signTransaction([wallet], unsigned)
  const envelope = sealTransaction(signed)

  log('Submitting…')
  const sub = await provider.submitTransaction(envelope)
  const txId = sub.transaction_id as string

  log('Confirming on-chain…')
  const outcome = await pollOutcome(txId)
  provider.stopWatcher?.()
  return { txId, outcome, amount: stealthAmount }
}
