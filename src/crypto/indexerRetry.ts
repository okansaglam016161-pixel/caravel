// Retrying the indexer when it says "busy" — and only in ways that cannot move money twice.
//
// ── WHY THIS EXISTS (Ootle 0.43) ─────────────────────────────────────────────
//
// 0.43 turned the indexer's rate limits on by default and capped concurrent dry runs: a request it
// cannot take now answers 429 (rate limited) or 503 (saturated), often with a `Retry-After`. Before
// this module, every dry run priced a transaction exactly once, so a single 503 reached the user as
// "Could not estimate the network fee: indexer HTTP 503" for a network that was merely busy.
//
// ── THREE KINDS OF ANSWER ────────────────────────────────────────────────────
//
//   busy        429 or 503. The indexer refused before doing anything. Wait (Retry-After if given)
//               and ask again — this indexer or the other one.
//   transient   no answer at all (network error, timeout) or another 5xx. Worth another try.
//   definite    anything else: 2xx, 404, 400 and the rest of 4xx. A 400 from a dry run is a
//               transaction the indexer will not simulate (missing input, bad structure), and
//               asking again gets the same answer. Returned to the caller, never retried.
//
// ── WHAT IS SAFE TO RETRY ────────────────────────────────────────────────────
//
// Dry runs and reads change nothing, so they retry freely and may move to the other indexer.
// A SUBMIT is different — see submitGuard.ts, which retries only a busy refusal, only the identical
// sealed envelope, and only after checking that the first attempt did not land.

/** Attempts for an SDK read (getSubstate, vault ids, the chain tip) when the indexer answers busy. */
export const SDK_READ_ATTEMPTS = 3

/** What the user reads while a busy indexer is being waited out. */
export const RETRYING_MESSAGE = 'Network busy, retrying…'

/** What the user reads when it stayed busy. Nothing was sent: a busy answer is a refusal. */
export const NETWORK_BUSY_MESSAGE = 'The Tari network is busy right now. Nothing was sent — try again in a minute.'

/** Thrown when every attempt was answered "busy". Its message is fit to show as-is. */
export class IndexerBusyError extends Error {
  constructor() {
    super(NETWORK_BUSY_MESSAGE)
    this.name = 'IndexerBusyError'
  }
}

/**
 * Timing, in one mutable place so tests can make waits instant. Not configuration — the values are
 * chosen once, here.
 */
export const retryTiming = {
  /** First backoff when no Retry-After is given; doubles per attempt, with jitter. */
  baseMs: 500,
  /** Ceiling on any one computed backoff. */
  capMs: 8_000,
  /** Ceiling on an indexer-supplied Retry-After, so a hostile or confused header cannot stall us. */
  retryAfterCapMs: 10_000,
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}

export type AnswerKind = 'busy' | 'transient' | 'definite'

/** Classify an HTTP status. */
export function classifyStatus(status: number): AnswerKind {
  if (status === 429 || status === 503) return 'busy'
  if (status >= 500) return 'transient'
  return 'definite'
}

/**
 * True for an error that is the indexer saying "busy". The SDK's transport has no status object —
 * it throws `Error("HTTP 503: Service Unavailable - …")` — so the message is what can be read.
 */
export function isBusyError(e: unknown): boolean {
  if (e instanceof IndexerBusyError) return true
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return /\bHTTP (429|503)\b/.test(msg)
}

/**
 * A `Retry-After` header as milliseconds: delta-seconds or an HTTP date. Null when absent or
 * unreadable. Capped at retryTiming.retryAfterCapMs, never negative.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null) return null
  const v = value.trim()
  if (v === '') return null
  let ms: number
  if (/^\d+$/.test(v)) ms = Number(v) * 1000
  else {
    const at = Date.parse(v)
    if (Number.isNaN(at)) return null
    ms = at - now
  }
  return Math.min(Math.max(0, ms), retryTiming.retryAfterCapMs)
}

/**
 * How long to wait before attempt `attempt + 1` (attempt counts from 1). The indexer's Retry-After
 * wins when it gave one; otherwise exponential backoff with full jitter.
 */
export function backoffMs(attempt: number, retryAfterMs: number | null, random = Math.random): number {
  if (retryAfterMs !== null) return retryAfterMs
  const ceiling = Math.min(retryTiming.capMs, retryTiming.baseMs * 2 ** (attempt - 1))
  return Math.floor(random() * ceiling)
}

/** Either signal aborting aborts the result. AbortSignal.any is too new for every browser we run in. */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController()
  if (a.aborted || b.aborted) { ctrl.abort(); return ctrl.signal }
  const abort = () => ctrl.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return ctrl.signal
}

function retryAfterOf(res: Response): number | null {
  // Test doubles (and some environments) hand back responses without a Headers object.
  const get = (res as { headers?: { get?: (k: string) => string | null } }).headers?.get
  return typeof get === 'function' ? parseRetryAfter(get.call(res.headers, 'retry-after')) : null
}

export interface FetchRetryOptions {
  /** Total attempts across all indexers. */
  attempts: number
  /** Per-request timeout. */
  timeoutMs: number
  /** Called before each retry that follows a BUSY answer — the place to say "Network busy, retrying…". */
  onBusyRetry?: () => void
  /** Try the other indexer on the next attempt. Only for requests that change nothing. */
  alternate?: boolean
  /** An abort that ends the whole thing at once. */
  signal?: AbortSignal
}

/**
 * fetch `path` against `urls` (in preference order — normally INDEXER_URLS) with retry. For
 * requests that CHANGE NOTHING only — dry runs and reads. The list is a parameter rather than an
 * import so indexerConfig's own reads can use this without a circular import.
 *
 * Returns the first definite response (2xx or a non-busy 4xx); the caller reads it as before.
 * Throws IndexerBusyError if every attempt was busy, or the last transport error / a synthetic
 * "HTTP <status>" error if the last attempt was transient.
 */
export async function fetchWithRetry(
  urls: readonly string[],
  path: string,
  init: RequestInit,
  opts: FetchRetryOptions,
): Promise<Response> {
  let lastKind: AnswerKind = 'transient'
  let lastErr: unknown = null

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const base = urls[opts.alternate ? (attempt - 1) % urls.length : 0]!
    let retryAfter: number | null = null

    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs)
      const signal = opts.signal ? mergeSignals(opts.signal, timeout) : timeout
      const res = await fetch(`${base}${path}`, { ...init, signal })
      const kind = classifyStatus(res.status)
      if (kind === 'definite' || res.ok) return res
      lastKind = kind
      lastErr = new Error(`indexer HTTP ${res.status}`)
      retryAfter = retryAfterOf(res)
    } catch (e) {
      if (opts.signal?.aborted) throw e
      lastKind = 'transient'
      lastErr = e
    }

    if (attempt < opts.attempts) {
      if (lastKind === 'busy') opts.onBusyRetry?.()
      await retryTiming.sleep(backoffMs(attempt, lastKind === 'busy' ? retryAfter : null))
    }
  }

  if (lastKind === 'busy') throw new IndexerBusyError()
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Run an SDK call (which throws `HTTP 503: …` on a busy indexer) with retry on BUSY only. Any other
 * error is rethrown at once — the SDK's callers already decide what a failure means. For calls
 * that CHANGE NOTHING only; a submit goes through submitGuard.ts.
 */
export async function withBusyRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; onBusyRetry?: () => void },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!isBusyError(e)) throw e
      if (attempt >= opts.attempts) throw new IndexerBusyError()
      opts.onBusyRetry?.()
      await retryTiming.sleep(backoffMs(attempt, null))
    }
  }
}
