// The BACKGROUND CLAIMER — claims received chat payments through Sapient, whether or not their thread
// is open, and remembers the outcome.
//
// Runs while chat is unlocked (ChatApp stays mounted across tabs). Whenever Sapient is connected,
// UNLOCKED and has view access, every received payment from an accepted contact that has no stored
// outcome is claimed, one at a time (sapient/payments.claimPayment).
//
//   verified / unverified / unconfirmed   stored; claimed again only by the card's Retry
//   not-found      indexer lag is normal right after a send: asked again after 15 s, 45 s, 90 s and
//                  3 min; after that stored as `unconfirmed`
//   locked         reported to SapientContext at once (the pill and the cards say "Unlock"); nothing
//                  is retried until Sapient is usable again, and then everything is, straight away
//   other errors   that payment shows "Couldn't reach Sapient" with Retry; the pass stops, and starts
//                  again after a cool-down, or at once when Sapient's state changes
//
// THE STUCK CARD (fixed here): a locked wallet used to fail every claim silently while the card stayed
// on "Confirming with Sapient…", and the only way back was a single 30 s timer whose re-run was gated
// on `Date.now() < cooldownUntil` — a timer firing even a millisecond early left the gate shut with
// nothing to re-open it, until a reload. The cool-down is now plain state the timer clears, a change
// in Sapient's readiness clears it too, and every Sapient call is bounded so a pass can never hang.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSapient } from '../context/SapientContext'
import { claimPayment } from '../sapient/payments'
import { toSapientError, withTimeout } from '../sapient/provider'
import { claimCandidates, claimReady, ownSendTxIds, type ClaimBusy } from '../messaging/paymentClaims'
import { loadClaims, removeClaims, saveClaim, type ClaimMap } from '../messaging/paymentClaimStore'
import { outboxTxIds } from '../messaging/paymentOutbox'
import type { CaravelMessage } from '../messaging/types'
import type { ContactMap } from '../messaging/contactStore'

const RETRY_DELAYS_MS = [15_000, 45_000, 90_000, 180_000]
const ERROR_COOLDOWN_MS = 30_000
/** A claim reads the chain; one that has not answered by then is treated as an error, not waited on. */
export const CLAIM_TIMEOUT_MS = 90_000

export function usePaymentClaimer(me: string | null, messages: readonly CaravelMessage[], contacts: ContactMap) {
  const sapient = useSapient()
  const [claims, setClaims] = useState<ClaimMap>({})
  const [busy, setBusy] = useState<Record<string, ClaimBusy>>({})
  const [tick, setTick] = useState(0)
  const [cooling, setCooling] = useState(false)
  const attemptsRef = useRef(new Map<string, number>())
  const runningRef = useRef(false)
  const sapientRef = useRef(sapient)
  useEffect(() => { sapientRef.current = sapient }, [sapient])

  useEffect(() => {
    setClaims(me ? loadClaims(me) : {})
    setBusy({})
    attemptsRef.current = new Map()
  }, [me])

  // Sapient became usable (unlocked, connected, granted, network switched): start again NOW — no
  // waiting out a cool-down, and payments that errored get another go.
  const readyKey = `${sapient.status}|${sapient.viewAccess}|${sapient.network}`
  useEffect(() => {
    setCooling(false)
    setBusy(b => {
      if (!Object.values(b).includes('error')) return b
      const n: Record<string, ClaimBusy> = {}
      for (const [k, v] of Object.entries(b)) if (v !== 'error') n[k] = v
      return n
    })
  }, [readyKey])

  const candidates = useMemo(() => claimCandidates(messages, contacts), [messages, contacts])

  useEffect(() => {
    const p = sapient.provider
    if (!me || !p || runningRef.current || cooling) return
    const todo = candidates.filter(ref => !claims[ref.utxoId] && !busy[ref.utxoId] && claimReady(sapient, ref))
    if (todo.length === 0) return

    runningRef.current = true
    const own = ownSendTxIds(messages, outboxTxIds(me))
    const setBusyFor = (id: string, v: ClaimBusy | null) =>
      setBusy(b => { const n = { ...b }; if (v) n[id] = v; else delete n[id]; return n })

    void (async () => {
      for (const ref of todo) {
        const id = ref.utxoId
        setBusyFor(id, 'claiming')
        try {
          const out = await withTimeout(claimPayment(p, ref, own), CLAIM_TIMEOUT_MS)
          if (out.s === 'not-found') {
            const n = (attemptsRef.current.get(id) ?? 0) + 1
            attemptsRef.current.set(id, n)
            if (n > RETRY_DELAYS_MS.length) {
              saveClaim(me, id, { s: 'unconfirmed' })
              setClaims(c => ({ ...c, [id]: { s: 'unconfirmed' } }))
              setBusyFor(id, null)
            } else {
              setBusyFor(id, 'retrying')
              setTimeout(() => { setBusyFor(id, null); setTick(t => t + 1) }, RETRY_DELAYS_MS[n - 1])
            }
          } else {
            saveClaim(me, id, out)
            setClaims(c => ({ ...c, [id]: out }))
            setBusyFor(id, null)
          }
        } catch (e) {
          if (toSapientError(e).kind === 'locked') {
            // Show it at once; the unlock (SapientContext's session check) restarts everything.
            setBusyFor(id, null)
            sapientRef.current.reportLocked()
          } else {
            setBusyFor(id, 'error')
            setCooling(true)
            setTimeout(() => setCooling(false), ERROR_COOLDOWN_MS)
          }
          break
        }
      }
      runningRef.current = false
      setTick(t => t + 1)   // anything that arrived during the pass
    })()
  }, [me, sapient, candidates, claims, busy, messages, tick, cooling])

  /**
   * The card's Retry, on any payment not verified yet: re-check the Sapient session, forget any
   * stored outcome, and claim it again now. A memo that really does not match stays unverified.
   */
  const retry = useCallback((utxoId: string) => {
    if (!me) return
    void sapientRef.current.refresh()
    removeClaims(me, [utxoId])
    attemptsRef.current.delete(utxoId)
    setCooling(false)
    setClaims(c => { if (!(utxoId in c)) return c; const n = { ...c }; delete n[utxoId]; return n })
    setBusy(b => { if (b[utxoId] !== 'error' && b[utxoId] !== 'retrying') return b; const n = { ...b }; delete n[utxoId]; return n })
    setTick(t => t + 1)
  }, [me])

  return { claims, busy, retry }
}
