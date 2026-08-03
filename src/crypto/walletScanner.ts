import { decryptOwnedUtxo, WasmStealthCrypto, Network } from '@tari-project/ootle'
import type { IndexerGetSubstateResponse } from '@tari-project/ootle'

const INDEXER = 'https://ootle-indexer-a.tari.com'
const RESOURCE_HEX = '0101010101010101010101010101010101010101010101010101010101010101'
// The indexer's /utxos endpoint IGNORES `offset` (every offset returns the same set) but HONORS
// `limit` (returns min(limit, total)). So we do NOT paginate — one request with a limit safely above
// the whole set. 1000 is honored; 5000 is rejected, so that's the working ceiling. If the returned
// count ever reaches this limit, there may be more we can't see → we flag the balance as incomplete.
const FETCH_LIMIT = 1000
const FETCH_TIMEOUT_MS = 15_000  // hang guard (feeds the retry below)
const FETCH_RETRIES = 3          // transient failures (timeout / network blip) retry before we give up
const RETRY_BACKOFF_MS = 600     // base backoff between retries (×attempt)

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
  /** True if the indexer returned a full FETCH_LIMIT of rows — there may be UTXOs we couldn't see,
   *  so the balance could be understated. False in the normal case (whole set fits under the limit). */
  incomplete: boolean
  balance: bigint
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

// Returns a new AbortSignal that fires when either input fires.
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController()
  if (a.aborted || b.aborted) { ctrl.abort(); return ctrl.signal }
  const abort = () => ctrl.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return ctrl.signal
}

// Fetch the resource's UTXO list in ONE request (the indexer ignores `offset`, honors `limit`), with
// a timeout + bounded retry so a transient blip doesn't fail the scan. Only throws — surfacing as a
// scan error + Retry, never a silent zero — after FETCH_RETRIES attempts. An intentional abort of
// `signal` (rescan / lock / new identity) is rethrown immediately so the caller can ignore it.
async function fetchUtxos(signal: AbortSignal): Promise<[string, unknown][]> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException('scan aborted', 'AbortError')

    const reqCtrl = new AbortController()
    let timedOut = false
    const reqTimer = setTimeout(() => { timedOut = true; reqCtrl.abort() }, FETCH_TIMEOUT_MS)
    const reqSignal = mergeSignals(signal, reqCtrl.signal)

    try {
      const resp = await fetch(
        `${INDEXER}/utxos?resource_address=${RESOURCE_HEX}&limit=${FETCH_LIMIT}`,
        { signal: reqSignal },
      )
      clearTimeout(reqTimer)
      if (!resp.ok) throw new Error(`indexer returned HTTP ${resp.status}`)
      const json = await resp.json() as { utxos?: [string, unknown][] }
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
  throw lastErr instanceof Error ? lastErr : new Error(`scan failed: ${String(lastErr)}`)
}

export async function scanWallet(
  viewSecret: Uint8Array,
  onProgress: (p: ScanProgress) => void,
  signal: AbortSignal,
): Promise<ScanResult> {
  const rows = await fetchUtxos(signal)
  // The endpoint returns min(limit, total). A full FETCH_LIMIT means there may be more we can't see.
  const incomplete = rows.length >= FETCH_LIMIT

  // Dedup by commitment BEFORE decrypting — the indexer can return the same UTXO more than once, and
  // counting a duplicate twice would double-count its value into the balance.
  const uniqueRows: [string, unknown][] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row[0])) continue
    seen.add(row[0])
    uniqueRows.push(row)
  }

  const found: ScannedUtxo[] = []
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
        const { payRef, message } = decodeMemo(decrypted.memo)
        found.push({ id: substateId, commitment: commitmentHex, amount: decrypted.value, payRef, message })
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
  return { utxos: found, totalScanned, incomplete, balance }
}
