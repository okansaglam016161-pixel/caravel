// The Caravel Burn Wallet, read from the chain: how much is locked in it, and every burn into it.
//
// ── WHAT IT IS ───────────────────────────────────────────────────────────────
//
// A deposit-only TARI vault with no owner (github.com/okansaglam016161-pixel/caravel-burn-wallet).
// Anything deposited is locked forever. The component and template below are pinned: anyone can
// create another burn wallet from the same template, or publish a look-alike, so nothing here is
// ever looked up by name.
//
// ── WHAT IS TRUSTED, AND WHAT IS NOT ─────────────────────────────────────────
//
// THE TOTAL comes only from substate reads with `verified: true`. Just after an epoch change an
// indexer can serve a value no committee member has proved yet, with `verified: false`, and it may
// be stale; it is never shown as the figure. The other indexer is asked instead, and failing both,
// the caller keeps the last verified figure and says it is checking.
//
// THE LIST comes from the indexer's event index and its transaction receipts, which carry no
// `verified` flag. So the list is checked against the verified total: it is only called complete
// when its Deposit amounts add up to `total_deposited` exactly.
//
// ── TELLING A PUBLIC BURN FROM A PRIVATE ONE ─────────────────────────────────
//
// From the RECEIPT, not the transaction. The indexer prunes transaction bodies some epochs after
// they finish (`transaction_retention_epochs`, 50 by default) but keeps the receipts, so anything
// read from a body would vanish from older burns. A receipt carries the transaction's events and
// the substates it downed:
//
//   public   the TARI was withdrawn from a vault (an account's): a `std.vault.withdraw` event on a
//            vault that is not the burn wallet's own.
//   private  no vault was withdrawn from, and stealth outputs were spent: `utxo_` substates in
//            `diff_summary.downed`.
//
// "BURNED BY YOU" is a public burn whose withdraw vault is one of this wallet's own account vaults
// — readable on any device — or a private burn this device journalled. A private burn made on
// another device is deliberately not recognisable: that is what private means.

import { iterVaultIdsInState } from '@tari-project/ootle'
import { INDEXER_URLS, POINT_READ_TIMEOUT_MS, pointRead } from './indexerConfig'
import { fetchWithRetry } from './indexerRetry'

/** The official burn wallet on esmeralda. */
export const BURN_WALLET_COMPONENT = 'component_2e91fb78b73440dd114bdbb887d256d760fa3be3276d7b833f4ab1b23d796029'
/** The template it runs, published from commit 6009072 of the repository below. */
export const BURN_WALLET_TEMPLATE = 'f6bb3aa676b41c9d5748509dda66406e759d1b7fba5a83017cda88006b610282'
/** Its one vault. Read from the component on every read and checked against this. */
export const BURN_WALLET_VAULT = 'vault_2ea68bbb2339d1d930e35f011692c9e5dcdbf26a65008414ad3901c84d6055d0'
export const BURN_WALLET_REPO_URL = 'https://github.com/okansaglam016161-pixel/caravel-burn-wallet'

const DEPOSIT_TOPIC = 'CaravelBurnWallet.Deposit'

/** A verified reading of the burn wallet. */
export interface BurnWalletReading {
  /** µtTARI held in the vault. */
  balance: bigint
  /** Every µtTARI ever deposited — equal to `balance`, since nothing leaves. */
  totalDeposited: bigint
}

export type BurnWalletRead =
  | { kind: 'verified'; reading: BurnWalletReading }
  /** An indexer answered, but with nothing verified. Keep the last verified figure. */
  | { kind: 'unverified' }
  /** No indexer answered at all. */
  | { kind: 'unreachable' }

// ── Parsing, kept pure so it can be tested ────────────────────────────────────

/**
 * The burn wallet component, from a `/substates/<component>` body. Null unless it is verified and
 * is exactly the burn wallet: our template, no owner, and the one vault we pinned.
 */
export function parseBurnComponent(body: unknown): { vault: string; totalDeposited: bigint } | null {
  const b = body as {
    verified?: unknown
    substate?: { Component?: { header?: { template_address?: unknown; owner_rule?: unknown }; body?: { state?: unknown } } }
  } | null
  if (b?.verified !== true) return null
  const component = b.substate?.Component
  if (!component) return null
  if (component.header?.template_address !== BURN_WALLET_TEMPLATE) return null
  if (component.header?.owner_rule !== 'None') return null

  const state = component.body?.state
  if (!Array.isArray(state) || state.length !== 2) return null
  const vaults = [...iterVaultIdsInState(state[0])].map(v => (v.startsWith('vault_') ? v : `vault_${v}`))
  if (vaults.length !== 1 || vaults[0] !== BURN_WALLET_VAULT) return null
  const total = toBigInt(state[1])
  if (total === null) return null
  return { vault: vaults[0], totalDeposited: total }
}

/** The vault's revealed TARI, from a `/substates/<vault>` body. Null unless verified and well-formed. */
export function parseBurnVault(body: unknown): bigint | null {
  const b = body as {
    verified?: unknown
    substate?: { Vault?: { resource_container?: { Stealth?: { address?: unknown; revealed_amount?: unknown } } } }
  } | null
  if (b?.verified !== true) return null
  const stealth = b.substate?.Vault?.resource_container?.Stealth
  if (stealth?.address !== 'resource_0101010101010101010101010101010101010101010101010101010101010101') return null
  return toBigInt(stealth.revealed_amount)
}

/** One Deposit into the burn wallet. */
export interface BurnDeposit {
  txId: string
  amount: bigint
}

/**
 * Deposit events from one `/transactions/events` page, kept only when the ENGINE says they came
 * from the burn wallet. The topic alone proves nothing: any template named CaravelBurnWallet can
 * emit it. The component and template on an event are set by the engine and cannot be forged.
 */
export function parseDepositEvents(page: unknown): BurnDeposit[] {
  const events = (page as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return []
  const out: BurnDeposit[] = []
  for (const entry of events) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [txId, e] = entry as [unknown, { substate_id?: unknown; template_address?: unknown; topic?: unknown; payload?: { amount?: unknown } }]
    if (typeof txId !== 'string' || !e) continue
    if (e.substate_id !== BURN_WALLET_COMPONENT || e.template_address !== BURN_WALLET_TEMPLATE) continue
    if (e.topic !== DEPOSIT_TOPIC) continue
    const amount = toBigInt(e.payload?.amount)
    if (amount === null || amount <= 0n) continue
    out.push({ txId, amount })
  }
  return out
}

export type BurnSource = 'public' | 'private' | 'unknown'

export interface BurnClassification {
  source: BurnSource
  /** The vaults the burned TARI was withdrawn from — an account's, on a public burn. */
  withdrawVaults: string[]
  /** The epoch it committed in. */
  epoch: number | null
}

/** Public or private, from a `/transaction-receipts/<tx>` body. See the header for the rule. */
export function classifyBurnReceipt(body: unknown): BurnClassification {
  const r = (body as { receipt?: unknown } | null)?.receipt as {
    events?: { substate_id?: unknown; topic?: unknown }[]
    diff_summary?: { downed?: { substate_id?: unknown }[] }
    epoch?: unknown
  } | undefined
  const epoch = typeof r?.epoch === 'number' ? r.epoch : null
  if (!r) return { source: 'unknown', withdrawVaults: [], epoch }

  const withdrawVaults = [...new Set((r.events ?? [])
    .filter(e => e.topic === 'std.vault.withdraw'
      && typeof e.substate_id === 'string'
      && e.substate_id.startsWith('vault_')
      && e.substate_id !== BURN_WALLET_VAULT)
    .map(e => e.substate_id as string))]
  if (withdrawVaults.length > 0) return { source: 'public', withdrawVaults, epoch }

  const spentStealth = (r.diff_summary?.downed ?? [])
    .some(d => typeof d.substate_id === 'string' && d.substate_id.startsWith('utxo_'))
  return { source: spentStealth ? 'private' : 'unknown', withdrawVaults: [], epoch }
}

// ── Network ───────────────────────────────────────────────────────────────────

/**
 * Read the burn wallet, trusting only verified reads.
 *
 * Each indexer is asked in turn for the component and then the vault, and the first that answers
 * BOTH verified wins. The two figures must agree (nothing ever leaves the vault), or the read is
 * not believed.
 */
export async function readBurnWallet(): Promise<BurnWalletRead> {
  let answered = false
  for (const base of INDEXER_URLS) {
    const component = await getJson(base, `/substates/${BURN_WALLET_COMPONENT}`)
    if (component === undefined) continue
    answered = true
    const parsed = parseBurnComponent(component)
    if (!parsed) continue
    const vault = await getJson(base, `/substates/${parsed.vault}`)
    if (vault === undefined) continue
    const balance = parseBurnVault(vault)
    if (balance === null || balance !== parsed.totalDeposited) continue
    return { kind: 'verified', reading: { balance, totalDeposited: parsed.totalDeposited } }
  }
  return answered ? { kind: 'unverified' } : { kind: 'unreachable' }
}

/** Most an events page may hold (the indexer refuses more than 1000). */
const EVENTS_PAGE = 1000
/** A runaway guard, not a real limit: 200 full pages is 200,000 burns. */
const MAX_EVENT_PAGES = 200

/** Every Deposit into the burn wallet, newest first. Throws when no indexer could answer. */
export async function listDeposits(): Promise<BurnDeposit[]> {
  const out: BurnDeposit[] = []
  let before: string | null = null
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const query = new URLSearchParams({ substate_id: BURN_WALLET_COMPONENT, limit: String(EVENTS_PAGE) })
    if (before !== null) query.set('before_id', before)
    const res = await fetchWithRetry(INDEXER_URLS, `/transactions/events?${query}`, {}, { attempts: 3, timeoutMs: POINT_READ_TIMEOUT_MS, alternate: true })
    if (!res.ok) throw new Error(`The burn list could not be read (indexer HTTP ${res.status}).`)
    const body = await res.json() as { next_before_id?: unknown }
    out.push(...parseDepositEvents(body))
    const next = body.next_before_id
    if (next === null || next === undefined) return out
    before = String(next)
  }
  return out
}

// Receipts are immutable once a transaction commits, so each is fetched once per session.
const receiptCache = new Map<string, BurnClassification>()
const finalizedCache = new Map<string, number | null>()

/** Classify one burn. A receipt that cannot be read yet is `unknown` and is NOT cached. */
export async function classifyBurn(txId: string): Promise<BurnClassification> {
  const hit = receiptCache.get(txId)
  if (hit) return hit
  const read = await pointRead(`/transaction-receipts/${txId}`)
  const result = classifyBurnReceipt(read.body)
  if (read.body !== null) receiptCache.set(txId, result)
  return result
}

/**
 * When the transaction finalised, in epoch-ms — while the indexer still holds its body. Null once
 * the body has been pruned (or if it never had it); the caller then estimates from the epoch.
 */
export async function burnFinalizedAt(txId: string): Promise<number | null> {
  if (finalizedCache.has(txId)) return finalizedCache.get(txId)!
  const read = await pointRead(`/transactions/${txId}`)
  const at = parseIndexerTime((read.body as { transaction?: { summary?: { finalized_at?: unknown } } } | null)?.transaction?.summary?.finalized_at)
  if (read.answered) finalizedCache.set(txId, at)
  return at
}

/** The network's current epoch, or null when no indexer answers. */
export async function currentEpoch(): Promise<number | null> {
  const read = await pointRead('/epoch-manager/stats')
  const e = (read.body as { current_epoch?: unknown } | null)?.current_epoch
  return typeof e === 'number' ? e : null
}

/**
 * Roughly how long one epoch lasts on esmeralda: 29 epochs between 19:18 UTC on 2026-10-08 (epoch
 * 12015) and 11:51 UTC on 2026-10-09 (epoch 12044). Good for "about a day ago", nothing finer.
 */
export const EPOCH_MS_APPROX = 34 * 60_000

/** An estimated time for something that committed in `epoch`. */
export function estimateEpochTime(epoch: number, current: number, now = Date.now()): number {
  return now - Math.max(0, current - epoch) * EPOCH_MS_APPROX
}

/** The vaults an account component holds, for recognising this wallet's own public burns. */
export async function accountVaultIds(account: string): Promise<Set<string>> {
  const read = await pointRead(`/substates/${account}`)
  const state = (read.body as { substate?: { Component?: { body?: { state?: unknown } } } } | null)?.substate?.Component?.body?.state
  if (state === undefined) return new Set()
  return new Set([...iterVaultIdsInState(state)].map(v => (v.startsWith('vault_') ? v : `vault_${v}`)))
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Body of one GET on one indexer; `undefined` when it did not answer usefully. */
async function getJson(base: string, path: string): Promise<unknown | undefined> {
  try {
    const res = await fetchWithRetry([base], path, {}, { attempts: 2, timeoutMs: POINT_READ_TIMEOUT_MS })
    if (!res.ok) return undefined
    return await res.json() as unknown
  } catch {
    return undefined
  }
}

function toBigInt(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v)
  return null
}

/** The indexer writes times as "2026-10-08 19:18:45.0", in UTC. */
export function parseIndexerTime(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(v)
  if (!m) return null
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}
