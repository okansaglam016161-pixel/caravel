// Sends the anonymous usage notes (messaging/usageStats) when their delay has passed. Mounted once,
// in the signed-in shell; runs only while chat is unlocked (the queue is sealed with the chat key).
//
// FIRE AND FORGET. Nothing here can affect the app: every failure is swallowed. A note waits for
// every relay it was sent to (publishToAll) and stays queued until all the COUNT relays hold it; the
// next check (on unlock, and every STAT_CHECK_MS) resends the same note to the ones still missing it.
//
// It also records the first Sapient connection for this identity (`wallet_connected`).

import { useEffect, useRef } from 'react'
import { useSapient } from '../context/SapientContext'
import { STAT_CHECK_MS } from '../config/stats'
import { publishToAll } from '../crypto/nostrMessaging'
import { noteToSend, queueStat, recordDelivery, takeDue } from '../messaging/usageStats'

const PUBLISH_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 10_000

function devLog(...args: unknown[]) {
  if (import.meta.env.DEV) console.info('[usage-stats]', ...args)
}

export function useUsageStats(me: string | null) {
  const { status } = useSapient()
  const runningRef = useRef(false)

  // First Sapient connection for this identity.
  useEffect(() => {
    if (!me || status !== 'connected') return
    try { queueStat(me, 'wallet_connected') } catch { /* never affects the app */ }
  }, [me, status])

  // Send whatever is due: now (this unlock), then on an interval.
  useEffect(() => {
    if (!me) return
    let live = true
    const tick = async () => {
      if (runningRef.current) return
      runningRef.current = true
      try {
        for (const kind of takeDue(me)) {
          if (!live) break
          const send = noteToSend(me, kind)
          if (!send || send.relays.length === 0) continue
          // Waits for every relay (a fresh connection each, with the bounded per-relay retry).
          const results = await publishToAll(send.event, send.relays, PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
          if (!live) break
          const accepted = results.filter(r => r.ok).map(r => r.relay)
          const { done, missing } = recordDelivery(me, kind, accepted)
          devLog(kind, `published to ${accepted.length}/${results.length} relays`,
            results.filter(r => !r.ok).map(r => `${r.relay}: ${r.error ?? 'rejected'}`),
            done ? '(on every COUNT relay: done)' : `(will resend to: ${missing.join(', ')})`)
        }
      } catch (e) {
        devLog('check failed', e)
      } finally {
        runningRef.current = false
      }
    }
    void tick()
    const iv = setInterval(() => { void tick() }, STAT_CHECK_MS)
    return () => { live = false; clearInterval(iv) }
  }, [me])
}
