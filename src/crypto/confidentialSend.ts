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
import { nextMaxEpoch } from './epoch'
import { dryRunFee, withFeeMargin } from './feeProbe'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'
const RESOURCE_HEX = TARI_RESOURCE_ADDRESS.replace(/^resource_/, '')
// The indexer's /utxos endpoint IGNORES `offset` (every offset returns the same set) but HONORS
// `limit`. So we fetch the whole set in one request with a limit safely above it — never paginate by
// offset (that loops forever once the set exceeds one page). 1000 is honored; 5000 is rejected.
const FETCH_LIMIT = 1000

/**
 * CEILING, not the fee. The fee actually paid is discovered per transaction by dry run (see
 * crypto/feeProbe.ts) — 0.39's fee tables moved enough to break every hardcoded figure, so this is
 * now only the upper bound: what the UI shows as "≤ fee", what the balance guards reserve, and what
 * the dry run reserves while pricing. A transaction whose measured fee exceeds it is refused with a
 * clear message rather than submitted to fail on-chain.
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
  // Substate id of the RECIPIENT's output UTXO (specs[0]), derived from the outputs statement.
  // Used by M10.1 payment-linked messages to reference this exact output. Undefined only if the
  // commitment could not be read from the statement.
  recipientUtxoId?: string
  // Actual fee paid (µtTARI), read from the committed tx's fee receipt. Undefined if the poll
  // timed out or the receipt didn't carry it; callers fall back to the estimate.
  feeMicrotari?: bigint
}

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

  // ONE request — the indexer ignores `offset`, so paginating by it would re-fetch the same set
  // forever. Fetch the whole set with a big `limit` instead.
  const url = `${INDEXER_URL}/utxos?resource_address=${RESOURCE_HEX}&limit=${FETCH_LIMIT}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`UTXO scan HTTP ${res.status}`)
  const body = await res.json() as { utxos?: [string, unknown][] } | [string, unknown][]
  const rows = Array.isArray(body) ? body : (body as { utxos?: [string, unknown][] }).utxos ?? []
  // Ceiling guard: a full FETCH_LIMIT means there may be inputs we couldn't see. Send has no balance
  // display, so surface it in the log; an actually-unspendable set still fails with "no suitable UTXO".
  if (rows.length >= FETCH_LIMIT) {
    console.warn(`[Caravel] confidential-send UTXO fetch hit the indexer limit (${FETCH_LIMIT}) — input selection may be incomplete`)
  }

  // Dedup by commitment — the indexer can return the same UTXO more than once; input selection must
  // not consider a duplicate. Decrypt/nonce/mask handling below is unchanged.
  const seen = new Set<string>()
  for (const [commitmentHex, utxoBody] of rows) {
    if (seen.has(commitmentHex)) continue
    seen.add(commitmentHex)

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

  return owned
}

async function pollOutcome(txId: string): Promise<{ outcome: SendOutcome; feeMicrotari?: bigint }> {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>(r => setTimeout(r, 5_000))
    try {
      const res = await fetch(`${INDEXER_URL}/transactions/${txId}/result`)
      if (!res.ok) continue
      const json = await res.json() as {
        result?: { Finalized?: { final_decision?: string; finalize?: { fee_receipt?: { total_fees_paid?: number | string } } } }
      }
      const fin = json.result?.Finalized
      const decision = fin?.final_decision
      // Actual fee lives on the committed receipt (same field the faucet reads).
      const feePaid = fin?.finalize?.fee_receipt?.total_fees_paid
      const feeMicrotari = feePaid != null ? BigInt(feePaid) : undefined
      if (decision === 'Commit') return { outcome: 'Commit', feeMicrotari }
      if (decision) return { outcome: 'Reject', feeMicrotari }
    } catch { /* transient */ }
  }
  return { outcome: 'Timeout' }
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
  // Change is now derived per build from the fee actually being reserved — see buildEnvelope below.
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
  // 0.39: mandatory validity window — read ONCE and reused by the pricing build and the real one,
  // so the transaction that is simulated is the transaction that is sent. See crypto/epoch.ts.
  const maxEpoch = await nextMaxEpoch(provider)

  // The fee is committed to by the outputs statement and signed over by the balance proof, so it
  // cannot be patched in afterwards — the whole build is a function OF the fee, run once to price
  // the transaction and once to send it. `recipientUtxoId` is read from the REAL build's statement:
  // the two builds use fresh output masks, so the probe's commitment names a UTXO that will never
  // exist and announcing it would point every payment message at nothing.
  async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
    const changeAmount = utxo.value - amountMicrotari - feeMicrotari

    const { statement: outsStmt, outputMask } = await crypto.generateOutputsStatement(
      [
        recipientOutput,
        createOutput({ destination: senderAddress, amount: changeAmount, resourceAddress: TARI_RESOURCE_ADDRESS }),
      ],
      feeMicrotari,
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

    const insStmt = await crypto.buildInputsStatement([new StealthInput(utxo.commitment)], 0n)
    const proof   = await signBalanceProof(crypto, utxo.mask, outputMask, insStmt, outsStmt)
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
    builder.addInput({ substate_id: stealthUtxoSubstateId(TARI_RESOURCE_ADDRESS, utxo.commitment), version: null })

    const unsignedTx   = await resolveTransaction(provider, builder.buildUnsignedTransaction())
    const sealKP       = generateSealKeypair()
    const unsignedJson = serializeUnsignedTx(unsignedTx)
    const oneTimeSig   = await wallet.addStealthSignature(unsignedJson, utxo.nonce, sealKP.public_key, { crypto })

    const ootleWallet = new OotleWallet()
      .registerKeyProvider(senderAddress, wallet)
      .setDefaultSigner(senderAddress)

    // `dry_run` must ride INSIDE the sealed envelope — the dry-run endpoint refuses anything else.
    const toSign  = dryRun ? { ...unsignedTx, dry_run: true } : unsignedTx
    const signed  = await signTransaction([ootleWallet, new StaticSigner([oneTimeSig])], toSign, sealKP)
    return { envelope: sealTransaction(signed), recipientUtxoId }
  }

  log('Estimating network fee…')
  // Priced with the ceiling reserved, which is also what the UTXO selection above set aside — so a
  // probe can never fail for want of funds the real send would have had.
  const probe = await buildEnvelope(MAX_FEE, true)
  const cost  = await dryRunFee(INDEXER_URL, probe.envelope)
  const fee   = withFeeMargin(cost)
  if (fee > MAX_FEE) {
    throw new Error(
      `Network fee (${fee} µtTARI) exceeds this wallet's ${MAX_FEE} µtTARI ceiling. ` +
      `Fees have risen — the ceiling in confidentialSend.ts needs raising.`,
    )
  }
  log(`Network fee: ${fee} µtTARI`)

  const { envelope, recipientUtxoId } = await buildEnvelope(fee, false)

  log('Submitting transaction…')
  const sub = await provider.submitTransaction(envelope)
  const txId = sub.transaction_id as string
  log(`Submitted — waiting for confirmation (up to 30s)…`)

  const { outcome, feeMicrotari } = await pollOutcome(txId)
  provider.stopWatcher?.()

  return { txId, outcome, recipientUtxoId, feeMicrotari }
}

export function tariToMicrotari(tari: number): bigint {
  return BigInt(Math.round(tari * Number(MICROTARI_PER_TARI)))
}
