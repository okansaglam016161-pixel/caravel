// The market, kept fresh while somebody is looking — and only then.
//
// One feed per wallet. It refreshes (crypto/market.MarketReader) when the first subscriber arrives,
// then every POLL_MS while anyone is subscribed and the page is visible; a failed refresh backs off,
// doubling to MAX_BACKOFF_MS, so a struggling indexer is not hammered. Never two refreshes at once.
//
// ── THE FOUR STATES, AND WHAT THEY PROMISE ───────────────────────────────────
//
//   loading      nothing read yet. Show no figures.
//   ready        `data` is the latest refresh, read at `data.at`.
//   updating     a refresh is running; `data` is the previous one (still the latest known).
//   unreachable  the last refresh failed. `data`, if any, is from `data.at` and MUST be shown as
//                such ("as of …") — never as current. With no data at all, there is nothing to show.
//
// So a figure on screen is always one the chain gave at a stated moment: never an invented one, and
// never an old one passed off as now.

import type { MarketData } from './market'

export type MarketStatus = 'loading' | 'ready' | 'updating' | 'unreachable'

export interface MarketSnapshot {
  status: MarketStatus
  data: MarketData | null
  /** Why the last refresh failed (status unreachable). */
  error: string | null
}

export const POLL_MS = 20_000
export const MAX_BACKOFF_MS = 120_000

export interface MarketFeed {
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => MarketSnapshot
  /** Refresh now (after a trade, or on a Refresh button). Resolves when done; never throws. */
  refresh: () => Promise<void>
  /** Stop polling for good (a locked wallet). */
  stop: () => void
}

export interface FeedOptions {
  pollMs?: number
  maxBackoffMs?: number
  /** Is the page hidden? Polling pauses (the next tick re-checks). Default: document.visibilityState. */
  isHidden?: () => boolean
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export function createMarketFeed(reader: { refresh(): Promise<MarketData> }, opts: FeedOptions = {}): MarketFeed {
  const pollMs = opts.pollMs ?? POLL_MS
  const maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS
  const isHidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden')
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))

  let snapshot: MarketSnapshot = { status: 'loading', data: null, error: null }
  const listeners = new Set<() => void>()
  let running: Promise<void> | null = null
  let timer: unknown = null
  let failures = 0
  let stopped = false

  const emit = (next: MarketSnapshot) => { snapshot = next; for (const l of listeners) l() }

  function schedule() {
    if (timer !== null) { clearTimer(timer); timer = null }
    if (stopped || listeners.size === 0) return
    const delay = failures === 0 ? pollMs : Math.min(maxBackoff, pollMs * 2 ** failures)
    timer = setTimer(() => { timer = null; void tick() }, delay)
  }

  async function tick() {
    if (stopped || listeners.size === 0) return
    if (isHidden()) { schedule(); return }   // paused while nobody can see it
    await refresh()
  }

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (running) return running
    if (snapshot.data) emit({ ...snapshot, status: 'updating' })
    running = (async () => {
      try {
        const data = await reader.refresh()
        failures = 0
        // Keep the last known recent trades when only that list failed this time.
        emit({ status: 'ready', data: data.recent === null && snapshot.data ? { ...data, recent: snapshot.data.recent } : data, error: null })
      } catch (e) {
        failures++
        emit({ status: 'unreachable', data: snapshot.data, error: e instanceof Error ? e.message : String(e) })
      } finally {
        running = null
        schedule()
      }
    })()
    return running
  }

  return {
    subscribe(onChange) {
      listeners.add(onChange)
      if (listeners.size === 1) {
        const fresh = snapshot.data && Date.now() - snapshot.data.at < pollMs
        if (fresh) schedule(); else void refresh()
      }
      return () => {
        listeners.delete(onChange)
        if (listeners.size === 0 && timer !== null) { clearTimer(timer); timer = null }
      }
    },
    getSnapshot: () => snapshot,
    refresh,
    stop() {
      stopped = true
      if (timer !== null) { clearTimer(timer); timer = null }
    },
  }
}
