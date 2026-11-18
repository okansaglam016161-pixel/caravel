// The landing page's live user count: how many "identity created" notes exist (messaging/usageStats),
// read with Nostr COUNT (NIP-45) from the relays that support it.
//
//   - Every relay holds a copy of the same notes, so the answer is the HIGHEST relay's number, never
//     the sum.
//   - Everything is bounded by COUNT_TIMEOUT_MS; a relay that is slow, refuses or answers nonsense
//     just does not count. If none answers, the result is null and the pill is not shown.
//   - It starts after the page has rendered, when the browser is idle, so it never delays the page.
//
// The filter is the exact `d` tag of this build (production: `caravel/identity_created`) and
// `since` launch day, so test notes and anything older are never counted.

import { useEffect, useState } from 'react'
import { Relay } from 'nostr-tools/relay'
import type { Filter } from 'nostr-tools/filter'
import { COUNT_RELAYS, COUNT_SINCE, COUNT_TIMEOUT_MS, STAT_NOTE_KIND, statTag } from '../../config/stats'

export function userCountFilter(tagPrefix?: string): Filter {
  return { kinds: [STAT_NOTE_KIND], '#d': [statTag('identity_created', tagPrefix)], since: COUNT_SINCE }
}

/** What countOnRelay needs from a relay connection (a test can stand in for it). */
export interface CountingRelay {
  count(filters: Filter[], params: { id?: string | null }): Promise<number>
  close(): void
}

const connectRelay = (url: string): Promise<CountingRelay> => Relay.connect(url)

/** One relay's count, or null (no answer in time, refused, not a number). Always closes its socket. */
export async function countOnRelay(
  url: string, filter: Filter, timeoutMs: number, connect: (url: string) => Promise<CountingRelay> = connectRelay,
): Promise<number | null> {
  let relay: CountingRelay | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = (async () => {
    relay = await connect(url)
    return relay.count([filter], {})
  })()
  // Whenever the connection does open (even after the timeout), close it.
  work.then(() => relay?.close(), () => relay?.close()).catch(() => undefined)
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
  try {
    const n = await Promise.race([work, timeout])
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The highest count any relay gave, or null when none answered with a number. */
export async function liveUserCount(
  relays: readonly string[], filter: Filter, timeoutMs: number,
  countOne: (url: string, filter: Filter, timeoutMs: number) => Promise<number | null> = countOnRelay,
): Promise<number | null> {
  const answers = await Promise.all(relays.map(url => countOne(url, filter, timeoutMs).catch(() => null)))
  const counts = answers.filter((n): n is number => typeof n === 'number')
  return counts.length > 0 ? Math.max(...counts) : null
}

/** "1,234 Users Live" — "1 User Live" for exactly one. */
export function userCountLabel(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'User' : 'Users'} Live`
}

/** The count for the landing page: null until (and unless) a relay answers. Starts when idle. */
export function useLiveUserCount(): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    const start = () => {
      void liveUserCount(COUNT_RELAYS, userCountFilter(), COUNT_TIMEOUT_MS)
        .then(n => { if (live) setCount(n) })
        .catch(() => undefined)
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    let cancel: () => void
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(start, { timeout: 2000 })
      cancel = () => w.cancelIdleCallback?.(id)
    } else {
      const t = setTimeout(start, 300)
      cancel = () => clearTimeout(t)
    }
    return () => { live = false; cancel() }
  }, [])
  return count
}
