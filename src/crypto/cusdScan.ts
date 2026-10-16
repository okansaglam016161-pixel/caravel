// The wallet's cUSD — private outputs and the public account vault — from VERIFIED reads only.
//
// ── THE TARI PATTERN, A SECOND RESOURCE ──────────────────────────────────────
//
// Private cUSD is found exactly as private TARI is: walk `/utxos` for the resource on every indexer to
// the end (crypto/utxoFeed, now resource-parameterised), and trial-decrypt each row with the view key.
// A stealth output carries no owner, so "ours" means "our view key opens it" — the same test, the same
// wasm call. Restore needs nothing more: a new device has the view key, and the listing has the rows.
//
// ── VERIFIED, NOT LISTED ─────────────────────────────────────────────────────
//
// A listing is a hint. Measured on the TARI side (crypto/ownedFeed): both nodes kept listing a spent
// coin for six minutes, and a live coin can be absent from every listing. So every row our key opens
// is read again BY ID, and only a body the indexer marks `verified: true` with a live `output` counts
// — and the value is decrypted from THAT body, not the listing's copy. Three outcomes per output:
//
//   verified + live      counted
//   verified gone / 404  dropped (spent, or never existed) — a definite answer
//   no verified answer   NOT counted, and the scan is `incomplete`: the balance shows "···", never a
//                        figure that might be short. cUSD has no spend path yet, so there is no
//                        reason to state a number the chain has not vouched for.
//
// The claim's own output is also asked for by id (crypto/cusdStore) until a listing has it — the
// listing trails a fresh output by a minute or more.
//
// ── PUBLIC cUSD ──────────────────────────────────────────────────────────────
//
// The account component's state names its vaults (CBOR tag 132); each is read verified and its
// Stealth container's `revealed_amount` for the cUSD resource is summed — decodeRevealedAmount, the
// TARI public read's own decoder. A missing account is a real zero; anything unverified is unknown.

import { decryptOwnedUtxo, Network, WasmStealthCrypto, type IndexerGetSubstateResponse } from '@tari-project/ootle'
import { CUSD_ASSET } from './assets'
import { loadAccountAddress } from './accountStore'
import { knownCusdIds, spentCusdIds } from './tradeStore'
import { INDEXER_URLS, POINT_READ_TIMEOUT_MS, pointRead } from './indexerConfig'
import { fetchWithRetry } from './indexerRetry'
import { decodeRevealedAmount } from './revealedBalance'
import { fetchAllUtxoRows, type UtxoRow } from './utxoFeed'

// ── Verified point reads ─────────────────────────────────────────────────────

export type VerifiedRead =
  /** An indexer answered 200 with `verified: true`. */
  | { kind: 'verified'; body: unknown }
  /** Every indexer that answered said 404 — a real absence. */
  | { kind: 'absent' }
  /** Nothing verified could be established (unreachable, busy, or only unverified answers). */
  | { kind: 'unknown' }

export type VerifiedReader = (path: string) => Promise<VerifiedRead>

/**
 * `path` from each indexer in turn, believing only a verified body. A 404 is believed only when no
 * node returned a body at all — one node's 404 and another's unverified 200 is `unknown`.
 */
export const verifiedRead: VerifiedReader = async (path) => {
  let notFound = 0
  let other = 0
  for (const base of INDEXER_URLS) {
    let res: Response
    try {
      res = await fetchWithRetry([base], path, {}, { attempts: 2, timeoutMs: POINT_READ_TIMEOUT_MS })
    } catch { other++; continue }
    if (res.status === 404) { notFound++; continue }
    if (!res.ok) { other++; continue }
    try {
      const body = await res.json() as { verified?: unknown }
      if (body?.verified === true) return { kind: 'verified', body }
    } catch { /* unparseable is not an answer */ }
    other++
  }
  return notFound > 0 && other === 0 ? { kind: 'absent' } : { kind: 'unknown' }
}

// ── Private ──────────────────────────────────────────────────────────────────

export interface CusdOutput {
  /** `utxo_<cusd>_<commitment>`. */
  id: string
  /** Base units, decrypted from the verified body. */
  units: bigint
}

export interface CusdPrivateScan {
  outputs: CusdOutput[]
  /** Sum of `outputs`. Only meaningful when `incomplete` is false. */
  units: bigint
  /** True when any owned output could not be verified, or a listing walk was short. */
  incomplete: boolean
  /** Owned ids no indexer would vouch for this time. Diagnostic. */
  unverified: string[]
  /** Owned ids the chain definitively says are gone (spent / absent). Diagnostic. */
  gone: string[]
  /** Claim outputs asked for by id because no listing had them yet. Diagnostic. */
  recovered: string[]
  /** Our own outputs counted from an unverified (fresh) indexer body. Diagnostic. */
  ownUnverified: string[]
  /** Rows in the cUSD listing union. Diagnostic. */
  listed: number
}

/** Does this view key open the substate `body` (a `Utxo` body) at `id`? Null if not ours. */
export type CusdOpener = (id: string, utxoBody: unknown) => Promise<bigint | null>

let sharedCrypto: WasmStealthCrypto | undefined

export function viewKeyOpener(viewSecret: Uint8Array): CusdOpener {
  return async (id, utxoBody) => {
    try {
      const crypto = (sharedCrypto ??= new WasmStealthCrypto(Network.Esmeralda))
      const wrapped = { version: 0, verified: false, substate: { Utxo: utxoBody } } as IndexerGetSubstateResponse
      const d = await decryptOwnedUtxo(crypto, viewSecret, wrapped, id)
      return d === null ? null : d.value
    } catch {
      return null   // a failed trial decrypt is the ordinary "not ours"
    }
  }
}

const cusdId = (commitment: string) => `utxo_${CUSD_ASSET.resourceHex}_${commitment}`

/**
 * Every private cUSD output this wallet owns, each confirmed by a verified read.
 *
 * `listRows`, `read` and `open` are seams for the tests; the defaults are the network and the wasm.
 */
export async function scanCusdPrivate(opts: {
  walletAddress?: string
  open: CusdOpener
  signal?: AbortSignal
  listRows?: () => Promise<{ rows: UtxoRow[]; incomplete: boolean }>
  read?: VerifiedReader
  /** Output ids to ask for even if unlisted. Defaults to this wallet's own cUSD outputs (claims, trades). */
  knownIds?: readonly string[]
  /** Coins already spent by this wallet (tradeStore.spentCusdIds by default) — never counted. */
  spentIds?: ReadonlySet<string>
  /**
   * A plain (unverified) read of one substate, for this wallet's OWN outputs only: the body, `null`
   * when every indexer said 404, `undefined` when none answered. Defaults to indexerConfig.pointRead.
   */
  readAny?: (path: string) => Promise<unknown | null | undefined>
}): Promise<CusdPrivateScan> {
  const read = opts.read ?? verifiedRead
  const feed = await (opts.listRows
    ? opts.listRows()
    : fetchAllUtxoRows({ resourceHex: CUSD_ASSET.resourceHex, signal: opts.signal }))

  // Coins this wallet has spent in a trade: never counted, whatever a lagging indexer still says.
  const spent = opts.spentIds ?? (opts.walletAddress ? spentCusdIds(opts.walletAddress) : new Set<string>())

  // Owned per the listing — a hint that something of ours exists at this id.
  const candidates = new Set<string>()
  for (const [commitment, body] of feed.rows) {
    if (opts.signal?.aborted) break
    const id = cusdId(commitment)
    if (spent.has(id)) continue
    if (await opts.open(id, body) !== null) candidates.add(id)
  }

  // Our own outputs the listing does not have yet.
  const listed = new Set(feed.rows.map(([c]) => cusdId(c)))
  // Our own cUSD outputs — the faucet claim's and every trade's (crypto/tradeStore includes the claims).
  const known = opts.knownIds ?? (opts.walletAddress ? knownCusdIds(opts.walletAddress) : [])
  const recovered: string[] = []
  for (const id of known) {
    if (!id.startsWith(`utxo_${CUSD_ASSET.resourceHex}_`)) continue   // only ever cUSD ids
    if (listed.has(id) || candidates.has(id) || spent.has(id)) continue
    candidates.add(id)
    recovered.push(id)
  }

  // OUR OWN OUTPUTS — a claim's, a trade's change or receive, a filled order's payout: built by this
  // wallet, in a transaction that committed. A freshly written substate is served `verified: false`
  // for a while (measured: ~40-50 s after commit), and treating that as "unknown" left a just-claimed
  // 10,000 cUSD as "···". So for these ids only, a live body any indexer serves — that our view key
  // opens, at the value it opens to — counts. It can never make the figure short, and a coin this
  // wallet spent is already excluded above. Anything else still needs a verified read.
  const own = new Set(known.filter(id => !spent.has(id)))
  const readAny = opts.readAny ?? (async (path: string) => {
    const r = await pointRead(path)
    return r.answered ? r.body : undefined
  })

  const outputs: CusdOutput[] = []
  const unverified: string[] = []
  const gone: string[] = []
  const ownUnverified: string[] = []
  for (const id of candidates) {
    if (opts.signal?.aborted) break
    const path = `/substates/${encodeURIComponent(id)}`
    const r = await read(path)
    if (r.kind === 'unknown') {
      if (own.has(id)) {
        const body = await readAny(path).catch(() => undefined)
        const utxo = (body as { substate?: { Utxo?: { output?: unknown } } } | null | undefined)?.substate?.Utxo
        if (utxo?.output != null) {
          const units = await opts.open(id, utxo)
          if (units !== null) { outputs.push({ id, units }); ownUnverified.push(id); continue }
        }
      }
      unverified.push(id)
      continue
    }
    if (r.kind === 'absent') { gone.push(id); continue }
    const utxo = (r.body as { substate?: { Utxo?: { output?: unknown } } })?.substate?.Utxo
    if (!utxo || utxo.output == null) { gone.push(id); continue }   // spent / frozen: `output: null`
    // THE VALUE FROM THE VERIFIED BODY. A recovered id that our key does not open is not ours.
    const units = await opts.open(id, utxo)
    if (units === null) { gone.push(id); continue }
    outputs.push({ id, units })
  }

  return {
    outputs,
    units: outputs.reduce((s, o) => s + o.units, 0n),
    incomplete: feed.incomplete || unverified.length > 0 || !!opts.signal?.aborted,
    unverified,
    gone,
    recovered,
    ownUnverified,
    listed: feed.rows.length,
  }
}

// ── Public ───────────────────────────────────────────────────────────────────

export type CusdPublicRead = { kind: 'ok'; units: bigint } | { kind: 'unknown'; reason: string }

/** The vault ids an account component's state names (CBOR tag 132, or a plain `vault_` string). */
export function accountVaultIds(componentBody: unknown): string[] | null {
  const state = (componentBody as { substate?: { Component?: { body?: { state?: unknown } } } })
    ?.substate?.Component?.body?.state
  if (state === undefined) return null
  const found = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') { if (/^vault_[0-9a-f]{64}$/.test(v)) found.add(v); return }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (o['@cbor'] === 'tag' && o.tag === 132) {
      const inner = o.value as Record<string, unknown> | undefined
      const hex = inner && inner['@cbor'] === 'bytes' ? inner.hex : inner
      if (typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex)) found.add(`vault_${hex}`)
      return
    }
    for (const x of Object.values(o)) walk(x)
  }
  walk(state)
  return [...found]
}

/** Public cUSD held in this wallet's account. A wallet with no account holds zero. */
export async function readCusdPublic(accountAddress: string | null, read: VerifiedReader = verifiedRead): Promise<CusdPublicRead> {
  if (!accountAddress) return { kind: 'ok', units: 0n }
  const acct = await read(`/substates/${accountAddress}`)
  if (acct.kind === 'absent') return { kind: 'ok', units: 0n }          // never created: nothing held
  if (acct.kind === 'unknown') return { kind: 'unknown', reason: 'could not verify the account' }
  const vaults = accountVaultIds(acct.body)
  if (vaults === null) return { kind: 'unknown', reason: 'the account was not in the expected shape' }
  let units = 0n
  for (const vault of vaults) {
    const v = await read(`/substates/${vault}`)
    // The account itself names this vault, so it must exist: anything but a verified body is unknown.
    if (v.kind !== 'verified') return { kind: 'unknown', reason: `could not verify ${vault}` }
    const amount = decodeRevealedAmount((v.body as { substate?: unknown })?.substate, CUSD_ASSET.resource)
    if (amount !== null) units += amount
  }
  return { kind: 'ok', units }
}

// ── Both ─────────────────────────────────────────────────────────────────────

export interface CusdBalances {
  private: CusdPrivateScan
  public: CusdPublicRead
}

/** The wallet's whole cUSD position. Throws only when no indexer could list cUSD at all. */
export async function scanCusd(viewSecret: Uint8Array, walletAddress: string, signal?: AbortSignal): Promise<CusdBalances> {
  const [priv, pub] = await Promise.all([
    scanCusdPrivate({ walletAddress, open: viewKeyOpener(viewSecret), signal }),
    readCusdPublic(loadAccountAddress(walletAddress)),
  ])
  return { private: priv, public: pub }
}

/** The figure to show, or null when either half is not established. */
export function cusdTotal(b: CusdBalances | null): bigint | null {
  if (!b || b.private.incomplete || b.public.kind !== 'ok') return null
  return b.private.units + b.public.units
}

/**
 * `balances` with one more private output of ours counted — a cUSD output this wallet just created
 * (its faucet claim), added the moment the claim commits. Unchanged when already counted.
 */
export function addCusdOutput(balances: CusdBalances, outputId: string, units: bigint): CusdBalances {
  if (balances.private.outputs.some(o => o.id === outputId)) return balances
  return {
    ...balances,
    private: { ...balances.private, outputs: [...balances.private.outputs, { id: outputId, units }], units: balances.private.units + units },
  }
}
