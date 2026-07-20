/**
 * Browser-side confidential stealth send.
 * Ported from tarijs-reference/examples/node/src/stealth/confidential-send.ts
 *
 * Proven architecture: tx 836369ed… committed on Esmeralda 2026-07-19.
 * One UTXO → recipient + change + fee, all inside fee_instructions (single StealthTransfer).
 * No revealed balance, no account component, no second UTXO.
 */

import {
  OotleWallet,
  Network,
  TARI_RESOURCE_ADDRESS,
  StealthInput,
  StealthTransferStatement,
  TransactionBuilder,
  WasmStealthCrypto,
  createOutput,
  decryptOwnedUtxo,
  generateSealKeypair,
  resolveTransaction,
  sealTransaction,
  serializeUnsignedTx,
  signBalanceProof,
  signTransaction,
  stealthTransferInstruction,
  stealthUtxoSubstateId,
  type Signer,
  type Mask,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'
const RESOURCE_HEX = TARI_RESOURCE_ADDRESS.replace(/^resource_/, '')
const PAGE_SIZE = 200

export const MAX_FEE = 10_000n   // 0.01 tTARI ceiling; actual ~1 006 µtTARI
const MICROTARI_PER_TARI = 1_000_000n

export type SendOutcome = 'Commit' | 'Reject' | 'Timeout'
export interface SendResult { txId: string; outcome: SendOutcome }

export interface SendParams {
  recipient: string
  amountMicrotari: bigint
  memo?: string
  payRef?: string
  onProgress?: (msg: string) => void
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fromHex(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16)
  return bytes
}

type SignedTxArr = Awaited<ReturnType<Signer['signTransaction']>>

class StaticSigner implements Signer {
  private sigs: SignedTxArr
  constructor(sigs: SignedTxArr) { this.sigs = sigs }
  async getAddress() { return '' }
  async getPublicKey() { return new Uint8Array(32) }
  async signTransaction(_t: Parameters<Signer['signTransaction']>[0], _k: Uint8Array): Promise<SignedTxArr> {
    return this.sigs
  }
}

interface OwnedUtxo {
  substateId: string
  commitment: Uint8Array
  nonce: Uint8Array
  value: bigint
  mask: Mask
}

async function scanUtxos(crypto: WasmStealthCrypto, viewSecret: Uint8Array): Promise<OwnedUtxo[]> {
  const owned: OwnedUtxo[] = []
  let offset = 0

  while (true) {
    const url = `${INDEXER_URL}/utxos?resource_address=${RESOURCE_HEX}&limit=${PAGE_SIZE}&offset=${offset}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`UTXO scan HTTP ${res.status}`)
    const body = await res.json() as { utxos?: [string, unknown][] } | [string, unknown][]
    const page = Array.isArray(body) ? body : (body as { utxos?: [string, unknown][] }).utxos ?? []
    if (page.length === 0) break

    for (const [commitmentHex, utxoBody] of page) {
      const substateId = `utxo_${RESOURCE_HEX}_${commitmentHex}`
      const fakeResponse = { version: 0, verified: false, substate: { Utxo: utxoBody } }
      const decrypted = await decryptOwnedUtxo(
        crypto,
        viewSecret,
        fakeResponse as Parameters<typeof decryptOwnedUtxo>[2],
        substateId,
      )
      if (decrypted !== null) {
        const output = (utxoBody as { output?: { output?: { public_nonce?: string } } })?.output?.output
        if (!output?.public_nonce) continue
        owned.push({
          substateId,
          commitment: fromHex(commitmentHex),
          nonce: fromHex(output.public_nonce),
          value: decrypted.value,
          mask: decrypted.mask,
        })
      }
    }

    if (page.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return owned
}

async function pollOutcome(txId: string): Promise<SendOutcome> {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>(r => setTimeout(r, 5_000))
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

// ── main export ───────────────────────────────────────────────────────────────

export async function sendConfidential(
  wallet: SecretKeyWallet,
  senderAddress: string,
  params: SendParams,
): Promise<SendResult> {
  const { recipient, amountMicrotari, memo, payRef, onProgress } = params
  const log = (msg: string) => onProgress?.(msg)

  // Connect indexer first — lets ootle-secret-key-wallet __tla tick before wallet ops
  log('Connecting to indexer…')
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })

  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const viewSecret = await wallet.getViewSecret()

  log('Scanning for your UTXOs…')
  const utxos = await scanUtxos(crypto, viewSecret)
  if (utxos.length === 0) throw new Error('No owned UTXOs found. Your wallet may need a balance from the faucet.')

  const needed = amountMicrotari + MAX_FEE
  const candidates = utxos.filter(u => u.value > needed).sort((a, b) => Number(a.value - b.value))
  if (candidates.length === 0) {
    const total = utxos.reduce((s, u) => s + u.value, 0n)
    throw new Error(
      `Insufficient funds. Need ${needed} µtTARI (amount + fee), wallet has ${total} µtTARI ` +
      `across ${utxos.length} UTXO(s). Each single UTXO must exceed the send amount plus the fee.`
    )
  }

  const utxo = candidates[0]!
  const changeAmount = utxo.value - amountMicrotari - MAX_FEE
  log(`Using UTXO (value: ${(Number(utxo.value) / Number(MICROTARI_PER_TARI)).toFixed(6)} TARI)`)

  // Build outputs
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

  log('Building transaction…')
  const { statement: outsStmt, outputMask } = await crypto.generateOutputsStatement(
    [
      recipientOutput,
      createOutput({ destination: senderAddress, amount: changeAmount, resourceAddress: TARI_RESOURCE_ADDRESS }),
    ],
    MAX_FEE,
  )

  const insStmt = await crypto.buildInputsStatement([new StealthInput(utxo.commitment)], 0n)
  const proof   = await signBalanceProof(crypto, utxo.mask, outputMask, insStmt, outsStmt)
  const stmt    = new StealthTransferStatement(insStmt, outsStmt, proof)

  const builder = new TransactionBuilder(Network.Esmeralda)
  builder.addFeeInstruction(
    stealthTransferInstruction(
      { resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: null, statement: stmt },
      () => ({ id: 0, offset: null }),
    ),
  )
  builder.addFeeInstruction({ PutLastInstructionOutputOnWorkspace: { key: 0 } })
  builder.addFeeInstruction({ PayFeeFromBucket: { bucket: { id: 0, offset: null } } })
  builder.addInput({ substate_id: stealthUtxoSubstateId(TARI_RESOURCE_ADDRESS, utxo.commitment), version: null })

  const unsignedTx   = await resolveTransaction(provider, builder.buildUnsignedTransaction())
  const sealKP       = generateSealKeypair()
  const unsignedJson = serializeUnsignedTx(unsignedTx)
  const oneTimeSig   = await wallet.addStealthSignature(unsignedJson, utxo.nonce, sealKP.public_key, { crypto })

  const ootleWallet = new OotleWallet()
    .registerKeyProvider(senderAddress, wallet)
    .setDefaultSigner(senderAddress)

  const signed   = await signTransaction([ootleWallet, new StaticSigner([oneTimeSig])], unsignedTx, sealKP)
  const envelope = sealTransaction(signed)

  log('Submitting transaction…')
  const sub = await provider.submitTransaction(envelope)
  const txId = sub.transaction_id as string
  log(`Submitted — waiting for confirmation (up to 30s)…`)

  const outcome = await pollOutcome(txId)
  provider.stopWatcher?.()

  return { txId, outcome }
}

export function tariToMicrotari(tari: number): bigint {
  return BigInt(Math.round(tari * Number(MICROTARI_PER_TARI)))
}
