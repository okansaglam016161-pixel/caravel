// The rows the wallet scans: every indexer's listing, plus the coins it knows it owns and the
// listings dropped.
//
// ── THE FAILURE THE UNION COULD NOT REACH ────────────────────────────────────
//
// Stage 2 made `/utxos` plural, because the two public nodes disagree about which outputs are
// unspent. That fixed the symmetric case decisively — measured, one wallet's entire balance went
// from 0 to 998.43 tTARI simply by reading both nodes instead of one.
//
// It did not fix the other case, and the other case is worse:
//
//     /substates/utxo_0101…_c43431c5…   HTTP 200, live, unfrozen, on BOTH nodes
//     /utxos, walked to the end          absent from BOTH nodes
//
// A change output that exists on chain, is queryable by id, and is in nobody's listing. A union
// over listings cannot conjure a row no listing has. The coin was fine; the wallet just could not
// see it — the balance came up short, and the evidence-settle waited for a commitment the scan was
// structurally unable to find, until it timed out and reported the honest unreadable state.
//
// ── ASKING FOR OUR OWN RECEIPTS, NOT SCANNING ────────────────────────────────
//
// The wallet is not guessing here. Every output it creates for itself has its substate id read out
// of the outputs statement BEFORE submission (crypto/outputIds) and written to the journal entry
// for that action. So when a listing omits one, the wallet already has its name and can ask for it
// directly. That is a fundamentally different operation from scanning: it fetches a bounded set of
// ids it recorded itself — or, since stage 2c, ids its own view key opened inside a transaction
// (below) — never an arbitrary one.
//
// ── COST, IN THE ORDINARY CASE, IS ZERO ──────────────────────────────────────
//
// Only ids MISSING from the union are fetched, and the listings normally have them all — so the
// usual number of extra requests is none. It rises only when a listing drops one of ours, which is
// exactly when it is worth paying for.
//
// ── A SECOND SOURCE OF NAMES: RECEIVES FOUND IN TRANSACTIONS (stage 2c) ──────
//
// The journal can only name outputs this wallet BUILT. A payment from someone else had no name
// until the listing showed it, and the listing lags by minutes. crypto/receiveScan now reads the
// indexer's recent transactions and trial-decrypts their outputs with our view key, so a receive is
// named at commit. Those ids join the journal's here, through the SAME filters and the SAME fetch:
// a discovered receive is only ever a row because `/substates` returned a live body for it.

import { loadJournal } from './journalStore'
import { loadSpentOutputs, excludedIds } from './spentOutputs'
import { pointRead } from './indexerConfig'
import { fetchAllUtxoRows, RESOURCE_HEX, type UtxoFeed, type UtxoRow } from './utxoFeed'
import {
  discoveredReceives, retireDiscovered, scanRecentReceives,
  type ReceiveScanReport, type RecentPageFetcher, type OwnershipTest,
} from './receiveScan'

/**
 * Most by-id reads one scan may make.
 *
 * A HARD CEILING ON WORK, not a belief about how many coins can go missing. The candidate list is
 * every self-output this wallet ever recorded that is neither spent nor currently listed, and on a
 * long-lived wallet that tail can grow: outputs spent before spend-tracking existed are absent
 * from the listing for the best of reasons and absent from the spend record only because nothing
 * was watching at the time. Those would otherwise be re-read on every scan forever.
 *
 * Newest first, so the cap spends its budget where recovery actually matters — a change output
 * from minutes ago that the indexer has not listed yet. Thirty-two is far above any realistic
 * number of simultaneously-missing coins and still a trivial amount of work.
 */
export const MAX_RECOVERY_READS = 32

/** A coin recovered by id, and where it came from. Diagnostic — the harness prints these. */
export interface Recovery {
  /** The substate id, as recorded on the journal entry. */
  substateId: string
  commitment: string
  /** True when the chain returned a live output for it. */
  found: boolean
  /** Which source named it: our own journal, or a receive found in a recent transaction. */
  via: 'journal' | 'receive-scan'
}

export interface OwnedFeed extends UtxoFeed {
  /** Ids that were missing from every listing and had to be asked for directly. */
  recoveries: Recovery[]
  /** What the transaction walk did this scan. `null` when it did not run (no view key given). */
  receiveScan: ReceiveScanReport | null
}

/** The commitment half of a `utxo_<resource>_<commitment>` substate id. */
function commitmentOf(substateId: string): string {
  return substateId.slice(substateId.lastIndexOf('_') + 1)
}

/** One id worth asking for, and which source named it. */
export interface RecoveryCandidate {
  substateId: string
  via: Recovery['via']
}

/**
 * Which of our own outputs are worth asking the chain about directly.
 *
 * TWO SOURCES, ONE LIST. The journal's self-output ids (what this wallet built for itself) and the
 * ids crypto/receiveScan found in recent transactions (what somebody else built for us). Both are
 * merged newest-first by when they became known, deduplicated by id — our own change output is
 * ALSO found by the transaction walk, and must be asked for once — and pass the same filters.
 *
 * THREE FILTERS, and each removes a different kind of waste or danger:
 *
 *   already listed  the union has it. Nothing to recover, and re-reading it would be pure cost.
 *   already spent   it is in the spend record as locked or spent. Re-adding it would RESURRECT A
 *                   SPENT COIN into the balance and into coin selection — the precise failure
 *                   crypto/spentOutputs exists to prevent, reintroduced through a side door.
 *   beyond the cap  see MAX_RECOVERY_READS.
 *
 * Newest first. Exported for the tests and the harness, because the selection rule is the part of
 * this worth arguing about.
 */
export function recoveryCandidates(
  walletAddress: string,
  presentCommitments: ReadonlySet<string>,
  limit = MAX_RECOVERY_READS,
): string[] {
  return recoveryCandidatesWithSource(walletAddress, presentCommitments, limit).map(c => c.substateId)
}

/** recoveryCandidates, saying which source named each one. */
export function recoveryCandidatesWithSource(
  walletAddress: string,
  presentCommitments: ReadonlySet<string>,
  limit = MAX_RECOVERY_READS,
): RecoveryCandidate[] {
  if (!walletAddress) return []

  const spent = excludedIds(loadSpentOutputs(walletAddress))

  // Every named id with when it became known. `null` selfOutputIds is a hole — the statement could
  // not be read — and `[]` is a positive "creates nothing for us". Neither offers an id to look up.
  const named: { id: string; at: number; via: Recovery['via'] }[] = []
  for (const entry of loadJournal(walletAddress)) {
    for (const id of entry.selfOutputIds ?? []) named.push({ id, at: entry.timestamp, via: 'journal' })
  }
  for (const d of discoveredReceives(walletAddress)) named.push({ id: d.id, at: d.at, via: 'receive-scan' })

  // Newest first. Stable, so the journal wins a tie — and it wins the dedup below either way, since
  // an output we built ourselves is better described as ours than as a receive.
  named.sort((a, b) => b.at - a.at || (a.via === b.via ? 0 : a.via === 'journal' ? -1 : 1))

  const seen = new Set<string>()
  const out: RecoveryCandidate[] = []
  for (const { id, via } of named) {
    if (seen.has(id)) continue
    seen.add(id)
    if (spent.has(id)) continue
    if (presentCommitments.has(commitmentOf(id))) continue
    out.push({ substateId: id, via })
    if (out.length >= limit) return out
  }
  return out
}

/**
 * How one id is asked for. Injectable so the policy can be tested without a chain.
 *
 * `null` is a DEFINITE "no live coin" — every node answered. `undefined` is "nobody answered", which
 * concludes nothing; the only difference it makes is that a discovered receive is never retired on
 * it (see receiveScan.retireDiscovered).
 */
export type SubstateFetcher = (substateId: string) => Promise<unknown | null | undefined>

/**
 * `/substates/<id>`, through every configured indexer.
 *
 * Returns the `Utxo` body in exactly the shape a listing row carries, so a recovered coin and a
 * listed one are indistinguishable downstream — same decrypt, same parse, same fields. `null`
 * covers both "not there" and "not a live UTXO": a spent or frozen output has `output: null`, and
 * one that no longer exists 404s on every node.
 */
const fetchSubstateBody: SubstateFetcher = async (substateId) => {
  const read = await pointRead(`/substates/${encodeURIComponent(substateId)}`)
  if (!read.answered) return undefined
  if (read.body === null) return null
  const utxo = (read.body as { substate?: { Utxo?: unknown } })?.substate?.Utxo
  if (!utxo || typeof utxo !== 'object') return null
  // A spent or frozen output still answers 200 with `output: null`. Not a coin.
  if ((utxo as { output?: unknown }).output == null) return null
  return utxo
}

/**
 * Every row a scan should consider: the union of listings, plus our own coins the listings lost.
 *
 * ── WHY BOTH SCANNERS CALL THIS AND NOT `fetchAllUtxoRows` ──────────────────
 *
 * The balance (crypto/walletScanner) and the spendable set (crypto/stealthUtxos) must never
 * disagree about which coins exist — a wallet that displays one number and can spend another is a
 * worse failure than either being wrong alone. They already shared the listing walk for that
 * reason; sharing the recovery too is the same argument, and it is why the recovery lives here
 * rather than in either of them.
 *
 * ── A NOT-YET-CONFIRMED COIN IS NOT A MISSING ONE ───────────────────────────
 *
 * A change output from a transaction still settling 404s on every node, because it genuinely is
 * not on chain yet. That is reported as `found: false` and simply not added — and NOTHING is
 * remembered about it. There is deliberately no negative cache: a 404 today and a 404 forever look
 * identical at this moment, so caching the first would quietly stop looking for a coin that is
 * about to arrive. The cost of asking again next scan is one request.
 */
export async function fetchOwnedRows(opts: {
  /** Omit to skip recovery entirely — the listing union alone, which is the pre-2b behaviour. */
  walletAddress?: string
  indexerUrls?: readonly string[]
  signal?: AbortSignal
  onPage?: (pages: number, rows: number) => void
  /**
   * This wallet's view key. With `walletAddress`, enables the transaction walk (crypto/receiveScan)
   * that names receives before the listing shows them. Omit for the stage-2b behaviour.
   */
  viewSecret?: Uint8Array
  /** Test seams. */
  fetchSubstate?: SubstateFetcher
  receiveScan?: { fetchPage?: RecentPageFetcher; isOurs?: OwnershipTest; now?: number }
}): Promise<OwnedFeed> {
  const walletAddress = opts.walletAddress
  const viewSecret = opts.viewSecret

  // CONCURRENT with the listing walk, not before it: an incremental transaction walk is one small
  // page per node, but a first walk on a fresh device can be several, and the balance should wait
  // for the slower of the two rather than their sum. It never throws for a network reason — a failed
  // walk holds its cursor and names nothing, and the listing is unaffected.
  const [feed, receiveScan] = await Promise.all([
    fetchAllUtxoRows({ indexerUrls: opts.indexerUrls, signal: opts.signal, onPage: opts.onPage }),
    walletAddress && viewSecret
      ? scanRecentReceives({
          walletAddress, viewSecret, indexerUrls: opts.indexerUrls, signal: opts.signal, ...opts.receiveScan,
        }).catch(() => null)
      : Promise.resolve(null),
  ])
  if (!walletAddress) return { ...feed, recoveries: [], receiveScan }

  const present = new Set(feed.rows.map(r => r[0]))
  // No early return when this is empty (the ordinary case): the retirement below still has to run.
  const candidates = recoveryCandidatesWithSource(walletAddress, present)

  const fetchSubstate = opts.fetchSubstate ?? fetchSubstateBody
  const recoveries: Recovery[] = []
  const rows: UtxoRow[] = [...feed.rows]
  const absent = new Set<string>()

  // Sequential rather than parallel: the candidate list is normally empty and at most
  // MAX_RECOVERY_READS long, and a scan that has already pulled two full listings has no need to
  // open thirty more sockets at once.
  for (const { substateId, via } of candidates) {
    if (opts.signal?.aborted) break
    const commitment = commitmentOf(substateId)
    const body = await fetchSubstate(substateId)
    recoveries.push({ substateId, commitment, found: body != null, via })
    if (body === null) absent.add(substateId)
    if (body == null) continue
    // DEDUPLICATED, like everything else that reaches this set. `present` cannot already hold it —
    // it was filtered out of the candidates — but the guard costs nothing and the invariant this
    // protects (one commitment, one row) is the one that keeps a balance from double-counting.
    if (present.has(commitment)) continue
    present.add(commitment)
    rows.push([commitment, body])
  }

  // Let go of discovered receives that can no longer be ours — spent by us, or definitively absent
  // for longer than a fresh commit could explain. Journal ids are untouched: the journal is history.
  const spentForGood = new Set(Object.entries(loadSpentOutputs(walletAddress).records)
    .filter(([, r]) => r.status === 'spent').map(([id]) => id))
  retireDiscovered(walletAddress, spentForGood, absent, opts.receiveScan?.now)

  return { ...feed, rows, recoveries, receiveScan }
}

/** Re-exported so callers need only this module. */
export { RESOURCE_HEX }
