import { useEffect, useState } from 'react'
import { useWallet } from '../context/WalletContext'
import { downloadAndDecrypt, isTerminalDownloadStatus, type DownloadResult } from '../crypto/blossomClient'
import { getBlob, putBlob } from '../messaging/blobCache'
import type { MediaRef } from '../messaging/types'

// ── Image resolution (images M4) ──────────────────────────────────────────────
//
// The twin of usePaymentResolution, and deliberately so: cache-first, module-level in-flight dedup
// keyed per identity, bounded backoff for transient failures only, no polling, terminal failures
// never retried. Same shape, same backoff numbers, same cancellation style (a `cancelled` flag plus
// cleared timers rather than an AbortSignal).
//
// TWO HONEST DIVERGENCES from that hook, both forced rather than chosen:
//
//   1. NO SEPARATE 'decrypting' STATE. downloadAndDecrypt performs fetch → host fallback → hash
//      verify → decrypt inside one call, so the boundary is not observable from here. Splitting M2's
//      API to expose it would scatter the host-fallback logic for the sake of a spinner label.
//
//   2. A CACHE HIT CANNOT RENDER ON THE FIRST PAINT. usePaymentResolution seeds useState
//      synchronously from localStorage; getBlob is IndexedDB and therefore async, so even a fully
//      cached image shows 'loading' for one tick. The sized box in MediaMessageCard absorbs this —
//      it is a brief empty frame, never a layout jump. If that flash ever looks bad, the fix is a
//      small synchronous in-memory LRU in front of the async cache; deliberately not built for a
//      problem nobody has reported.

type MediaFailure = 'gone' | 'corrupt' | 'undecryptable' | 'too_large' | 'network_error'

export type MediaState =
  | { kind: 'loading' }
  | { kind: 'retrying' }
  | { kind: 'ready'; url: string }
  | { kind: 'failed'; reason: MediaFailure }

// Internal: what the resolution effect produces. Kept separate from MediaState because the object
// URL is owned by a DIFFERENT effect (see below) and must not be threaded through this one.
type Resolution =
  | { kind: 'loading' }
  | { kind: 'retrying' }
  | { kind: 'bytes'; bytes: ArrayBuffer; mime: string }
  | { kind: 'failed'; reason: MediaFailure }

// In-flight dedup: one download per (identity, ciphertext hash), however many cards mount at once,
// and however many times StrictMode double-invokes the effect. Keyed by pubkey too so it cannot leak
// across identities — the same rule as usePaymentResolution's inflightResolve.
//
// ⚠️ THIS MAP HOLDS ArrayBuffers ONLY, NEVER OBJECT URLs. Caching a URL here would outlive every
// component that could revoke it, which is precisely the leak this module is built to avoid. Each
// hook instance mints its own URL from the shared bytes and revokes exactly that one.
const inflightMedia = new Map<string, Promise<DownloadResult>>()

function dedupDownload(pubkeyHex: string, media: MediaRef): Promise<DownloadResult> {
  const k = `${pubkeyHex}:${media.x}`
  const existing = inflightMedia.get(k)
  if (existing) return existing
  const p = downloadAndDecrypt(media.url, media.x, media.key, media.nonce)
    .finally(() => { inflightMedia.delete(k) })
  inflightMedia.set(k, p)
  return p
}

// Three bounded auto-retries after the first attempt, transient failures only. Same schedule as
// payment resolution — one policy for "the network was briefly unavailable" across the app.
const MEDIA_BACKOFFS_MS = [2_000, 4_000, 8_000]

export function useMediaResolution(media: MediaRef): { state: MediaState; retry: () => void } {
  const { nostrPubkeyHex } = useWallet()
  const [nonce, setNonce] = useState(0)
  const [resolution, setResolution] = useState<Resolution>({ kind: 'loading' })
  const [url, setUrl] = useState<string | null>(null)

  // ── Effect 1: get the decrypted bytes (cache first, then the network) ──────
  //
  // `media` is safe as a dependency: it comes from a stored CaravelMessage, and the message store is
  // append-only with first-write-wins, so a row object's identity is stable even as the surrounding
  // array is recreated.
  useEffect(() => {
    const pubkeyHex = nostrPubkeyHex
    if (!pubkeyHex || !media.x) return

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    if (nonce > 0) setResolution({ kind: 'loading' })   // manual retry resets the visible state

    async function attempt(i: number) {
      const res = await dedupDownload(pubkeyHex!, media)
      if (cancelled) return

      if (res.status === 'ok') {
        // Fire-and-forget: a failed cache write costs one future re-download, never the image.
        void putBlob(pubkeyHex!, media.x, res.bytes, media.mime)
        setResolution({ kind: 'bytes', bytes: res.bytes, mime: media.mime })
        return
      }
      if (isTerminalDownloadStatus(res.status)) {
        setResolution({ kind: 'failed', reason: res.status })   // never auto-retried
        return
      }
      if (i < MEDIA_BACKOFFS_MS.length) {
        setResolution({ kind: 'retrying' })
        timers.push(setTimeout(() => void attempt(i + 1), MEDIA_BACKOFFS_MS[i]))
      } else {
        setResolution({ kind: 'failed', reason: 'network_error' })   // retries exhausted
      }
    }

    async function run() {
      // CACHE FIRST — a hit means no network at all, so re-opening a thread costs nothing and leaks
      // nothing further to the blob host.
      const cached = await getBlob(pubkeyHex!, media.x)
      if (cancelled) return
      if (cached) {
        setResolution({ kind: 'bytes', bytes: cached.bytes, mime: cached.mime })
        return
      }
      await attempt(0)
    }

    void run()
    return () => { cancelled = true; timers.forEach(clearTimeout) }
  }, [media, nostrPubkeyHex, nonce])

  // ── Effect 2: own the object URL ──────────────────────────────────────────
  //
  // THE RULE, and the whole reason this is a separate effect: THE EFFECT THAT CREATES A URL IS THE
  // EFFECT THAT REVOKES IT. `objectUrl` is captured in this run's closure, so the cleanup can only
  // ever revoke the URL its own run created — the classic bug where a re-render revokes a URL that
  // state still points at is structurally impossible here.
  //
  // That covers unmount, a change of image (thread switch reusing the component), and StrictMode's
  // synthetic unmount, all through one path.
  //
  // ⚠️ DO NOT "OPTIMISE" THIS by hoisting the URL into a ref, a module-level map, or the dedup cache
  // above to avoid recreating it. A URL that outlives the component that owns it is a leak for the
  // page's lifetime, and in a scrolling image list they accumulate. Recreating a URL from bytes
  // already in memory is essentially free; leaking one is not.
  useEffect(() => {
    if (resolution.kind !== 'bytes') { setUrl(null); return }
    const objectUrl = URL.createObjectURL(new Blob([resolution.bytes], { type: resolution.mime }))
    setUrl(objectUrl)
    return () => { URL.revokeObjectURL(objectUrl); setUrl(null) }
  }, [resolution])

  // Bytes-but-no-URL is the single tick between the two effects — report it as loading rather than
  // inventing a state for it.
  const state: MediaState =
    resolution.kind === 'bytes'
      ? (url ? { kind: 'ready', url } : { kind: 'loading' })
      : resolution

  return { state, retry: () => setNonce(n => n + 1) }
}
