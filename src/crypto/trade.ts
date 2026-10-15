// Caravel Trade in the browser: PLACE, FILL and CANCEL an order on the Board — built, priced, signed
// and submitted here, through the indexer. No daemon.
//
// A port of caravel-trade scripts/live.ts (`place`, `fillPlan`, `cancel`), which ran every one of these
// paths live on esmeralda. The transaction shapes are the same; what changes is that this runs on the
// app's own primitives (coin scan, input selection, fee probe, confirm check, submit guard, spent-coin
// record, finality) and that two things move into the browser: the payout statement is packaged by
// crypto/statementCbor (live.ts shelled out to a Rust tool), and the cancel key comes from the seed
// (derivation.cancelKeyFor; live.ts kept a random one in a file).
//
// ── HOW A TRADE PAYS ITS NETWORK FEE ─────────────────────────────────────────
//
// From the signer's own tTARI, the way the trade is funded:
//
//   private  a tTARI coin is spent in the FEE INTENT; its revealed slice pays the fee and its change
//            comes back as a new coin. When the trade's own side is tTARI too (a SELL's escrow, a BUY
//            fill's payment), the main intent spends THAT change straight away — the CHAINED SPEND:
//            the change does not exist until the fee intent makes it, so it is never declared.
//   public   the account's `pay_fee` offers a budget; the engine refunds what is not used.
//
// The fee intent may hold only ONE stealth transfer (the fee's), so every other transfer sits in the
// main intent.
//
// ── THE FEE SHOWN IS THE FEE CHARGED ─────────────────────────────────────────
//
// A private fee is a revealed bucket spent WHOLE, ahead of trade calls that run in the MAIN intent — so a
// cost that rose before execution would not be a free reject: the engine would commit the fee intent
// alone and the trade would not happen. So it pays the measured cost plus the flat buffer @names pay
// (feeProbe.MAIN_INTENT_FEE_BUFFER, one constant), re-measured at that budget; the whole budget is the
// fee, shown and charged. A public fee is priced at the budget it will really offer
// (feeProbe.priceAtBudget), whose refunded margin does the same job. Then the final transaction is
// dry-run at that budget on EVERY indexer, and again at confirm time (crypto/quote): a public cost must
// equal the fee shown, a private one must fit the budget — a rise past the buffer re-quotes and asks
// again rather than charging a figure nobody was shown.
//
// ── PRIVACY ──────────────────────────────────────────────────────────────────
//
// A private path is signed only by the one-time keys of the coins it spends (and, for a cancel, by the
// order's own cancel key) — never by the owner key, so neither it nor the account appears. A public
// path signs with the owner key, which an account needs. `ownerSigned` on every prepared trade says
// which, and the harness checks it against the submitted transaction.

import {
  Mask, Network, StealthInput, StealthTransferStatement, TARI_RESOURCE_ADDRESS, TransactionBuilder, WasmStealthCrypto,
  amountLiteral, bytesLiteral, componentAddressLiteral, createOutput, decryptOwnedUtxo, generateSealKeypair,
  publicKeyLiteral, resourceAddressLiteral, sealTransaction, serializeUnsignedTx, signBalanceProof, signTransaction,
  stealthTransferInstruction,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { upSubstates } from './accountAddress'
import { CUSD_ASSET } from './assets'
import { feesPaid } from './conceal'
import { accountVaultIds, verifiedRead } from './cusdScan'
import { cancelKeyFor } from './derivation'
import { nextMaxEpoch } from './epoch'
import { compareToShownFee, dryRunFee, mainIntentBudget, priceAtBudget, simulateFee, type FeeSimulation } from './feeProbe'
import { awaitFinality } from './finality'
import { INDEXER_URL, INDEXER_URLS } from './indexerConfig'
import { RETRYING_MESSAGE } from './indexerRetry'
import { readOutputSubstateIds } from './outputIds'
import { readFinalizedVerdict } from './txResult'
import { PUBLIC_SEND_FEE_RESERVE } from './publicSend'
import { confirmer } from './quote'
import { markLocked, settleLocks } from './spentOutputs'
import { encodeStatement } from './statementCbor'
import { StaticSigner, type OwnedUtxo } from './stealthUtxos'
import { inputsStillUnspent, submitOnce, versionsUnchanged, type LandedCheck } from './submitGuard'
import { holdCusdCoins, releaseCusdCoins, scanTradeCoins, selectLiveCoins } from './tradeCoins'
import {
  BUY, ORDER_OPEN, SELL, TRADE_BOARD_ADDRESS, TRADE_ORDER_TEMPLATE,
  type OrderSide, type TradeMode,
} from './tradeConfig'
import { checkPayout, makerOwed, orderLegitimacy, readBoard, readOrder, TradeReadError, type BoardInfo, type OrderInfo } from './tradeRead'

const TARI = TARI_RESOURCE_ADDRESS
const CUSD = CUSD_ASSET.resource

/** Fee reserved for the PRIVATE pricing dry run only — never submitted (a dry run charges nothing). */
export const TRADE_FEE_PROBE_MICROTARI = 80_000n
/** The public probe's `pay_fee` budget, and the most a public trade fee may be. */
export const TRADE_PUBLIC_FEE_RESERVE = PUBLIC_SEND_FEE_RESERVE

/** Why a trade will not be offered or sent. Shown as is. */
export class TradeRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TradeRefused'
  }
}

/** Who is trading: the unlocked wallet, as the trade code needs it. */
export interface Trader {
  /** The wallet (owner key). Signs only public paths; on private paths it only derives one-time keys. */
  wallet: SecretKeyWallet
  /** This wallet's Ootle address (`otl_esm_1…`). */
  address: string
  /** Its account component, or null when it has none (public paths then refuse). */
  account: string | null
  /** derivation.PurposeKeys.tradeRoot — the cancel keys come from it. */
  tradeRoot: Uint8Array
  /** cUSD outputs this wallet made itself (claims, trades), asked for by id until a listing has them. */
  knownCusdIds: readonly string[]
}

// ── One transaction under construction (live.ts `Tx`) ───────────────────────

type Ins = Record<string, unknown>
const call = (address: string, method: string, args: unknown[]): Ins => ({ CallMethod: { call: { Address: address }, method, args } })
const ws = (id: number) => ({ Workspace: { id, offset: null } })

/** What a built transaction does for us — the bookkeeping the journal and the stores need. */
export interface TradeEffects {
  /** tTARI coins it spends that exist before it runs (declared inputs). */
  tariSpent: string[]
  /** cUSD coins it spends. */
  cusdSpent: string[]
  /** tTARI outputs it creates for this wallet (change, a private receive). */
  tariCreated: string[]
  /** cUSD outputs it creates for this wallet (change, a private receive). */
  cusdCreated: string[]
  /** A private maker payout: the output a FILL will create for us later, and in which token. */
  payout: { outputId: string; resource: string } | null
}

class TradeTx {
  readonly feeIns: Ins[] = []
  readonly mainIns: Ins[] = []
  readonly inputs = new Map<string, { version: number | null; is_write: boolean }>()
  /** Coins whose one-time keys sign. */
  readonly stealth: OwnedUtxo[] = []
  /** Extra signers (the cancel key). The owner signs only when `ownerSigns`. */
  readonly signers: SecretKeyWallet[] = []
  ownerSigns = false
  private readonly keys = [0, 0]
  readonly effects: TradeEffects = { tariSpent: [], cusdSpent: [], tariCreated: [], cusdCreated: [], payout: null }
  input(id: string, write = true, version: number | null = null) {
    const prev = this.inputs.get(id)
    this.inputs.set(id, { version: version ?? prev?.version ?? null, is_write: write || (prev?.is_write ?? false) })
  }
  /** Run `ins` in `intent` and park its output on that intent's workspace; returns the slot. */
  put(intent: 0 | 1, ins: Ins): number {
    const list = intent === 0 ? this.feeIns : this.mainIns
    list.push(ins)
    const k = this.keys[intent]++
    list.push({ PutLastInstructionOutputOnWorkspace: { key: k } })
    return k
  }
  push(intent: 0 | 1, ins: Ins) { (intent === 0 ? this.feeIns : this.mainIns).push(ins) }
}

// ── Statements (live.ts `spend` / `receive` / `decodeOwn`) ───────────────────

const crypto = () => (sharedCrypto ??= new WasmStealthCrypto(Network.Esmeralda))
let sharedCrypto: WasmStealthCrypto | undefined

/** Spend `inputs`: reveal `revealed` to `receiver`, the rest back to us as one change output. */
async function spend(t: Trader, resource: string, inputs: OwnedUtxo[], revealed: bigint, receiver: Uint8Array) {
  const c = crypto()
  const total = inputs.reduce((s, i) => s + i.value, 0n)
  const change = total - revealed
  if (change <= 0n) throw new TradeRefused('A spend must leave change; the selected coins are too small.')
  const { statement: outs, outputMask } = await c.generateOutputsStatement(
    [createOutput({ destination: t.address, amount: change, resourceAddress: resource })], { amount: revealed, receiver })
  const ins = await c.buildInputsStatement(inputs.map(i => new StealthInput(i.commitment)), 0n)
  const proof = await signBalanceProof(c, await c.aggregateInputMasks(inputs.map(i => i.mask)), outputMask, ins, outs)
  return { st: new StealthTransferStatement(ins, outs, proof), outs }
}

/** A revealed bucket of exactly `amount` into one private output of ours. */
async function receive(t: Trader, resource: string, amount: bigint) {
  const c = crypto()
  const { statement: outs, outputMask } = await c.generateOutputsStatement(
    [createOutput({ destination: t.address, amount, resourceAddress: resource })], null)
  const ins = await c.buildInputsStatement([], amount)
  const proof = await signBalanceProof(c, Mask.zero(), outputMask, ins, outs)
  return { st: new StealthTransferStatement(ins, outs, proof), outs }
}

/** The change of a spend being built, decoded as a scan would decode it, so it can be spent at once. */
async function decodeOwn(t: Trader, resource: string, outs: unknown, index: number): Promise<OwnedUtxo> {
  const raw = (outs as { parsed(): { outputs: Record<string, unknown>[] } }).parsed().outputs[index] as
    { output: { commitment: string; public_nonce?: string; sender_public_nonce?: string }; auth?: { Key?: string } }
  const nonce = raw.output.public_nonce ?? raw.output.sender_public_nonce
  const o = { ...raw, output: { ...raw.output, public_nonce: nonce } }
  const id = `utxo_${resource.replace(/^resource_/, '')}_${o.output.commitment}`
  const wrapped = { version: 0, verified: false, substate: { Utxo: { output: o, is_frozen: false } } } as unknown as Parameters<typeof decryptOwnedUtxo>[2]
  const d = await decryptOwnedUtxo(crypto(), await t.wallet.getViewSecret(), wrapped, id)
  if (!d || !o.auth?.Key || !nonce) throw new Error('Could not decode this wallet\'s own change output.')
  return { substateId: id, commitment: hexToBytes(o.output.commitment), nonce: hexToBytes(nonce), value: d.value, mask: d.mask, spendKey: hexToBytes(o.auth.Key) }
}

function hexToBytes(h: string): Uint8Array {
  const b = new Uint8Array(h.length / 2)
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
  return b
}
const bytesToHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

/** The output ids a statement creates, as `utxo_<resource>_<commitment>`. */
function createdIds(outs: unknown, resource: string): string[] {
  const ids = readOutputSubstateIds(outs as { parsed(): unknown }) ?? []
  // readOutputSubstateIds names TARI ids; re-key them to the statement's own resource.
  const hex = resource.replace(/^resource_/, '')
  return ids.map(id => `utxo_${hex}_${id.split('_').pop()}`)
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** Every vault an account holds, with its resource (read verified). Empty when it does not exist. */
async function accountVaults(account: string): Promise<{ vault: string; resource: string }[]> {
  const r = await verifiedRead(`/substates/${account}`)
  if (r.kind === 'absent') return []
  if (r.kind !== 'verified') throw new TradeReadError('Could not read an account verified — try again in a moment.')
  const out: { vault: string; resource: string }[] = []
  for (const vault of accountVaultIds(r.body) ?? []) {
    const v = await verifiedRead(`/substates/${vault}`)
    if (v.kind !== 'verified') throw new TradeReadError('Could not read an account vault verified — try again in a moment.')
    const container = (v.body as { substate?: { Vault?: { resource_container?: Record<string, { address?: unknown }> } } })
      ?.substate?.Vault?.resource_container
    const body = container ? Object.values(container)[0] : undefined
    const res = typeof body?.address === 'string' ? body.address : ''
    out.push({ vault, resource: res.startsWith('resource_') ? res : `resource_${res}` })
  }
  return out
}

async function declareAccount(tx: TradeTx, account: string) {
  tx.input(account)
  for (const v of await accountVaults(account)) { tx.input(v.vault); tx.input(v.resource, false) }
}

// ── Paying, funding, taking (live.ts `payPrivately` / `payPublicly` / `fund` / `take`) ──

/** Pay the fee from private tTARI coins in the fee intent. Returns the change coin (for a chained spend). */
async function payPrivately(t: Trader, tx: TradeTx, coins: OwnedUtxo[], fee: bigint): Promise<{ change: OwnedUtxo }> {
  const f = await spend(t, TARI, coins, fee, coins[0].spendKey!)
  const k = tx.put(0, stealthTransferInstruction({ resourceAddress: TARI, revealedInputBucket: null, statement: f.st }, () => ws(0).Workspace) as unknown as Ins)
  tx.push(0, { PayFeeFromBucket: { bucket: { id: k, offset: null } } })
  for (const c of coins) { tx.input(c.substateId); tx.effects.tariSpent.push(c.substateId) }
  tx.input(TARI, false)
  tx.stealth.push(...coins)
  const change = await decodeOwn(t, TARI, f.outs, 0)
  // Recorded as ours even when the main intent spends it straight on (the chained spend): if the trade
  // is then rejected after the fee (a fee-only commit), this change is what the wallet is left with.
  tx.effects.tariCreated.push(change.substateId)
  return { change }
}

async function payPublicly(t: Trader, tx: TradeTx, budget: bigint) {
  if (!t.account) throw new TradeRefused('This wallet has no public account to pay the fee from.')
  tx.push(0, call(t.account, 'pay_fee', [amountLiteral(budget)]))
  await declareAccount(tx, t.account)
  tx.ownerSigns = true
}

/**
 * `amount` of `resource` onto the main intent's workspace: revealed from private coins (for tTARI
 * after a private fee, the fee's change — chained) or withdrawn from the account.
 */
async function fund(t: Trader, tx: TradeTx, resource: string, amount: bigint, mode: TradeMode, chained: OwnedUtxo | null, coins: OwnedUtxo[] | null): Promise<number> {
  if (mode === 'public') {
    if (!t.account) throw new TradeRefused('This wallet has no public account to pay from.')
    await declareAccount(tx, t.account)
    tx.ownerSigns = true
    return tx.put(1, call(t.account, 'withdraw', [resourceAddressLiteral(resource as never), amountLiteral(amount)]))
  }
  let spendCoins: OwnedUtxo[]
  if (resource === TARI && chained) {
    spendCoins = [chained]   // never declared: it does not exist until this transaction's fee intent makes it
  } else {
    if (!coins?.length) throw new TradeRefused('No private coins were selected for this payment.')
    spendCoins = coins
    for (const c of coins) {
      tx.input(c.substateId)
      ;(resource === TARI ? tx.effects.tariSpent : tx.effects.cusdSpent).push(c.substateId)
    }
  }
  tx.input(resource, false)
  tx.stealth.push(...spendCoins)
  const m = await spend(t, resource, spendCoins, amount, spendCoins[0].spendKey!)
  ;(resource === TARI ? tx.effects.tariCreated : tx.effects.cusdCreated).push(...createdIds(m.outs, resource))
  return tx.put(1, stealthTransferInstruction({ resourceAddress: resource, revealedInputBucket: null, statement: m.st }, () => ws(0).Workspace) as unknown as Ins)
}

/** Hand the bucket on workspace `k` to this wallet: into the account, or into a new private output. */
async function take(t: Trader, tx: TradeTx, k: number, resource: string, amount: bigint, mode: TradeMode) {
  if (mode === 'public') {
    if (!t.account) throw new TradeRefused('This wallet has no public account to receive into.')
    await declareAccount(tx, t.account)
    tx.push(1, call(t.account, 'deposit', [ws(k)]))
    return
  }
  const r = await receive(t, resource, amount)
  tx.input(resource, false)
  tx.push(1, stealthTransferInstruction({ resourceAddress: resource, revealedInputBucket: 'got', statement: r.st }, () => ({ id: k, offset: null })) as unknown as Ins)
  ;(resource === TARI ? tx.effects.tariCreated : tx.effects.cusdCreated).push(...createdIds(r.outs, resource))
}

// ── Building, signing, pricing ───────────────────────────────────────────────

async function finish(t: Trader, tx: TradeTx, dryRun: boolean, maxEpoch: number) {
  const b = new TransactionBuilder(Network.Esmeralda, maxEpoch)
  for (const i of tx.feeIns) b.addFeeInstruction(i as never)
  for (const i of tx.mainIns) b.addInstruction(i as never)
  for (const [substate_id, d] of tx.inputs) b.addInput({ substate_id, version: d.version, is_write: d.is_write } as never)
  const unsigned = b.buildUnsignedTransaction()
  const seal = generateSealKeypair()
  const json = serializeUnsignedTx(unsigned)
  const sigs = []
  for (const c of tx.stealth) sigs.push(await t.wallet.addStealthSignature(json, c.nonce, seal.public_key, { crypto: crypto() }))
  const signers = [...(tx.ownerSigns ? [t.wallet] : []), ...tx.signers, ...(sigs.length ? [new StaticSigner(sigs as never)] : [])]
  return sealTransaction(await signTransaction(signers as never, dryRun ? { ...unsigned, dry_run: true } : unsigned, seal))
}

/** What a trade does, in the user's terms — the numbers the review screen and the journal show. */
export interface TradeDetails {
  action: 'place' | 'fill' | 'cancel'
  side: OrderSide
  /** tTARI side, µtTARI. */
  n: bigint
  /** cUSD side, base units. */
  p: bigint
  /** The 1% trade fee on the tTARI side (floor), its Caravel and burn shares. Zero for a cancel. */
  tradeFee: bigint
  caravelCut: bigint
  burnCut: bigint
  /** What leaves this wallet (excluding the network fee), and what arrives. */
  pays: { resource: string; amount: bigint; mode: TradeMode } | null
  gets: { resource: string; amount: bigint; mode: TradeMode } | null
  orderId: string | null
  /** Place only: which of this wallet's cancel keys the order names. */
  cancelIndex: number | null
}

export interface TradeResult {
  txId: string
  outcome: 'Commit' | 'Reject' | 'Timeout'
  reason?: string
  /** A Reject that still took the fee (AcceptFeeRejectRest): the trade did not happen, the fee is gone. */
  feeOnly: boolean
  /** The network fee charged (fee receipt), µtTARI. */
  feeMicrotari: bigint
  /** Place: the new order's address, read from the committed result. */
  orderId: string | null
  effects: TradeEffects
  /** Did the owner key sign? (false on every private path) */
  ownerSigned: boolean
}

export interface PreparedTrade {
  details: TradeDetails
  /** What the final transaction spends and creates for us — known before it is sent, for the journal. */
  effects: TradeEffects
  /** The network fee, µtTARI — shown, and charged. */
  fee: bigint
  feeMode: TradeMode
  /** True when the owner key signs (a public path). */
  ownerSigned: boolean
  preparedAt: number
  /** Dry-run the final transaction's twin at the exact fee, held to the fee shown. */
  simulate: () => Promise<FeeSimulation>
  /** The confirm-time check (crypto/quote): fresh, inputs untouched, the order unmoved, the fee unchanged. */
  confirm: () => Promise<void>
  /** Submit once. A second call refuses. */
  submit: (onProgress?: (msg: string) => void) => Promise<TradeResult>
}

interface Plan {
  details: TradeDetails
  feeMode: TradeMode
  /** Builds the whole transaction offering `budget` (private: the fee revealed exactly; public: pay_fee's budget). */
  build: (budget: bigint) => Promise<TradeTx>
  /** Extra "has this moved" checks for confirm and the submit guard (the order's version). */
  watch: () => Promise<LandedCheck | null>
}

const busy = new Set<string>()

/** Price `plan`, hold it to that price, and return it ready to confirm and submit. */
async function prepare(t: Trader, plan: Plan, onProgress?: (m: string) => void): Promise<PreparedTrade> {
  const log = (m: string) => onProgress?.(m)
  const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
  const maxEpoch = await nextMaxEpoch(provider)
  const measure = async (fee: bigint) =>
    dryRunFee(INDEXER_URL, await finish(t, await plan.build(fee), true, maxEpoch), { onBusyRetry: () => log(RETRYING_MESSAGE) })

  log('Estimating network fee…')
  let fee: bigint
  /** What the fee intent offers: the revealed fee itself (private), or the refundable pay_fee budget. */
  let budget: bigint
  if (plan.feeMode === 'public') {
    // A refundable budget (cost + the usual margin, refunded): the fee shown is the cost MEASURED AT
    // that budget, which is what is charged. The margin also keeps a slightly risen cost from failing
    // the main intent after the fee.
    ({ fee, budget } = await priceAtBudget(measure, { reserve: TRADE_PUBLIC_FEE_RESERVE }))
  } else {
    // A revealed bucket spent WHOLE, before an action in the MAIN intent: the measured cost plus the
    // flat MAIN_INTENT_FEE_BUFFER @names use, re-measured AT that budget until it covers its own cost
    // (an amount's CBOR size can move the cost). The whole budget is the fee — shown, and charged —
    // and the buffer is what keeps a cost that rises a little before execution from taking the fee
    // and leaving the trade undone (feeProbe.MAIN_INTENT_FEE_BUFFER).
    budget = mainIntentBudget(await measure(TRADE_FEE_PROBE_MICROTARI))
    let covered = false
    for (let i = 0; i < 4 && !covered; i++) {
      const cost = await measure(budget)
      if (cost <= budget) covered = true
      else budget = mainIntentBudget(cost)
    }
    if (!covered) throw new TradeRefused('The network fee kept changing while it was being priced. Nothing was sent — try again.')
    if (budget > TRADE_FEE_PROBE_MICROTARI) throw new TradeRefused(`The network fee (${budget} µtTARI) is above the ${TRADE_FEE_PROBE_MICROTARI} µtTARI this trade reserves. Try again later.`)
    fee = budget
  }

  // What the final transaction's twin must show to be sent at this price. PUBLIC: cost exactly the fee
  // shown (the budget is refunded down to the cost). PRIVATE: cost no more than the budget — a cost that
  // rose past the buffer is `underpaid` and re-quoted at confirm; within it, the budget is still the fee.
  const hold = (sim: FeeSimulation) => (plan.feeMode === 'public' ? compareToShownFee(sim, fee) : sim)

  // The final transaction, and a dry-run twin at exactly that budget on EVERY indexer.
  log('Checking the trade at that exact fee…')
  const real = await plan.build(budget)
  const twin = async () => finish(t, await plan.build(budget), true, maxEpoch)
  const simulate = async () => hold(await simulateFee(INDEXER_URL, await twin(), { fee: budget, onBusyRetry: () => log(RETRYING_MESSAGE) }))
  for (const url of INDEXER_URLS) {
    const sim = hold(await simulateFee(url, await twin(), { fee: budget }))
    if (!sim.accepted) throw new TradeRefused(sim.message)
  }
  const envelope = await finish(t, real, false, maxEpoch)

  const spentIds = [...real.effects.tariSpent, ...real.effects.cusdSpent]
  const coinsCheck = inputsStillUnspent(spentIds)
  const extra = await plan.watch()
  const landed: LandedCheck = async () => {
    if (spentIds.length > 0 && await coinsCheck() !== 'not-landed') return 'maybe-landed'
    if (extra && await extra() !== 'not-landed') return 'maybe-landed'
    return 'not-landed'
  }
  const preparedAt = Date.now()
  const check = confirmer({ preparedAt, simulate, inputs: { landed } })
  let used = false

  async function submit(onSubmitProgress?: (msg: string) => void): Promise<TradeResult> {
    const slog = (m: string) => (onSubmitProgress ?? onProgress)?.(m)
    if (used) throw new TradeRefused('This trade was already sent.')
    if (busy.has(t.address)) throw new TradeRefused('Another trade from this wallet is still being sent.')
    busy.add(t.address)
    used = true
    try {
      slog('Checking the fee…')
      await check.ensureConfirmed()
      slog('Submitting…')
      const sub = await submitOnce(() => provider.submitTransaction(envelope as never), { landed, onBusyRetry: () => slog(RETRYING_MESSAGE) })
      const txId = sub.transaction_id as string
      markLocked(t.address, real.effects.tariSpent, txId)
      holdCusdCoins(t.address, real.effects.cusdSpent, txId)
      slog('Confirming on-chain…')
      const { outcome, reason, body } = await awaitFinality(provider, txId)
      provider.stopWatcher?.()
      // A FEE-ONLY COMMIT (AcceptFeeRejectRest) spent the fee intent's coins even though the trade did
      // not happen: they stay spent, settled coin by coin from the fee diff (spentOutputs.settleLocks).
      const feeOnly = outcome === 'Reject' && readFinalizedVerdict(body)?.kind === 'fee-only'
      settleLocks(t.address, txId, outcome, body)
      if (outcome !== 'Timeout') releaseCusdCoins(t.address, txId)
      let orderId: string | null = null
      if (outcome === 'Commit' && plan.details.action === 'place') {
        for (const entry of upSubstates(body)) {
          const [id, v] = entry as [unknown, { substate?: { Component?: { header?: { template_address?: unknown } } } }]
          if (typeof id === 'string' && id.startsWith('component_') && v?.substate?.Component?.header?.template_address === TRADE_ORDER_TEMPLATE) orderId = id
        }
      }
      return {
        txId, outcome, reason, feeOnly, feeMicrotari: feesPaid(body) ?? (outcome === 'Commit' ? fee : 0n),
        orderId: orderId ?? plan.details.orderId, effects: real.effects, ownerSigned: real.ownerSigns,
      }
    } finally {
      busy.delete(t.address)
    }
  }

  return { details: plan.details, effects: real.effects, fee, feeMode: plan.feeMode, ownerSigned: real.ownerSigns, preparedAt, simulate, confirm: check.confirm, submit }
}

/** Private tTARI coins for a private fee, plus `extra` the main intent will take from their change. */
async function feeCoins(t: Trader, extra: bigint): Promise<OwnedUtxo[]> {
  const coins = await scanTradeCoins(crypto(), await t.wallet.getViewSecret(), t.address, TARI)
  return (await selectLiveCoins(coins, extra + TRADE_FEE_PROBE_MICROTARI + 1n, 'tTARI')).inputs
}

async function cusdCoins(t: Trader, amount: bigint): Promise<OwnedUtxo[]> {
  const coins = await scanTradeCoins(crypto(), await t.wallet.getViewSecret(), t.address, CUSD, t.knownCusdIds)
  return (await selectLiveCoins(coins, amount + 1n, 'cUSD')).inputs
}

/** The 1% fee and its split, exactly as the Order computes them (floor at each step). */
export function tradeFeeSplit(n: bigint, feeBps: bigint, caravelPct: bigint) {
  const fee = (n * feeBps) / 10_000n
  const caravelCut = (fee * caravelPct) / 100n
  return { fee, caravelCut, burnCut: fee - caravelCut }
}

// ── PLACE ────────────────────────────────────────────────────────────────────

export interface PlaceParams {
  side: OrderSide
  /** tTARI side, µtTARI. At least the Board's minimum (1 tTARI). */
  n: bigint
  /** cUSD side, base units. */
  p: bigint
  /** Where the escrow comes from (N tTARI for a SELL, P cUSD for a BUY). The fee is paid the same way. */
  escrow: TradeMode
  /** How the maker is paid when filled: a pre-signed private statement, or into the account. */
  payout: TradeMode
  /** This order's cancel key index (tradeStore.nextCancelIndex). */
  cancelIndex: number
}

export async function preparePlace(t: Trader, params: PlaceParams, onProgress?: (m: string) => void): Promise<PreparedTrade> {
  const { side, n, p, escrow, payout, cancelIndex } = params
  if (side !== SELL && side !== BUY) throw new TradeRefused('An order is a sell or a buy.')
  onProgress?.('Reading the Board…')
  const board = await readBoard()
  if (board.paused) throw new TradeRefused('New orders are paused on the Board right now.')
  if (n < board.minOrder) throw new TradeRefused(`The smallest order is ${board.minOrder} µtTARI.`)
  if (p <= 0n) throw new TradeRefused('The cUSD amount must be positive.')
  if ((escrow === 'public' || payout === 'public') && !t.account) throw new TradeRefused('This wallet has no public account.')
  const split = tradeFeeSplit(n, board.feeBps, board.caravelPct)
  const owed = side === SELL ? { resource: CUSD, amount: p } : { resource: TARI, amount: n - split.fee }
  const escrowRes = side === SELL ? TARI : CUSD
  const escrowAmt = side === SELL ? n : p
  const cancelPk = await cancelKeyFor(t.tradeRoot, cancelIndex).getPublicKey()

  onProgress?.('Selecting funds…')
  const tariCoins = escrow === 'private' ? await feeCoins(t, side === SELL ? n : 0n) : null
  const cusd = escrow === 'private' && side === BUY ? await cusdCoins(t, p) : null

  const plan: Plan = {
    feeMode: escrow,
    details: {
      action: 'place', side, n, p, tradeFee: split.fee, caravelCut: split.caravelCut, burnCut: split.burnCut,
      pays: { resource: escrowRes, amount: escrowAmt, mode: escrow },
      gets: { resource: owed.resource, amount: owed.amount, mode: payout },
      orderId: null, cancelIndex,
    },
    watch: async () => null,
    build: async (fee) => {
      const tx = new TradeTx()
      let chained: OwnedUtxo | null = null
      if (escrow === 'public') await payPublicly(t, tx, fee)
      else chained = (await payPrivately(t, tx, tariCoins!, fee)).change
      const k = await fund(t, tx, escrowRes, escrowAmt, escrow, chained, side === BUY ? cusd : null)
      let method: string
      let args: unknown[]
      if (payout === 'private') {
        const r = await receive(t, owed.resource, owed.amount)
        const [outputId] = createdIds(r.outs, owed.resource)
        tx.effects.payout = { outputId, resource: owed.resource }
        method = side === SELL ? 'place_sell_private' : 'place_buy_private'
        args = [ws(k), amountLiteral(side === SELL ? p : n), bytesLiteral(encodeStatement(r.st.toCompactJson())), publicKeyLiteral(cancelPk)]
      } else {
        method = side === SELL ? 'place_sell_public' : 'place_buy_public'
        args = [ws(k), amountLiteral(side === SELL ? p : n), componentAddressLiteral(t.account as never), publicKeyLiteral(cancelPk)]
        tx.input(t.account!, false)
      }
      tx.push(1, call(TRADE_BOARD_ADDRESS, method, args))
      tx.input(TRADE_BOARD_ADDRESS); tx.input(board.badgeVault); tx.input(board.badge, false)
      tx.input(CUSD, false); tx.input(TARI, false)
      // The new order stores these addresses, and the engine refuses an address it cannot see: read only.
      tx.input(board.caravelAccount, false); tx.input(board.burnWallet, false)
      return tx
    },
  }
  return prepare(t, plan, onProgress)
}

// ── FILL ─────────────────────────────────────────────────────────────────────

export interface FillParams {
  orderId: string
  /** The terms the taker was shown. The fill refuses if the order says otherwise, and passes them on. */
  expectedN: bigint
  expectedP: bigint
  /** How the taker pays (P cUSD for a SELL, N tTARI for a BUY). The fee is paid the same way. */
  pay: TradeMode
  /** How the taker receives (N − fee tTARI for a SELL, P cUSD for a BUY). */
  receive: TradeMode
}

/**
 * The safety check before a fill, every part read just now and verified: a real order of the trusted
 * Board, still open, at the terms shown, and a payout that can still be paid. Returns the order.
 */
export async function checkFillSafety(params: Pick<FillParams, 'orderId' | 'expectedN' | 'expectedP'>, board?: BoardInfo): Promise<OrderInfo> {
  const b = board ?? await readBoard()
  const o = await readOrder(params.orderId)
  if (!o) throw new TradeRefused('That order does not exist.')
  const notLegit = orderLegitimacy(o, b)
  if (notLegit) throw new TradeRefused(notLegit)
  if (o.status !== ORDER_OPEN) throw new TradeRefused('This order is no longer open.')
  if (o.n !== params.expectedN || o.p !== params.expectedP) throw new TradeRefused('This order\'s terms are not the ones you were shown.')
  const payout = await checkPayout(o)
  if (!payout.ok) throw new TradeRefused(payout.reason)
  return o
}

export async function prepareFill(t: Trader, params: FillParams, onProgress?: (m: string) => void): Promise<PreparedTrade> {
  onProgress?.('Checking the order…')
  const board = await readBoard()
  const o = await checkFillSafety(params, board)
  if ((params.pay === 'public' || params.receive === 'public') && !t.account) throw new TradeRefused('This wallet has no public account.')
  const due = o.side === SELL ? { resource: CUSD, amount: o.p } : { resource: TARI, amount: o.n }
  const gets = o.side === SELL ? { resource: TARI, amount: o.n - o.fee } : { resource: CUSD, amount: o.p }

  onProgress?.('Selecting funds…')
  const tariCoins = params.pay === 'private' ? await feeCoins(t, o.side === BUY ? o.n : 0n) : null
  const cusd = params.pay === 'private' && o.side === SELL ? await cusdCoins(t, o.p) : null
  // The burn wallet's vaults are declared as they are now; it is a component, not an account.
  const burnVaults = await accountVaults(o.burnWallet)

  const plan: Plan = {
    feeMode: params.pay,
    details: {
      action: 'fill', side: o.side, n: o.n, p: o.p, tradeFee: o.fee, caravelCut: o.caravelCut, burnCut: o.burnCut,
      pays: { ...due, mode: params.pay }, gets: { ...gets, mode: params.receive }, orderId: o.id, cancelIndex: null,
    },
    // The order pinned at the version the safety check read: if anything moved it, refuse.
    watch: async () => versionsUnchanged([o.id]),
    build: async (fee) => {
      const tx = new TradeTx()
      let chained: OwnedUtxo | null = null
      if (params.pay === 'public') await payPublicly(t, tx, fee)
      else chained = (await payPrivately(t, tx, tariCoins!, fee)).change
      const k = await fund(t, tx, due.resource, due.amount, params.pay, chained, o.side === SELL ? cusd : null)
      const kg = tx.put(1, call(o.id, 'fill', [ws(k), amountLiteral(o.n), amountLiteral(o.p)]))
      await take(t, tx, kg, gets.resource, gets.amount, params.receive)
      tx.input(o.id, true, o.version)
      tx.input(o.escrowVault)
      tx.input(CUSD, false); tx.input(TARI, false)
      await declareAccount(tx, o.caravelAccount)
      tx.input(o.burnWallet)
      for (const v of burnVaults) tx.input(v.vault)
      if (o.payoutAccount) await declareAccount(tx, o.payoutAccount)
      return tx
    },
  }
  return prepare(t, plan, onProgress)
}

// ── CANCEL ───────────────────────────────────────────────────────────────────

export interface CancelParams {
  orderId: string
  /** The order's cancel key index (tradeStore). */
  cancelIndex: number
  /** Where the escrow comes back to. The fee is paid the same way. */
  to: TradeMode
}

export async function prepareCancel(t: Trader, params: CancelParams, onProgress?: (m: string) => void): Promise<PreparedTrade> {
  onProgress?.('Checking the order…')
  const o = await readOrder(params.orderId)
  if (!o) throw new TradeRefused('That order does not exist.')
  if (o.template !== TRADE_ORDER_TEMPLATE || o.board !== TRADE_BOARD_ADDRESS) throw new TradeRefused('This is not a Caravel Trade order.')
  if (o.status !== ORDER_OPEN) throw new TradeRefused('This order is no longer open.')
  const cancelKey = cancelKeyFor(t.tradeRoot, params.cancelIndex)
  if (o.cancelKeyHex !== bytesToHex(await cancelKey.getPublicKey())) throw new TradeRefused('This wallet does not hold this order\'s cancel key.')
  if (params.to === 'public' && !t.account) throw new TradeRefused('This wallet has no public account.')
  const back = o.side === SELL ? { resource: TARI, amount: o.n } : { resource: CUSD, amount: o.p }
  const tariCoins = params.to === 'private' ? await feeCoins(t, 0n) : null

  const plan: Plan = {
    feeMode: params.to,
    details: {
      action: 'cancel', side: o.side, n: o.n, p: o.p, tradeFee: 0n, caravelCut: 0n, burnCut: 0n,
      pays: null, gets: { ...back, mode: params.to }, orderId: o.id, cancelIndex: params.cancelIndex,
    },
    watch: async () => versionsUnchanged([o.id]),
    build: async (fee) => {
      const tx = new TradeTx()
      if (params.to === 'public') await payPublicly(t, tx, fee)
      else await payPrivately(t, tx, tariCoins!, fee)
      const k = tx.put(1, call(o.id, 'cancel', []))
      await take(t, tx, k, back.resource, back.amount, params.to)
      tx.input(o.id); tx.input(o.escrowVault); tx.input(back.resource, false)
      tx.signers.push(cancelKey)
      return tx
    },
  }
  return prepare(t, plan, onProgress)
}

export { makerOwed }
