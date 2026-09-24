// Every stealth UTXO the indexer will show us, read to the end.
//
// ── THE BUG THIS MODULE EXISTS TO END ────────────────────────────────────────
//
// `/utxos` is not a query for YOUR outputs. It lists the whole network's unspent UTXOs for a
// resource — the indexer filters on resource, spent and burnt, and nothing else — and a wallet
// finds its own by trial-decrypting every row. Both scanners knew that. What neither did was read
// past the first page:
//
//     GET /utxos?resource_address=<hex>&limit=1000        ← and stop
//
// The handler caps `limit` at 1000 and the query is `ORDER BY id ASC`, so that request returns the
// ONE THOUSAND OLDEST unspent outputs on the network. While Esmeralda held fewer than a thousand it
// was the whole set and everything worked. Past a thousand it is a window that never moves, every
// newly created output sorts after it, and a wallet's own funds become permanently invisible the
// moment they are created — no error, no empty response, just a balance that stops counting.
//
// THE CURSOR WAS ALWAYS THERE. Both files carried the note "the indexer IGNORES `offset`", which
// was true and led somewhere wrong: `offset` is ignored because it was never a parameter.
// `ListUtxosRequest` is `{ resource_address, limit, from_id: Option<UtxoId> }`, and the query is
// `id > (SELECT id FROM utxos WHERE commitment = from_id)`. It has read like that since at least
// 0.39.3 — this was never a 0.41 regression, it was a cliff the testnet walked off.
//
// ── ONE IMPLEMENTATION, BECAUSE TWO DISAGREEING IS WORSE THAN EITHER ─────────
//
// walletScanner fed the BALANCE and stealthUtxos fed the SPENDABLE INPUTS, from two independent
// copies of the same request. Two copies of "what do I own" can answer differently, and a wallet
// that shows one number and can spend another is a worse failure than either being wrong alone.
// They page through here now, so a change to how the set is read cannot land in one and not the
// other — the same argument stealthUtxos already makes for sharing input selection.

import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import { INDEXER_URLS } from './indexerConfig'

/** The TARI resource address with its `resource_` prefix stripped — the form `/utxos` wants, and
 *  the form the `utxo_<resource>_<commitment>` substate id is built from. */
export const RESOURCE_HEX = TARI_RESOURCE_ADDRESS.replace(/^resource_/, '')

/**
 * Rows per request.
 *
 * NOT A CEILING ON THE SET any more — it is the page size, and the loop below keeps asking. 1000 is
 * the handler's own maximum (`cannot query more than 1000 UTXOs` above it, `limit must be greater
 * than 0` below), so it is the fewest round trips the indexer allows.
 */
export const UTXO_PAGE_LIMIT = 1000

/**
 * The runaway guard, and ONLY that.
 *
 * At 1000 rows a page this is 100,000 unspent outputs — far past anything Esmeralda holds, and a
 * hundred times the old effective ceiling. It exists because a cursor that stopped advancing would
 * otherwise loop forever against the network, not to bound what a wallet may own. Reaching it is
 * reported as `incomplete`, which is the same honest signal the old limit raised: the figures may
 * understate, and the UI says so rather than presenting a short count as a fact.
 */
export const MAX_UTXO_PAGES = 100

const FETCH_TIMEOUT_MS = 15_000  // hang guard (feeds the retry below)
const FETCH_RETRIES = 3          // transient failures (timeout / network blip) retry before we give up
const RETRY_BACKOFF_MS = 600     // base backoff between retries (×attempt)

/** A row as the indexer serialises it: `(UtxoId, Utxo)`, i.e. `[commitmentHex, body]`. */
export type UtxoRow = [string, unknown]

/** How one indexer's walk went. Diagnostic — the harness prints these side by side. */
export interface UtxoSource {
  url: string
  /** Rows this node returned, before the union deduplicates them. */
  rows: number
  pages: number
  /** False when the walk threw — a dead host, a timeout, an unparseable body. */
  ok: boolean
  error?: string
}

export interface UtxoFeed {
  /** The UNION across every indexer, deduplicated by commitment. */
  rows: UtxoRow[]
  /**
   * True when the set may be SHORT — and so when nothing may conclude from an absence.
   *
   * Two causes, and they are reported as one because every consumer treats them the same way: a
   * walk that hit its page bound or a stalled cursor, and a node that failed outright while
   * another succeeded. Both mean rows exist that this union never saw.
   */
  incomplete: boolean
  /** Requests across all indexers. Diagnostic only. */
  pages: number
  /** Per-indexer outcome, so a caller can say WHICH node was short or down. */
  sources: UtxoSource[]
}

/** Returns a new AbortSignal that fires when either input fires. */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController()
  if (a.aborted || b.aborted) { ctrl.abort(); return ctrl.signal }
  const abort = () => ctrl.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return ctrl.signal
}

/**
 * One page, with a timeout and a bounded retry.
 *
 * Only throws — surfacing as a scan error and a Retry, never a silent zero — after FETCH_RETRIES
 * attempts. An intentional abort of `signal` (rescan / lock / new identity) is rethrown immediately
 * so the caller can ignore it. A PARTIAL WALK THAT FAILS IS A FAILURE, not a short set: the loop
 * below lets this throw rather than returning the pages it already has, because a truncated set
 * reported as complete is exactly the bug this module was written to end.
 */
async function fetchPage(indexerUrl: string, fromId: string | null, signal: AbortSignal): Promise<UtxoRow[]> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException('scan aborted', 'AbortError')

    const reqCtrl = new AbortController()
    let timedOut = false
    const reqTimer = setTimeout(() => { timedOut = true; reqCtrl.abort() }, FETCH_TIMEOUT_MS)
    const reqSignal = mergeSignals(signal, reqCtrl.signal)

    try {
      const cursor = fromId === null ? '' : `&from_id=${encodeURIComponent(fromId)}`
      const resp = await fetch(
        `${indexerUrl}/utxos?resource_address=${RESOURCE_HEX}&limit=${UTXO_PAGE_LIMIT}${cursor}`,
        { signal: reqSignal },
      )
      clearTimeout(reqTimer)
      if (!resp.ok) throw new Error(`indexer returned HTTP ${resp.status}`)
      const json = await resp.json() as { utxos?: UtxoRow[] }
      if (!Array.isArray(json.utxos)) throw new Error('unexpected indexer response shape')
      return json.utxos
    } catch (e) {
      clearTimeout(reqTimer)
      if (signal.aborted) throw e   // intentional abort — stop now; the caller ignores aborted scans
      lastErr = timedOut ? new Error('indexer request timed out') : e
      // Transient failure — back off and retry before giving up.
      if (attempt < FETCH_RETRIES) await new Promise<void>(r => setTimeout(r, RETRY_BACKOFF_MS * attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`utxo fetch failed: ${String(lastErr)}`)
}

/**
 * Walk `/utxos` to the end.
 *
 * ── TERMINATION, AND WHY EACH BRANCH IS WHERE IT IS ─────────────────────────
 *
 *   a SHORT page (< limit) is the end of the set. The only honest stop, and the normal one.
 *   a FULL page (== limit) means "there may be more" — ask again from its last id.
 *   an EMPTY first page is a real zero: the resource has no unspent outputs. Not an error.
 *
 * ── THE CURSOR DOES NOT REPEAT OR SKIP A ROW ────────────────────────────────
 *
 * `from_id` is the last row we HAVE, and the indexer's filter is `id > from_id` — strictly greater.
 * So the next page starts at the row after it: the boundary row is neither returned twice nor
 * stepped over. That is the whole of the off-by-one argument, and it is the reason the cursor is
 * the last row rather than a count of rows consumed.
 *
 * Deduplication stays anyway, for the reason it was there before pagination existed: the indexer
 * can serve the same UTXO twice, and a duplicate counted into a balance overstates it while a
 * duplicate in an input selection is a self-double-spend.
 */
async function walkOne(
  indexerUrl: string,
  signal: AbortSignal,
  onPage: () => void,
): Promise<{ rows: UtxoRow[]; incomplete: boolean; pages: number }> {
  const rows: UtxoRow[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  let pages = 0

  while (pages < MAX_UTXO_PAGES) {
    const page: UtxoRow[] = await fetchPage(indexerUrl, cursor, signal)
    pages++

    for (const row of page) {
      const id = row[0]
      if (seen.has(id)) continue
      seen.add(id)
      rows.push(row)
    }
    onPage()

    // The end of the set: the indexer had fewer than a full page left to give.
    if (page.length < UTXO_PAGE_LIMIT) return { rows, incomplete: false, pages }

    // A full page, so there may be more. The cursor is the last row of THIS page.
    const next = page[page.length - 1]![0]
    // A cursor that did not advance would loop forever — the indexer rejecting our id, or serving
    // the same page again. Stop and say the set is incomplete rather than spin against the network.
    if (next === cursor) break
    cursor = next
  }

  // Either the page bound or the stalled cursor above. Both mean: there may be rows we never saw.
  return { rows, incomplete: true, pages }
}

/**
 * The union of every indexer's `/utxos`, walked to the end.
 *
 * ── WHY A UNION, AND WHY IT IS SAFE ─────────────────────────────────────────
 *
 * `/utxos` is the indexer's list of UNSPENT outputs for a resource, and the two public nodes do
 * not agree on it. Measured at one moment, both walked to the end: 1118 rows on indexer-a, 1112 on
 * indexer-b, 1125 in the union — 13 rows only on a, 7 only on b. SYMMETRIC, so there is no "good
 * node" to pick; a wallet reading either alone is missing coins, and which ones depends on the host
 * it happened to be pointed at.
 *
 * A union of unspent listings is the right combiner because the failure is OMISSION, not
 * invention. A node that lists a coin has seen it; a node that omits one has not necessarily seen
 * it spent. So "present on any node" is the closest thing to the truth available from listings.
 *
 * THE CONVERSE — a coin one node still lists while another has seen it spent — is NOT guarded
 * here, deliberately. The union may therefore carry a stale row, and two existing guards already
 * cover exactly that: crypto/spentOutputs excludes anything this wallet has spent itself, and a
 * genuinely down input is refused by the chain at submission ("Input substate ... is down"), which
 * crypto/lockSweep then resolves against `/substates`. Re-checking every row here would be a
 * thousand point reads per scan to re-derive what those two already know.
 *
 * ── WHAT IT STILL CANNOT DO ─────────────────────────────────────────────────
 *
 * Recover a coin that NO listing returns. Measured: a change output live and unfrozen at
 * `/substates/<id>` on both nodes, present in neither node's fully-paginated `/utxos`. A union
 * over listings cannot conjure a row no listing has. The wallet knows the ids of the outputs it
 * creates for itself (crypto/outputIds, recorded on every journal entry), so those can be read
 * directly by id — that is the piece this does not yet do.
 *
 * ── ONE SLOW NODE MUST NOT STALL THE SCAN ───────────────────────────────────
 *
 * The walks run in PARALLEL and are independent: a node that is down, slow past its retries, or
 * serving garbage contributes nothing and the union carries on without it. That costs one extra
 * full listing read per scan — roughly half a megabyte against the same again — which is the price
 * of not being hostage to whichever host was hardcoded. Only when EVERY node fails is it an error,
 * and then it throws rather than reporting an empty wallet.
 */
export async function fetchAllUtxoRows(opts: {
  /** Defaults to every configured indexer. A one-element list is an ordinary single-node read. */
  indexerUrls?: readonly string[]
  /** Aborts the whole walk mid-page. Optional — the spend paths have nothing to cancel. */
  signal?: AbortSignal
  /** Called as pages land, for a scan that wants to show progress. Totals across all nodes. */
  onPage?: (pages: number, rows: number) => void
}): Promise<UtxoFeed> {
  const signal = opts.signal ?? new AbortController().signal
  const urls = opts.indexerUrls ?? INDEXER_URLS
  if (urls.length === 0) throw new Error('No indexer configured to read the UTXO set from.')

  const rows: UtxoRow[] = []
  const seen = new Set<string>()
  let pages = 0
  const bump = () => { pages++; opts.onPage?.(pages, seen.size) }

  const settled = await Promise.all(urls.map(async (url): Promise<UtxoSource & { rows_: UtxoRow[] }> => {
    try {
      const out = await walkOne(url, signal, bump)
      return { url, rows: out.rows.length, pages: out.pages, ok: true, rows_: out.rows, ...(out.incomplete ? { error: 'walk hit its page bound' } : {}) }
    } catch (e) {
      // An intentional abort is the caller cancelling, not a node being bad — rethrow it whole so
      // a rescan or a lock does not read as a degraded indexer.
      if (signal.aborted) throw e
      return { url, rows: 0, pages: 0, ok: false, error: e instanceof Error ? e.message : String(e), rows_: [] }
    }
  }))

  const sources: UtxoSource[] = settled.map(({ rows_: _drop, ...rest }) => rest)
  const alive = settled.filter(s => s.ok)
  if (alive.length === 0) {
    throw new Error(
      `Could not read the UTXO set from any indexer (${sources.map(s => `${s.url}: ${s.error ?? 'failed'}`).join('; ')})`,
    )
  }

  // DEDUPLICATED BY COMMITMENT, across nodes as well as within one. The same coin returned by both
  // indexers is one coin; counting it twice would overstate the balance and offer input selection a
  // self-double-spend, which is the reason this module deduplicated within a single walk already.
  for (const source of settled) {
    for (const row of source.rows_) {
      const id = row[0]
      if (seen.has(id)) continue
      seen.add(id)
      rows.push(row)
    }
  }

  // Short for either reason — a truncated walk, or a node that never answered while another did.
  const truncated = settled.some(s => s.ok && s.error !== undefined)
  const someFailed = settled.some(s => !s.ok)
  return { rows, incomplete: truncated || someFailed, pages, sources }
}
