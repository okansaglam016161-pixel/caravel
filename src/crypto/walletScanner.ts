import { decryptOwnedUtxo, WasmStealthCrypto, Network } from '@tari-project/ootle'
import type { IndexerGetSubstateResponse } from '@tari-project/ootle'
import { RESOURCE_HEX } from './utxoFeed'
import { fetchOwnedRows, type Recovery } from './ownedFeed'
import type { ReceiveScanReport } from './receiveScan'
import type { ExcludedValue } from './spentOutputs'

// THE SET IS READ TO THE END, and the request/retry/cursor machinery lives in utxoFeed so this and
// the spend paths cannot read it differently. RESOURCE_HEX came from there too: it was a hand-typed
// 0101…01 here and derived from the SDK constant there, which is two places to be wrong about which
// resource the balance is counting.

export interface ScannedUtxo {
  id: string
  commitment: string
  amount: bigint
  payRef: string
  message: string
}

export interface ScanProgress {
  scanned: number
  found: number
}

export interface ScanResult {
  utxos: ScannedUtxo[]
  totalScanned: number
  /**
   * Owned rows that were EXCLUDED as already spent, and that `/utxos` was still listing.
   *
   * Not a balance figure — these are deliberately absent from `utxos` and from `balance`. Two
   * consumers need it, and between them they need both fields:
   *
   *   reconciliation  asks "of the commitments I am excluding, which does the indexer still show
   *                   me?" Without it, absence from `utxos` would be ambiguous between a coin the
   *                   listing has dropped and one this scan chose not to count.
   *   the safety net  asks HOW MUCH the exclusion is costing the displayed balance. The value is
   *                   decrypted here anyway and used to be thrown away, which is why a wallet
   *                   could be understated by 1110 tTARI with no number anywhere naming the gap.
   *
   * ONLY THE LISTED ONES, and that is the point: excluding a commitment the indexer has already
   * dropped subtracts nothing, because the loop below never sees it.
   */
  excludedPresent: ExcludedValue[]
  /**
   * True only if the walk hit utxoFeed's runaway guard — there may be UTXOs we never saw, so the
   * balance could be understated.
   *
   * IT USED TO FIRE ON EVERY BUSY NETWORK, because it meant "the one page we asked for was full".
   * Now the pages are followed to the end, so a full first page is ordinary and this stays false
   * until something is genuinely wrong. See utxoFeed's MAX_UTXO_PAGES.
   */
  incomplete: boolean
  balance: bigint
  /**
   * Coins this wallet had to ask for BY ID because no listing returned them.
   *
   * Normally empty. A non-empty list means the indexers dropped one of our own outputs and the
   * journal's record of it is what put it back — see crypto/ownedFeed.
   */
  recoveries: Recovery[]
  /** The transaction walk that names receives early — see crypto/receiveScan. Diagnostic. */
  receiveScan: ReceiveScanReport | null
}

/** The two things a scan needs beyond the view key, both optional. */
export interface ScanOptions {
  /** What this wallet has already spent — see crypto/spentOutputs. */
  excluded?: ReadonlySet<string>
  /**
   * Enables by-id recovery of our own unlisted outputs, AND the transaction walk that finds
   * receives before the listing does (the scan's own view key is used for that). Without it the
   * scan reads the listings alone, which is the pre-2b behaviour and still correct, just slower to
   * see a receive and blind to a dropped row.
   */
  walletAddress?: string
}

// One shared WASM instance — safe to share across calls (stateless per-call)
const stealthCrypto = new WasmStealthCrypto(Network.Esmeralda)

function decodeMemo(memoJson: string | undefined): { payRef: string; message: string } {
  if (!memoJson) return { payRef: '', message: '' }
  let parsed: unknown
  try { parsed = JSON.parse(memoJson) } catch { return { payRef: '', message: memoJson } }
  if (typeof parsed !== 'object' || parsed === null) return { payRef: '', message: memoJson }
  const p = parsed as Record<string, unknown>
  if (typeof p.PayRefAndBytes === 'string') {
    const hex = p.PayRefAndBytes
    const bytes = new Uint8Array((hex.match(/.{2}/g) ?? []).map((b: string) => parseInt(b, 16)))
    const n = bytes[0]
    const dec = new TextDecoder()
    return {
      payRef: dec.decode(bytes.slice(1, 1 + n)),
      message: dec.decode(bytes.slice(1 + n)),
    }
  }
  if (typeof p.Message === 'string') return { payRef: '', message: p.Message }
  return { payRef: '', message: memoJson }
}

/**
 * The wallet's private balance, from every stealth UTXO it can open.
 *
 * `excluded` IS WHAT THIS WALLET HAS ALREADY SPENT — see crypto/spentOutputs. It is subtracted
 * here rather than at a call site because the balance is a single number derived in a single
 * place, and a caller that forgot to subtract would show money the wallet no longer has. Empty by
 * default, which is exactly the old behaviour: trust the listing and nothing else.
 *
 * The exclusion runs AFTER the trial decrypt, not before. Only a decrypted row is known to be
 * ours, and matching ids against undecrypted rows would be matching against the whole network's
 * outputs for no benefit.
 */
export async function scanWallet(
  viewSecret: Uint8Array,
  onProgress: (p: ScanProgress) => void,
  signal: AbortSignal,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const excluded = opts.excluded ?? new Set<string>()
  // EVERY page, not the first. The rows come back deduplicated by commitment — a duplicate counted
  // twice would double-count its value into the balance — so what arrives here is the set itself.
  // EVERY configured indexer, unioned — AND our own outputs that no listing returned, fetched by
  // id from the journal's record of them. See crypto/ownedFeed: reading one node left ~20 live
  // coins invisible, and a listing can drop one of ours entirely.
  //
  // And the receives the recent-transaction walk found, named by id before any listing has them —
  // crypto/receiveScan. Same recovery path, same filters: they are rows only if the chain says so.
  const { rows: uniqueRows, incomplete, recoveries, receiveScan } = await fetchOwnedRows({
    signal,
    walletAddress: opts.walletAddress,
    viewSecret: opts.walletAddress ? viewSecret : undefined,
  })

  const found: ScannedUtxo[] = []
  const excludedPresent: ExcludedValue[] = []
  let totalScanned = 0

  for (const [commitmentHex, body] of uniqueRows) {
    if (signal.aborted) break

    const substateId = `utxo_${RESOURCE_HEX}_${commitmentHex}`
    // Wrap the raw API body as IndexerGetSubstateResponse — same shape decryptOwnedUtxo expects
    const fakeSubstate = {
      version: 0,
      substate: { Utxo: body },
      verified: false,
    } as IndexerGetSubstateResponse

    try {
      const decrypted = await decryptOwnedUtxo(stealthCrypto, viewSecret, fakeSubstate, substateId)
      if (decrypted !== null) {
        // OURS, BUT ALREADY SPENT. Recorded as still-listed so reconciliation can see the indexer
        // has not caught up yet, then dropped — it is not part of the balance and it is not an
        // input anything may select.
        if (excluded.has(substateId)) {
          excludedPresent.push({ id: substateId, microtari: decrypted.value })
        } else {
          const { payRef, message } = decodeMemo(decrypted.memo)
          found.push({ id: substateId, commitment: commitmentHex, amount: decrypted.value, payRef, message })
        }
      }
    } catch {
      // Trial-decrypt failures are expected (not our UTXO) — skip silently
    }

    totalScanned++

    // Yield every 50 items so the event loop can render progress updates
    if (totalScanned % 50 === 0) {
      onProgress({ scanned: totalScanned, found: found.length })
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  onProgress({ scanned: totalScanned, found: found.length })

  const balance = found.reduce((sum, u) => sum + u.amount, 0n)
  return { utxos: found, totalScanned, incomplete, balance, excludedPresent, recoveries, receiveScan }
}
