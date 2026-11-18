// Sends the anonymous usage notes (messaging/usageStats) when their delay has passed. Mounted once,
// in the signed-in shell; runs only while chat is unlocked (the queue is sealed with the chat key).
//
// FIRE AND FORGET. Nothing here can affect the app: every failure is swallowed, and a note that did
// not reach any relay stays queued for the next check (on unlock, and every STAT_CHECK_MS).
//
// It also records the first Sapient connection for this identity (`wallet_connected`).

import { useEffect, useRef } from 'react'
import { useSapient } from '../context/SapientContext'
import { DEFAULT_RELAYS } from '../config/relays'
import { STAT_CHECK_MS } from '../config/stats'
import { publishGiftWrap } from '../crypto/nostrMessaging'
import { buildStatNote, markSent, queueStat, takeDue } from '../messaging/usageStats'

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
          // Published through the shared helper: a fresh connection to each relay, with retries.
          // The name says gift wrap; it publishes any signed event.
          const results = await publishGiftWrap(buildStatNote(kind), [...DEFAULT_RELAYS], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
          const ok = results.filter(r => r.ok).length
          devLog(kind, `published to ${ok}/${results.length} relays`)
          if (ok > 0 && live) markSent(me, kind)
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
