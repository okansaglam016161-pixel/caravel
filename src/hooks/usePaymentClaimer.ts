// The BACKGROUND CLAIMER — claims received chat payments through Sapient, whether or not their thread
// is open, and remembers the outcome.
//
// Runs while chat is unlocked (ChatApp stays mounted across tabs). Whenever Sapient is connected with
// view access, every received payment from an accepted contact that has no stored outcome is claimed,
// one at a time (sapient/payments.claimPayment). It starts again on its own when that changes —
// connect, Grant, unlock, a new payment, a contact accepted.
//
//   verified / unverified   stored; never claimed again
//   not-found               indexer lag is normal right after a send: asked again after 15 s, 45 s,
//                           90 s and 3 min; after that stored as `unconfirmed` (the card's Retry clears it)
//   an error (locked, network)  stops the pass; the next state change, or a 30 s cool-down, resumes it

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSapient } from '../context/SapientContext'
import { claimPayment } from '../sapient/payments'
import { claimCandidates, claimReady, ownSendTxIds } from '../messaging/paymentClaims'
import { loadClaims, removeClaims, saveClaim, type ClaimMap } from '../messaging/paymentClaimStore'
import { outboxTxIds } from '../messaging/paymentOutbox'
import type { CaravelMessage } from '../messaging/types'
import type { ContactMap } from '../messaging/contactStore'

const RETRY_DELAYS_MS = [15_000, 45_000, 90_000, 180_000]
const ERROR_COOLDOWN_MS = 30_000

export function usePaymentClaimer(me: string | null, messages: readonly CaravelMessage[], contacts: ContactMap) {
  const sapient = useSapient()
  const [claims, setClaims] = useState<ClaimMap>({})
  const [busy, setBusy] = useState<Record<string, 'claiming' | 'retrying'>>({})
  const [tick, setTick] = useState(0)
  const attemptsRef = useRef(new Map<string, number>())
  const runningRef = useRef(false)
  const cooldownUntilRef = useRef(0)

  useEffect(() => {
    setClaims(me ? loadClaims(me) : {})
    setBusy({})
    attemptsRef.current = new Map()
  }, [me])

  const candidates = useMemo(() => claimCandidates(messages, contacts), [messages, contacts])

  useEffect(() => {
    const p = sapient.provider
    if (!me || !p || runningRef.current) return
    if (Date.now() < cooldownUntilRef.current) return
    const todo = candidates.filter(ref => !claims[ref.utxoId] && !busy[ref.utxoId] && claimReady(sapient, ref))
    if (todo.length === 0) return

    runningRef.current = true
    const own = ownSendTxIds(messages, outboxTxIds(me))
    const setBusyFor = (id: string, v: 'claiming' | 'retrying' | null) =>
      setBusy(b => { const n = { ...b }; if (v) n[id] = v; else delete n[id]; return n })

    void (async () => {
      for (const ref of todo) {
        const id = ref.utxoId
        setBusyFor(id, 'claiming')
        try {
          const out = await claimPayment(p, ref, own)
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
        } catch {
          // Locked, disconnected mid-pass, or the network: stop, and come back later.
          setBusyFor(id, null)
          cooldownUntilRef.current = Date.now() + ERROR_COOLDOWN_MS
          setTimeout(() => setTick(t => t + 1), ERROR_COOLDOWN_MS)
          break
        }
      }
      runningRef.current = false
      setTick(t => t + 1)   // anything that arrived during the pass
    })()
  }, [me, sapient, candidates, claims, busy, messages, tick])

  /** The card's Retry on an unconfirmed payment: forget the outcome and claim it again. */
  const retry = useCallback((utxoId: string) => {
    if (!me) return
    removeClaims(me, [utxoId])
    attemptsRef.current.delete(utxoId)
    cooldownUntilRef.current = 0
    setClaims(c => { const n = { ...c }; delete n[utxoId]; return n })
    setTick(t => t + 1)
  }, [me])

  return { claims, busy, retry }
}
