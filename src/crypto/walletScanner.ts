import { decryptOwnedUtxo, WasmStealthCrypto, Network } from '@tari-project/ootle'
import type { IndexerGetSubstateResponse } from '@tari-project/ootle'

const INDEXER = 'https://ootle-indexer-a.tari.com'
const RESOURCE_HEX = '0101010101010101010101010101010101010101010101010101010101010101'
const PAGE_SIZE = 100
const MAX_UTXOS = 1000   // 10 pages — finds recent UTXOs, acceptable cap for testnet
const PAGE_TIMEOUT_MS = 10_000

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
  capped: boolean
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

export async function scanWallet(
  viewSecret: Uint8Array,
  onProgress: (p: ScanProgress) => void,
  signal: AbortSignal,
): Promise<ScanResult> {
  const found: ScannedUtxo[] = []
  let offset = 0
  let totalScanned = 0
  let capped = false

  outer: while (true) {
    if (signal.aborted) break

    // Per-page hard timeout so a slow indexer never hangs indefinitely
    const pageCtrl = new AbortController()
    const pageTimer = setTimeout(() => pageCtrl.abort(), PAGE_TIMEOUT_MS)
    const pageSignal = mergeSignals(signal, pageCtrl.signal)

    let items: [string, unknown][]
    try {
      const resp = await fetch(
        `${INDEXER}/utxos?resource_address=${RESOURCE_HEX}&limit=${PAGE_SIZE}&offset=${offset}`,
        { signal: pageSignal },
      )
      clearTimeout(pageTimer)
      if (!resp.ok) break
      const json = await resp.json() as { utxos: [string, unknown][] }
      items = json.utxos ?? []
    } catch {
      clearTimeout(pageTimer)
      break
    }

    if (items.length === 0) break

    for (const [commitmentHex, body] of items) {
      if (signal.aborted) break outer

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

    if (items.length < PAGE_SIZE) break  // reached the last page

    offset += PAGE_SIZE
    if (totalScanned >= MAX_UTXOS) {
      capped = true
      break
    }
  }

  const balance = found.reduce((sum, u) => sum + u.amount, 0n)
  return { utxos: found, totalScanned, capped, balance }
}
