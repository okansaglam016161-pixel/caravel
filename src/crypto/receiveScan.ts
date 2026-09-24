// Finding a payment to us in the transaction that made it, before any listing admits it exists.
//
// ── THE LAG THIS CLOSES ──────────────────────────────────────────────────────
//
// A receive is an output somebody ELSE built, so the wallet has no journal entry naming it and the
// by-id recovery in crypto/ownedFeed has nothing to ask for. Until now the only way to find one was
// the `/utxos` listing — and the listing lags. Measured today:
//
//     utxo_0101…_4c981fc3…f078fd09   /substates → HTTP 200, live, on BOTH nodes
//                                    /utxos, walked to the end → absent on BOTH nodes, for > 1 hour
//
// A committed payment the wallet could not show. The coin was fine; the listing had not caught up.
//
// ── READING THE TRANSACTION INSTEAD ──────────────────────────────────────────
//
// The indexer's `/transactions/recent` carries every transaction it has seen, newest first, with
// its instructions intact. A StealthTransfer's outputs statement holds, for each output, the three
// things a recipient needs to recognise it: the commitment, the sender's public nonce, and the
// encrypted value. Trial-decrypting those with our view key is the same test `decryptOwnedUtxo` runs
// on a listing row — just applied to the transaction, which exists at commit, rather than to the
// listing, which exists some minutes later.
//
// This is the technique the @chironbuilder/ootle-sdk uses (confidential.js), adopted rather than
// imported: the two calls it needs — `listRecentTransactions` and `decryptInputData` — are already
// in the SDK packages this wallet depends on.
//
// ── IT DISCOVERS IDS, IT DOES NOT COUNT MONEY ────────────────────────────────
//
// A transaction in this list may not have committed: most entries carry no receipt summary yet,
// and an aborted one never will. So nothing found here goes near the balance directly. What this
// produces is a list of substate ids, handed to ownedFeed's by-id recovery ALONGSIDE the journal's
// self-output ids. That recovery asks the chain for each one, and only a live `/substates` body
// becomes a row — decrypted, excluded-if-spent and deduplicated exactly like every other row. A
// discovery from a transaction that never landed simply 404s and adds nothing.
//
// ── THE LISTING STAYS ────────────────────────────────────────────────────────
//
// This is the FAST path for NEW receives. `/utxos` is still the COMPLETE path, and the only one a
// restored wallet on a fresh device has for anything older than the first walk reached. The two
// union, the same way by-id recovery already unions with the listing.

import { decryptInputData, Network, WasmStealthCrypto, type StealthCryptoProvider } from '@tari-project/ootle'
import { IndexerClient } from '@tari-project/ootle-indexer'
import { INDEXER_URLS } from './indexerConfig'
import { asRecord, loadStore, writeStore } from './storeIo'
import { RESOURCE_HEX } from './utxoFeed'

// ── Budgets ───────────────────────────────────────────────────────────────────

/** The indexer's own cap: `limit=101` answers "Limit cannot be greater than 100". */
export const RECENT_PAGE_LIMIT = 100

/**
 * The first page of an incremental walk, when there is a cursor to reach.
 *
 * A full page is ~440 KB of transaction JSON. Between two scans a handful of transactions arrive,
 * so the cursor is almost always inside the first ten — and asking for ten costs a tenth. Pages
 * after the first use the full limit.
 */
export const PROBE_PAGE_LIMIT = 10

/**
 * Most pages the FIRST walk on a device may read, per indexer.
 *
 * The SDK's figure. With no cursor there is nothing to stop at, so the walk goes back until history
 * ends or this runs out — 400 × 100 = 40 000 transactions. Esmeralda today ends after ~200, so in
 * practice the first walk is three pages. Anything older than the budget is `/utxos`'s job.
 */
export const FIRST_SCAN_PAGE_BUDGET = 400

/**
 * Most pages an INCREMENTAL walk may read, per indexer, before it stops and remembers where it got
 * to — see the gap rule below. 4 000 transactions between two scans is far past anything this
 * network produces; the bound is there so a pathological one cannot stall the balance.
 */
export const SCAN_PAGE_BUDGET = 40

/** Per-page ceiling, so one unresponsive node cannot hold the balance scan hostage. */
export const PAGE_TIMEOUT_MS = 10_000

/**
 * Most discovered ids kept. Newest wins. Each costs at most one point read per scan, and only
 * while no listing carries it — ownedFeed filters listed ones before asking.
 */
export const MAX_DISCOVERED = 256

/**
 * How long a discovered id may keep answering "not there" before it is let go.
 *
 * A transaction that aborted created nothing, and its outputs will 404 forever. But a fresh commit
 * can also 404 for a few seconds before the substate is readable. Half an hour separates the two
 * with room to spare. Only a DEFINITE absence counts — every node saying 404 — never a timeout.
 */
export const RETIRE_AFTER_MS = 30 * 60_000

// ── The cursor store ──────────────────────────────────────────────────────────
//
// Per identity, sealed alongside utxospent and utxoseen: which transactions carried a payment to
// this wallet is exactly the linkage those stores are sealed to protect.

/**
 * How far one indexer's history has been read.
 *
 *   cursor  the newest transaction id such that EVERYTHING from it back to the start of this
 *           device's reading has been walked (except the gap below). `null` before the first walk.
 *   gap     a stretch a walk ran out of budget inside: everything newer than `upper` has been read,
 *           everything older than `resume` down to `cursor` has NOT. The next walk resumes it.
 */
export interface IndexerCursor {
  cursor: string | null
  gap: { upper: string; resume: string } | null
}

/** One output the view key opened, and where. */
export interface Discovered {
  txId: string
  /**
   * When the TRANSACTION was created, per the indexer — or when this device found it, if that
   * cannot be read. Never later than the finding. It is the newest-first ordering and the
   * retirement clock, and it has to be the transaction's age for the second: a first walk on a new
   * device opens months-old outputs we have long since spent, and each would otherwise be re-read
   * by id for RETIRE_AFTER_MS merely because it was DISCOVERED recently.
   */
  at: number
}

export interface ReceiveScanState {
  cursors: Record<string, IndexerCursor>
  /** Keyed by substate id. */
  found: Record<string, Discovered>
}

function key(walletAddress: string) { return `caravel.rxscan.v1.${walletAddress}` }

const empty = (): ReceiveScanState => ({ cursors: {}, found: {} })

function parseCursor(v: unknown): IndexerCursor | null {
  const r = asRecord(v)
  if (!r) return null
  const cursor = typeof r.cursor === 'string' ? r.cursor : null
  const g = asRecord(r.gap)
  const gap = g && typeof g.upper === 'string' && typeof g.resume === 'string'
    ? { upper: g.upper, resume: g.resume }
    : null
  return { cursor, gap }
}

function parseState(decoded: unknown): ReceiveScanState | null {
  const r = asRecord(decoded)
  if (!r) return null
  const out = empty()
  for (const [url, c] of Object.entries(asRecord(r.cursors) ?? {})) {
    const parsed = parseCursor(c)
    if (parsed) out.cursors[url] = parsed
  }
  for (const [id, d] of Object.entries(asRecord(r.found) ?? {})) {
    const f = asRecord(d)
    if (f && typeof f.txId === 'string' && typeof f.at === 'number') out.found[id] = { txId: f.txId, at: f.at }
  }
  return out
}

export function loadReceiveScan(walletAddress: string): ReceiveScanState {
  return loadStore(key(walletAddress), parseState, empty)
}

function saveReceiveScan(walletAddress: string, state: ReceiveScanState): boolean {
  return writeStore(key(walletAddress), JSON.stringify(state), parseState)
}

/** Keep the newest MAX_DISCOVERED. */
function capFound(found: Record<string, Discovered>): Record<string, Discovered> {
  const entries = Object.entries(found)
  if (entries.length <= MAX_DISCOVERED) return found
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_DISCOVERED))
}

/**
 * Discovered ids, newest first, with when they were found. What ownedFeed merges with the journal's
 * self-output ids into one recovery candidate list.
 */
export function discoveredReceives(walletAddress: string): { id: string; at: number }[] {
  if (!walletAddress) return []
  return Object.entries(loadReceiveScan(walletAddress).found)
    .map(([id, d]) => ({ id, at: d.at }))
    .sort((a, b) => b.at - a.at)
}

/**
 * Let go of discovered ids that can no longer be a coin of ours.
 *
 * `gone` is every id the chain has definitively answered for — spent by us (the spend record says
 * so), or absent on every node. An absent one is only let go after RETIRE_AFTER_MS, because a
 * commit that happened seconds ago can still 404. Merged against a fresh read, so a concurrent
 * walker's discoveries are never overwritten.
 */
export function retireDiscovered(
  walletAddress: string,
  spent: ReadonlySet<string>,
  absent: ReadonlySet<string>,
  now = Date.now(),
): string[] {
  if (!walletAddress || (spent.size === 0 && absent.size === 0)) return []
  const state = loadReceiveScan(walletAddress)
  const retired: string[] = []
  for (const [id, d] of Object.entries(state.found)) {
    if (spent.has(id) || (absent.has(id) && now - d.at >= RETIRE_AFTER_MS)) {
      delete state.found[id]
      retired.push(id)
    }
  }
  if (retired.length > 0) saveReceiveScan(walletAddress, state)
  return retired
}

// ── Reading a transaction ─────────────────────────────────────────────────────

/** What a page of `/transactions/recent` gives us, as far as this module needs it. */
export interface RecentTxEntry {
  transaction_id: string
  transaction?: unknown
  /** `"2026-09-24 20:24:38.0"` — UTC, space-separated, no zone. */
  created_at?: string
}

/** The indexer's `created_at` as epoch ms, or null. It carries no zone and is UTC. */
export function txCreatedAt(entry: RecentTxEntry): number | null {
  const raw = entry.created_at
  if (typeof raw !== 'string' || raw.length < 10) return null
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const ms = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`)
  return Number.isFinite(ms) ? ms : null
}

/** One page, newest first, older than `lastId`. Injectable so the walk is testable without a node. */
export type RecentPageFetcher = (
  indexerUrl: string,
  lastId: string | null,
  limit: number,
) => Promise<RecentTxEntry[]>

const clients = new Map<string, IndexerClient>()

const fetchRecentPage: RecentPageFetcher = async (indexerUrl, lastId, limit) => {
  let client = clients.get(indexerUrl)
  if (!client) {
    client = IndexerClient.usingFetchTransport(indexerUrl)
    clients.set(indexerUrl, client)
  }
  // The client's transport takes no signal, so the ceiling is a race. A lost race leaves one
  // request to finish in the background, which is harmless; a stalled balance scan is not.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${indexerUrl}/transactions/recent timed out`)), PAGE_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([
      client.listRecentTransactions({ limit, last_id: lastId, source: null }),
      timeout,
    ])
    return (res?.transactions ?? []) as unknown as RecentTxEntry[]
  } finally {
    clearTimeout(timer)
  }
}

/** A stealth output as a transaction carries it: enough to try our view key on it. */
export interface CarriedOutput {
  commitment: string
  senderPublicNonce: string
  encryptedData: string
}

const TARI_RESOURCE = `resource_${RESOURCE_HEX}`
const isHex = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s)

/**
 * Every TARI stealth output a transaction creates.
 *
 * FEE INSTRUCTIONS TOO: a faucet claim and a fee-paying transfer put their StealthTransfer in
 * `fee_instructions`, and a payment built that way is still a payment. Other resources are
 * skipped — the balance is TARI, and a substate id built from the wrong resource would name a coin
 * this wallet does not count. A Workspace resource reference cannot be resolved from the
 * transaction alone, so it is skipped rather than guessed; the listing still has it.
 */
export function carriedOutputs(entry: RecentTxEntry): CarriedOutput[] {
  const tx = (entry?.transaction as { V1?: { body?: { transaction?: Record<string, unknown> } } } | undefined)
    ?.V1?.body?.transaction
  if (!tx) return []
  const instructions = [
    ...(Array.isArray(tx.fee_instructions) ? tx.fee_instructions : []),
    ...(Array.isArray(tx.instructions) ? tx.instructions : []),
  ] as unknown[]

  const out: CarriedOutput[] = []
  for (const ins of instructions) {
    if (!ins || typeof ins !== 'object' || !('StealthTransfer' in ins)) continue
    const st = (ins as { StealthTransfer?: Record<string, unknown> }).StealthTransfer
    const ref = st?.resource_address_ref as { Address?: unknown } | undefined
    if (ref?.Address !== TARI_RESOURCE) continue
    const outputs = (st?.statement as { outputs_statement?: { outputs?: unknown } } | undefined)
      ?.outputs_statement?.outputs
    if (!Array.isArray(outputs)) continue
    for (const o of outputs) {
      const body = (o as { output?: Record<string, unknown> } | null)?.output
      if (!body) continue
      const { commitment, sender_public_nonce, encrypted_data } = body
      if (!isHex(commitment) || !isHex(sender_public_nonce) || !isHex(encrypted_data)) continue
      out.push({ commitment: commitment.toLowerCase(), senderPublicNonce: sender_public_nonce, encryptedData: encrypted_data })
    }
  }
  return out
}

function hexBytes(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16)
  return bytes
}

/** Does our view key open this output? A throw is the "not ours" signal, exactly as for a row. */
export type OwnershipTest = (output: CarriedOutput) => Promise<boolean>

function viewKeyTest(crypto: StealthCryptoProvider, viewSecret: Uint8Array): OwnershipTest {
  return async (o) => {
    try {
      await decryptInputData(crypto, hexBytes(o.commitment), hexBytes(o.encryptedData), {
        senderPublicNonce: hexBytes(o.senderPublicNonce),
        viewSecret,
        skipMemo: true,
      })
      return true
    } catch {
      return false
    }
  }
}

// ── The walk ─────────────────────────────────────────────────────────────────

/** A transaction output this wallet's view key opened. */
export interface ReceiveHit {
  substateId: string
  commitment: string
  txId: string
  /** See Discovered.at. */
  at: number
}

interface Segment {
  /** First entry seen — the newest transaction this segment read. */
  head: string | null
  /** Last entry seen — where a resumed walk continues from. */
  last: string | null
  /** The stop id was met. Everything between the start and it has been read. */
  reached: boolean
  /** A page came back short: the node has nothing older. Also a complete read. */
  ended: boolean
  /** A request failed. Nothing about completeness may be concluded. */
  failed: boolean
  pages: number
}

async function walkSegment(
  url: string,
  from: string | null,
  stopAt: string | null,
  budget: number,
  fetchPage: RecentPageFetcher,
  visit: (entry: RecentTxEntry) => Promise<void>,
  signal?: AbortSignal,
): Promise<Segment> {
  const seg: Segment = { head: null, last: null, reached: false, ended: false, failed: false, pages: 0 }
  let lastId = from
  while (seg.pages < budget) {
    if (signal?.aborted) { seg.failed = true; return seg }
    // Small first page only when there is somewhere to stop — see PROBE_PAGE_LIMIT.
    const limit = seg.pages === 0 && stopAt !== null ? PROBE_PAGE_LIMIT : RECENT_PAGE_LIMIT
    let entries: RecentTxEntry[]
    try {
      entries = await fetchPage(url, lastId, limit)
    } catch {
      seg.failed = true
      return seg
    }
    seg.pages++
    for (const e of entries) {
      if (typeof e?.transaction_id !== 'string') continue
      seg.head ??= e.transaction_id
      if (stopAt !== null && e.transaction_id === stopAt) { seg.reached = true; return seg }
      seg.last = e.transaction_id
      await visit(e)
    }
    if (entries.length < limit) { seg.ended = true; return seg }
    lastId = seg.last
  }
  return seg
}

/** What one indexer's walk did. The harness prints these. */
export interface IndexerWalk {
  url: string
  before: IndexerCursor
  after: IndexerCursor
  pages: number
  /**
   *   first     no cursor: walked back within FIRST_SCAN_PAGE_BUDGET, cursor set to the newest.
   *   reached   the previous cursor was met — advanced.
   *   ended     history ran out before the cursor (the node no longer has it) — everything the
   *             node holds was read, so advancing skips nothing it could have shown us.
   *   gap       budget ran out before the cursor — cursor HELD, the unread stretch remembered.
   *   held      a request failed, or a second gap would have opened — nothing changed.
   */
  outcome: 'first' | 'reached' | 'ended' | 'gap' | 'held'
}

/**
 * THE CURSOR-ADVANCE RULE, and why it is the part of this worth getting right.
 *
 * The cursor says "everything newer than this I have read". If it ever moves past a transaction the
 * walk did not actually read, a payment in that transaction is never looked at again by this path —
 * silently, forever. So the cursor advances ONLY on proof of contiguity:
 *
 *   • the walk MET the previous cursor, or
 *   • the node's history ENDED before it (a short page) — there is nothing more to read there.
 *
 * Running out of budget is neither. Then the cursor stays where it is and the unread stretch is
 * written down as a gap — `upper` (newest read) and `resume` (where to continue) — so the next walk
 * reads new transactions down to `upper` and then carries on from `resume` down to the cursor. The
 * cursor moves to `upper` only when that stretch is closed the same way. A failed request concludes
 * nothing and changes nothing.
 *
 * THE ONE EXCEPTION IS THE FIRST WALK. With no cursor there is no gap to protect: nothing older has
 * been promised. The walk goes back FIRST_SCAN_PAGE_BUDGET pages and the cursor starts at the
 * newest; older history is the `/utxos` listing's, which is the complete path and always runs.
 */
export async function advanceIndexer(
  url: string,
  before: IndexerCursor,
  fetchPage: RecentPageFetcher,
  visit: (entry: RecentTxEntry) => Promise<void>,
  signal?: AbortSignal,
): Promise<IndexerWalk> {
  const first = before.cursor === null && before.gap === null
  const budget = first ? FIRST_SCAN_PAGE_BUDGET : SCAN_PAGE_BUDGET
  const report = (after: IndexerCursor, pages: number, outcome: IndexerWalk['outcome']): IndexerWalk =>
    ({ url, before, after, pages, outcome })

  // 1 — new transactions, from the top down to whatever was read last.
  const stop = before.gap?.upper ?? before.cursor
  const top = await walkSegment(url, null, stop, budget, fetchPage, visit, signal)
  if (top.failed) return report(before, top.pages, 'held')

  if (first) {
    return report({ cursor: top.head, gap: null }, top.pages, 'first')
  }

  let after: IndexerCursor
  let outcome: IndexerWalk['outcome']
  if (top.reached || top.ended) {
    // Contiguous down to `stop`. With a gap below, only the gap's upper edge moves up.
    const head = top.head ?? stop
    if (before.gap && top.reached) {
      after = { cursor: before.cursor, gap: { upper: head!, resume: before.gap.resume } }
      outcome = 'gap'
    } else {
      // No gap, or the node's history ended above it (so the gap is unreadable there too).
      after = { cursor: head, gap: null }
      return report(after, top.pages, top.reached ? 'reached' : 'ended')
    }
  } else if (before.gap) {
    // Budget spent above an existing gap. Opening a second one is not worth the bookkeeping, and
    // holding is safe: the next walk simply reads this stretch again.
    return report(before, top.pages, 'held')
  } else {
    after = { cursor: before.cursor, gap: { upper: top.head!, resume: top.last! } }
    outcome = 'gap'
  }

  // 2 — the gap, with what budget is left.
  let pages = top.pages
  const remaining = budget - pages
  if (after.gap && remaining > 0) {
    const g = await walkSegment(url, after.gap.resume, after.cursor, remaining, fetchPage, visit, signal)
    pages += g.pages
    if (!g.failed) {
      if (g.reached || g.ended) {
        after = { cursor: after.gap.upper, gap: null }
        outcome = 'reached'
      } else if (g.last !== null) {
        after = { cursor: after.cursor, gap: { upper: after.gap.upper, resume: g.last } }
      }
    }
  }
  return report(after, pages, outcome)
}

// ── Entry point ───────────────────────────────────────────────────────────────

export interface ReceiveScanReport {
  /** Outputs our view key opened during THIS walk. */
  hits: ReceiveHit[]
  walks: IndexerWalk[]
  /** Transactions looked at, across every indexer (the same one on two nodes counts twice). */
  txsRead: number
}

let sharedCrypto: WasmStealthCrypto | null = null

/**
 * Walk each indexer's recent transactions since its cursor, trial-decrypt every TARI stealth
 * output in them, and remember the ones that are ours.
 *
 * EVERY CONFIGURED INDEXER, each with its own cursor, for the reason the listing reads both: the
 * nodes disagree, and a transaction id is only meaningful as a cursor on the node that listed it.
 * An incremental walk is normally one ten-entry page per node.
 *
 * NEVER THROWS for a network reason: a node that will not answer holds its cursor and contributes
 * nothing, and the `/utxos` path is unaffected either way.
 */
export async function scanRecentReceives(opts: {
  walletAddress: string
  viewSecret: Uint8Array
  indexerUrls?: readonly string[]
  signal?: AbortSignal
  /** Test seams. */
  fetchPage?: RecentPageFetcher
  isOurs?: OwnershipTest
  now?: number
}): Promise<ReceiveScanReport> {
  const urls = opts.indexerUrls ?? INDEXER_URLS
  const fetchPage = opts.fetchPage ?? fetchRecentPage
  const isOurs = opts.isOurs
    ?? viewKeyTest((sharedCrypto ??= new WasmStealthCrypto(Network.Esmeralda)), opts.viewSecret)
  const now = opts.now ?? Date.now()

  const before = loadReceiveScan(opts.walletAddress)
  const hits = new Map<string, ReceiveHit>()
  const tested = new Set<string>()
  let txsRead = 0

  const visit = async (entry: RecentTxEntry) => {
    txsRead++
    for (const o of carriedOutputs(entry)) {
      // The same transaction on two nodes carries the same outputs. One decrypt each.
      if (tested.has(o.commitment)) continue
      tested.add(o.commitment)
      if (await isOurs(o)) {
        const substateId = `utxo_${RESOURCE_HEX}_${o.commitment}`
        const created = txCreatedAt(entry)
        const at = created === null ? now : Math.min(created, now)
        hits.set(substateId, { substateId, commitment: o.commitment, txId: entry.transaction_id, at })
      }
    }
  }

  const walks = await Promise.all(urls.map(url => advanceIndexer(
    url, before.cursors[url] ?? { cursor: null, gap: null }, fetchPage, visit, opts.signal,
  )))

  // MERGED AGAINST A FRESH READ, not written over `before`. A send and a balance scan can walk at
  // the same time. Discoveries are unioned, so neither can erase the other's; the cursor is taken
  // from this walk, and any walker's cursor is truthful about what THAT walker read — so the worst
  // a race can do is move a cursor back, which re-reads, never forward past something unread.
  const fresh = loadReceiveScan(opts.walletAddress)
  for (const w of walks) fresh.cursors[w.url] = w.after
  for (const h of hits.values()) {
    if (!fresh.found[h.substateId]) fresh.found[h.substateId] = { txId: h.txId, at: h.at }
  }
  fresh.found = capFound(fresh.found)
  saveReceiveScan(opts.walletAddress, fresh)

  return { hits: [...hits.values()], walks, txsRead }
}
