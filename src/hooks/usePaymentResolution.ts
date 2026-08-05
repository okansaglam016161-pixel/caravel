import { useState, useEffect } from 'react'
import { useWallet } from '../context/WalletContext'
import { resolvePayment, type PaymentResolution } from '../crypto/paymentResolver'
import { loadResolvedAmounts, cacheResolvedAmount } from '../messaging/paymentResolutionStore'

// ── Payment resolution (M10.2) ────────────────────────────────────────────────
//
// Shared by the chat thread's payment cards and the wallet Activity list, so a received payment's
// amount is resolved once and shared through the persisted cache. Behaviour is unchanged from the
// original in ChatApp: cache-first, one fetch with bounded backoff for transient failures, no polling.

// In-flight dedup: one fetch per (identity, utxoId) even if several cards mount at once, or React
// StrictMode double-invokes the effect. Keyed by pubkey too so it can't leak across identities.
const inflightResolve = new Map<string, Promise<PaymentResolution>>()
function dedupResolve(myPubkeyHex: string, utxoId: string, viewSecret: Uint8Array): Promise<PaymentResolution> {
  const k = `${myPubkeyHex}:${utxoId}`
  const existing = inflightResolve.get(k)
  if (existing) return existing
  const p = resolvePayment(utxoId, viewSecret).finally(() => { inflightResolve.delete(k) })
  inflightResolve.set(k, p)
  return p
}

export type ResolveState =
  | { kind: 'loading' }
  | { kind: 'retrying'; reason: 'not_found' | 'network_error' }
  | { kind: 'resolved'; amountMicrotari: string }
  | { kind: 'failed'; reason: 'not_found' | 'network_error' | 'spent' | 'unreadable' }

// Three bounded auto-retries after the first attempt, for transient failures only. No polling.
const RESOLVE_BACKOFFS_MS = [2_000, 4_000, 8_000]

// Lazily resolve a received payment's amount. Cache-first (persisted successes), then a single
// fetch with bounded backoff for transient failures (not_found = indexer lag, network_error).
// Terminal failures (spent, unreadable) never auto-retry. Timers are cleared on unmount; manual
// retry() re-runs the whole sequence.
export function usePaymentResolution(utxoId: string): { state: ResolveState; retry: () => void } {
  const { wallet, nostrPubkeyHex } = useWallet()
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<ResolveState>(() => {
    if (nostrPubkeyHex) {
      const cached = loadResolvedAmounts(nostrPubkeyHex)[utxoId]
      if (cached) return { kind: 'resolved', amountMicrotari: cached }
    }
    return { kind: 'loading' }
  })

  useEffect(() => {
    if (!wallet || !nostrPubkeyHex) return
    const cached = loadResolvedAmounts(nostrPubkeyHex)[utxoId]
    if (cached) { setState({ kind: 'resolved', amountMicrotari: cached }); return }
    const viewSecret = wallet.getViewOnlySecret()
    if (!viewSecret) return

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    if (nonce > 0) setState({ kind: 'loading' })  // manual retry resets the visible state

    async function attempt(i: number) {
      const res = await dedupResolve(nostrPubkeyHex!, utxoId, viewSecret!)
      if (cancelled) return
      if (res.status === 'resolved') {
        cacheResolvedAmount(nostrPubkeyHex!, utxoId, res.amountMicrotari)
        setState({ kind: 'resolved', amountMicrotari: res.amountMicrotari })
        return
      }
      if (res.status === 'spent' || res.status === 'unreadable') {
        setState({ kind: 'failed', reason: res.status })   // terminal — never auto-retry
        return
      }
      // transient: not_found (spent-or-not-yet-indexed) or network_error
      if (i < RESOLVE_BACKOFFS_MS.length) {
        setState({ kind: 'retrying', reason: res.status })
        timers.push(setTimeout(() => attempt(i + 1), RESOLVE_BACKOFFS_MS[i]))
      } else {
        setState({ kind: 'failed', reason: res.status })   // retries exhausted
      }
    }
    attempt(0)
    return () => { cancelled = true; timers.forEach(clearTimeout) }
  }, [utxoId, wallet, nostrPubkeyHex, nonce])

  return { state, retry: () => setNonce(n => n + 1) }
}
