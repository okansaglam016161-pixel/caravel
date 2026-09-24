// Which indexers this wallet reads, and how it survives one of them being wrong.
//
// ── WHY THIS IS A MODULE AND NOT TWELVE CONSTANTS ────────────────────────────
//
// The indexer URL was hardcoded twelve times across src/crypto — one private `const` per module,
// no shared config, no override. That made the single most operationally important fact about this
// wallet the least changeable thing in it: pointing at a different node meant a twelve-file edit,
// so in practice nobody ever did, and every reader silently depended on one host being right.
//
// ── AND ONE HOST IS NOT RIGHT ────────────────────────────────────────────────
//
// Measured against the two public Esmeralda indexers, walked to the end with the cursor, at the
// same moment:
//
//     indexer-a : 1118 rows      only in a : 13
//     indexer-b : 1112 rows      only in b :  7
//     union     : 1125
//
// The disagreement is SYMMETRIC — neither node is "the good one". Each holds a handful of live
// outputs the other does not return, so a wallet reading either alone is missing coins it owns,
// and which coins depends on which host it happened to be pointed at.
//
// ── WHAT THIS FIXES, AND WHAT IT DOES NOT ────────────────────────────────────
//
// Reading both and taking the union recovers those twenty. It does NOT make `/utxos` complete:
// a change output was measured live and unfrozen at `/substates/<id>` on BOTH nodes while
// appearing in NEITHER node's listing. No union over listings can recover a coin no listing
// returns. See utxoFeed for how far the union gets, and the note there about what is left.

/** The public Esmeralda indexers, in preference order. The first is also the primary (below). */
export const DEFAULT_INDEXER_URLS = [
  'https://ootle-indexer-a.tari.com',
  'https://ootle-indexer-b.tari.com',
] as const

/**
 * Read an override from whichever environment this is running in.
 *
 * `VITE_INDEXER_URL` is the ecosystem's convention and what the app honours; the `process.env`
 * branch is for Node — the harness and the live specs — where `import.meta.env` does not exist.
 * Neither is required, and both are read defensively: a misconfigured environment must degrade to
 * the defaults rather than throw at module load, which would take the whole app down.
 */
function readEnv(name: string): string | undefined {
  try {
    const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    const fromVite = viteEnv?.[name]
    if (typeof fromVite === 'string' && fromVite.trim() !== '') return fromVite.trim()
  } catch { /* no import.meta.env here */ }
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
    const fromNode = proc?.env?.[name]
    if (typeof fromNode === 'string' && fromNode.trim() !== '') return fromNode.trim()
  } catch { /* no process here */ }
  return undefined
}

/** Strip a trailing slash so `${base}/utxos` never becomes `//utxos`. */
const normalise = (u: string) => u.replace(/\/+$/, '')

/**
 * Every indexer to read from, in preference order.
 *
 * `VITE_INDEXER_URLS` takes a comma-separated list; `VITE_INDEXER_URL` takes a single host and is
 * the ecosystem's spelling. A single host is a legitimate configuration — pointing the wallet at
 * one node you trust, or at a local `tari_swarm_daemon` — and turns the union read below into an
 * ordinary one-node read with no other change in behaviour.
 */
export const INDEXER_URLS: readonly string[] = (() => {
  const list = readEnv('VITE_INDEXER_URLS') ?? readEnv('CARAVEL_INDEXER_URLS')
  if (list) {
    const urls = list.split(',').map(s => normalise(s.trim())).filter(Boolean)
    if (urls.length > 0) return urls
  }
  const single = readEnv('VITE_INDEXER_URL') ?? readEnv('CARAVEL_INDEXER_URL')
  if (single) return [normalise(single)]
  return DEFAULT_INDEXER_URLS.map(normalise)
})()

/**
 * The one to use where a single host is required.
 *
 * Submitting a transaction, the dry run, the epoch read, the SDK provider: all of these are point
 * operations against one node, and sending the same transaction to two indexers is not
 * redundancy, it is a double submission. Reading the SET is the only place plurality helps.
 */
export const INDEXER_URL: string = INDEXER_URLS[0]!

/** Per-request ceiling for a point read, so one unresponsive node cannot stall a caller. */
export const POINT_READ_TIMEOUT_MS = 8_000

/** What a point read came back with, and from where. */
export interface PointRead {
  /** Parsed JSON body, or `null` when every indexer answered 404 / not-found. */
  body: unknown | null
  /** True when at least one indexer gave a definite answer — a 2xx or a 404. */
  answered: boolean
  /** The indexer that answered, for diagnostics. */
  source: string | null
}

/**
 * One read, tried against each indexer until one gives a definite answer.
 *
 * ── A 404 FROM ONE NODE IS NOT "NOT FOUND" ──────────────────────────────────
 *
 * That distinction is the whole reason this exists. Two readers depend on it and both would make
 * a wrong, expensive decision on a single node's 404:
 *
 *   crypto/lockSweep  reads `/substates/<id>` to decide whether a coin was consumed. A 404 means
 *                     "gone", which promotes a lock to `spent`. On a node that simply does not
 *                     have the substate, that would permanently exclude a live coin.
 *   crypto/finality   reads `/transactions/<id>/result`. A 404 there is "no verdict", which keeps
 *                     a lock held — safe, but it strands a transaction whose verdict the OTHER
 *                     node could have supplied.
 *
 * So a 404 is only believed once EVERY indexer has said it. A transport failure is never believed
 * at all: `answered: false` tells the caller nothing could be established, which is different from
 * a definite absence and must be treated as such.
 */
export async function pointRead(path: string): Promise<PointRead> {
  let sawNotFound = false
  let notFoundSource: string | null = null

  for (const base of INDEXER_URLS) {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(POINT_READ_TIMEOUT_MS) })
    } catch {
      continue   // unreachable or too slow — say nothing, try the next
    }
    if (res.status === 404) {
      // Definite from THIS node. Keep asking the others before concluding anything.
      sawNotFound = true
      notFoundSource ??= base
      continue
    }
    if (!res.ok) continue   // 5xx and friends say nothing about the resource
    try {
      return { body: await res.json() as unknown, answered: true, source: base }
    } catch { continue }    // a 200 we could not parse is not an answer either
  }

  // Every node that spoke said 404. That is a real absence.
  if (sawNotFound) return { body: null, answered: true, source: notFoundSource }
  // Nobody answered at all.
  return { body: null, answered: false, source: null }
}
