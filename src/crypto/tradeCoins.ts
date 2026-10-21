// The private coins a trade may spend — tTARI or cUSD — each one confirmed LIVE ON EVERY INDEXER
// before it goes into a transaction.
//
// tTARI comes from the wallet's own coin scan (crypto/stealthUtxos, minus its spent record). cUSD is
// found the way the cUSD balance finds it (crypto/cusdScan: the resource's `/utxos` listing on every
// indexer, trial-decrypted with the view key, plus our own recorded outputs asked for by id), but kept
// whole — commitment, nonce, mask and one-time spend key — because spending needs all of it.
//
// A listing keeps showing a spent coin for minutes, and a transaction built on one is refused only
// after it is priced (or, in the main intent, after its fee). So the coins a selection picks are each
// read on EVERY indexer and must be present there with a live output; a dead one is dropped and the
// selection made again (caravel-trade live.ts `coins`, which did the same for every coin).

import { TARI_RESOURCE_ADDRESS, type WasmStealthCrypto } from '@tari-project/ootle'
import { CUSD_ASSET } from './assets'
import { INDEXER_URLS, POINT_READ_TIMEOUT_MS } from './indexerConfig'
import { fetchWithRetry } from './indexerRetry'
import { openOwnedUtxo } from './openUtxo'
import { loadExcludedIds } from './spentOutputs'
import { fromHex, scanOwnedUtxos, selectStealthInputs, type InputSelection, type OwnedUtxo } from './stealthUtxos'
import { fetchAllUtxoRows } from './utxoFeed'
import { spentCusdIds } from './tradeStore'
import { substateValueOf, upgradeSubstateBody } from './substateShape'

/**
 * Is the coin at `id` present with a live output on every indexer? `null`: some node did not answer,
 * or answered with a body that is not a UTXO in either indexer shape. An unreadable body is NOT "not
 * live": reading it so would quietly drop a good coin, as a shape change once did to every read.
 */
export async function liveEverywhere(id: string): Promise<boolean | null> {
  for (const base of INDEXER_URLS) {
    let res: Response
    try {
      res = await fetchWithRetry([base], `/substates/${encodeURIComponent(id)}`, {}, { attempts: 2, timeoutMs: POINT_READ_TIMEOUT_MS })
    } catch { return null }
    if (res.status === 404) return false
    if (!res.ok) return null
    try {
      const body = upgradeSubstateBody(await res.json())
      if (body === null) return false   // a 0.47 `down`: this version is spent
      const utxo = (substateValueOf(body) as { Utxo?: { output?: unknown } } | undefined)?.Utxo
      if (!utxo || typeof utxo !== 'object') return null
      if (utxo.output == null) return false
    } catch { return null }
  }
  return true
}

// cUSD coins this wallet has committed to a transaction that has not settled yet. tTARI has its own
// durable record (crypto/spentOutputs); cUSD ids must never go there — every reader of that record
// treats an id as TARI — so a pending cUSD spend is held out here, in memory, until it settles.
const pendingCusd = new Map<string, Map<string, string>>()   // wallet → (coin id → txId)

export function holdCusdCoins(walletAddress: string, ids: readonly string[], txId: string): void {
  const m = pendingCusd.get(walletAddress) ?? new Map<string, string>()
  for (const id of ids) m.set(id, txId)
  pendingCusd.set(walletAddress, m)
}

export function releaseCusdCoins(walletAddress: string, txId: string): void {
  const m = pendingCusd.get(walletAddress)
  if (!m) return
  for (const [id, t] of m) if (t === txId) m.delete(id)
}

/** Every private cUSD coin this view key opens, whole. `knownIds`: our own outputs, asked for by id. */
async function scanCusdCoins(
  crypto: WasmStealthCrypto,
  viewSecret: Uint8Array,
  walletAddress: string,
  knownIds: readonly string[],
): Promise<OwnedUtxo[]> {
  const prefix = `utxo_${CUSD_ASSET.resourceHex}_`
  // In flight this session, or recorded as spent by a trade (tradeStore) — never selectable again.
  const held = new Set<string>([...(pendingCusd.get(walletAddress)?.keys() ?? []), ...spentCusdIds(walletAddress)])
  const feed = await fetchAllUtxoRows({ resourceHex: CUSD_ASSET.resourceHex })
  const rows = new Map<string, unknown>(feed.rows.map(([c, body]) => [`${prefix}${c}`, body]))
  // Our own outputs a listing has not caught up with: their bodies by id.
  for (const id of knownIds) {
    if (!id.startsWith(prefix) || rows.has(id)) continue
    try {
      const res = await fetchWithRetry(INDEXER_URLS, `/substates/${encodeURIComponent(id)}`, {}, { attempts: 2, timeoutMs: POINT_READ_TIMEOUT_MS, alternate: true })
      if (!res.ok) continue
      const utxo = (substateValueOf(await res.json()) as { Utxo?: { output?: unknown } } | undefined)?.Utxo
      if (utxo?.output != null) rows.set(id, utxo)
    } catch { /* unreachable now; the listing will have it later */ }
  }
  const out: OwnedUtxo[] = []
  for (const [id, body] of rows) {
    if (held.has(id)) continue
    // null is "not ours"; an unreadable body throws, and the selection with it (crypto/openUtxo).
    const d = await openOwnedUtxo(crypto, viewSecret, id, body)
    if (d === null) continue
    const outer = (body as { output?: { output?: { public_nonce?: string }; auth?: { Key?: string } } })?.output
    const nonce = outer?.output?.public_nonce
    const key = outer?.auth?.Key
    if (!nonce || typeof key !== 'string' || !/^[0-9a-f]{64}$/i.test(key)) continue
    out.push({ substateId: id, commitment: fromHex(id.slice(prefix.length)), nonce: fromHex(nonce), value: d.value, mask: d.mask, spendKey: fromHex(key) })
  }
  return out
}

/** This wallet's spendable private coins of `resource` (TARI or cUSD), not yet checked live. */
export async function scanTradeCoins(
  crypto: WasmStealthCrypto,
  viewSecret: Uint8Array,
  walletAddress: string,
  resource: string,
  knownCusdIds: readonly string[] = [],
): Promise<OwnedUtxo[]> {
  if (resource === TARI_RESOURCE_ADDRESS) {
    const coins = await scanOwnedUtxos(crypto, viewSecret, { walletAddress, excluded: loadExcludedIds(walletAddress) })
    return coins.filter(c => c.spendKey)
  }
  if (resource === CUSD_ASSET.resource) return scanCusdCoins(crypto, viewSecret, walletAddress, knownCusdIds)
  throw new Error(`Not a tradeable resource: ${resource}`)
}

/**
 * Coins covering `target`, every one of them live on every indexer. A dead coin is dropped and the
 * choice made again; a coin no indexer would answer for stops the trade (it may be live, and spending
 * around it would only defer the same question).
 */
export async function selectLiveCoins(coins: OwnedUtxo[], target: bigint, what: string): Promise<InputSelection<OwnedUtxo>> {
  let pool = coins
  for (let round = 0; round < 8; round++) {
    let sel: InputSelection<OwnedUtxo>
    try {
      sel = selectStealthInputs(pool, target)
    } catch {
      const have = pool.reduce((s, c) => s + c.value, 0n)
      throw new Error(`Not enough private ${what}: this needs ${target}, and the wallet holds ${have} spendable.`)
    }
    const dead: string[] = []
    for (const c of sel.inputs) {
      const live = await liveEverywhere(c.substateId)
      if (live === null) throw new Error(`Could not confirm your private ${what} on every indexer. Nothing was sent — try again in a moment.`)
      if (!live) dead.push(c.substateId)
    }
    if (dead.length === 0) return sel
    pool = pool.filter(c => !dead.includes(c.substateId))
  }
  throw new Error(`Your private ${what} keeps changing while it is being selected. Nothing was sent — try again in a moment.`)
}
