// Blossom upload/download for encrypted image blobs (M2). BUD-01 (retrieval), BUD-02 (upload),
// BUD-11 (authorization).
//
// The host only ever sees ciphertext. It learns the blob's size and the fact that SOMEONE uploaded
// it — and not who: every upload is authorised by a FRESH EPHEMERAL KEY (see buildUploadAuth), so
// nothing ties an upload to the Caravel identity or to any other upload.
//
// Failure classification mirrors crypto/paymentResolver.ts, and for the same reason: the caller
// (M4's resolver hook) needs to know what is worth retrying. A 404 from a host that purged the blob
// is permanent; a dropped connection is not. Getting that split wrong means either a spinner that
// never stops or an image marked dead over a blip.

import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import {
  BLOSSOM_DOWNLOAD_TIMEOUT_MS,
  BLOSSOM_UPLOAD_TIMEOUT_MS,
  DEFAULT_BLOSSOM_HOSTS,
  MAX_DOWNLOAD_BYTES,
} from '../config/blossom'
import { b64urlEncodeString } from './base64'
import { decryptMedia, verifyCiphertextHash } from './mediaCrypto'

// BUD-11 authorization event kind.
const AUTH_KIND = 24242
// How long an upload token stays valid. Long enough for a slow mobile upload, short enough that a
// captured token is worthless almost immediately.
const AUTH_TTL_S = 300
// Encrypted images are far smaller than this (a 1600px re-encode lands at 200-500KB). The cap is a
// guard against uploading something unintended, not a real operating limit.
export const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024

export type UploadResult =
  | { status: 'ok'; url: string; host: string }
  | { status: 'too_large'; bytes: number }
  | { status: 'rejected'; detail: string }      // every host answered, none accepted — terminal
  | { status: 'network_error'; detail: string } // nothing answered — retryable

export type DownloadResult =
  | { status: 'ok'; bytes: ArrayBuffer }
  | { status: 'gone' }            // 404/410 everywhere — the blob is not coming back
  | { status: 'corrupt' }         // hash mismatch: the host served bytes that aren't ours
  | { status: 'undecryptable' }   // GCM auth failed: wrong key/nonce, or tampering
  | { status: 'too_large' }
  | { status: 'network_error'; detail: string }

// ── Pure helpers (unit-tested; no network) ────────────────────────────────────

// Every address this blob could live at, primary URL first. Blossom is CONTENT-ADDRESSED — the same
// bytes have the same `<host>/<sha256>` address on every server — so a blob that has vanished from
// the host named in the message may still be served by another. That is a free durability hedge
// against the sharpest weakness of hosting media off-device: the host purging it and the image
// becoming permanently broken.
export function candidateUrls(primaryUrl: string, x: string, hosts: readonly string[]): string[] {
  const urls: string[] = []
  if (primaryUrl) urls.push(primaryUrl)
  if (x) {
    for (const host of hosts) {
      const url = `${host.replace(/\/+$/, '')}/${x}`
      if (!urls.includes(url)) urls.push(url)
    }
  }
  return urls
}

// Is this HTTP status worth trying again? 404/410 mean the host does not have it and will not
// acquire it. 5xx and 429 are the host having a bad moment. Anything else is treated as terminal
// for that host but we still try the next one.
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

// BUD-11 upload token, signed by a THROWAWAY key.
//
// The spec places no restriction on which pubkey signs — the event's pubkey merely identifies who
// is authorising — so a fresh key per upload costs nothing and means the host cannot correlate our
// uploads with each other or with the user's Nostr identity. Confirmed working against every host
// in DEFAULT_BLOSSOM_HOSTS (probed 2026-08-16).
//
// The trade taken knowingly: BUD-02's DELETE is authorised by the uploader's pubkey, so a blob
// uploaded this way can never be deleted by us. Caravel has no delete-from-host feature and E2E
// media could never rely on one anyway (a recipient may already hold the bytes), so the privacy
// win is worth more than a capability we would not use.
export function buildUploadAuth(x: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const secretKey = generateSecretKey()
  const event = finalizeEvent({
    kind: AUTH_KIND,
    created_at: nowSeconds,
    content: 'Upload encrypted image',
    tags: [
      ['t', 'upload'],
      ['expiration', String(nowSeconds + AUTH_TTL_S)],
      ['x', x],
    ],
  }, secretKey)
  // base64url without padding, per BUD-11 ("as used by JWTs").
  return b64urlEncodeString(JSON.stringify(event))
}

// ── Network ───────────────────────────────────────────────────────────────────

// Upload the ciphertext, trying hosts in order and stopping at the first that accepts.
//
// FIRST SUCCESS WINS, not fan-out: one copy is enough, and uploading to several hosts would mean
// several URLs to carry on the wire and several times the upload wait. Mirroring (BUD-04) would
// harden durability further and is a deliberate later step.
export async function uploadEncryptedBlob(
  ciphertext: ArrayBuffer,
  x: string,
  hosts: readonly string[] = DEFAULT_BLOSSOM_HOSTS,
): Promise<UploadResult> {
  if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
    return { status: 'too_large', bytes: ciphertext.byteLength }
  }

  const rejections: string[] = []
  let sawNetworkFailure = false

  for (const host of hosts) {
    const base = host.replace(/\/+$/, '')
    try {
      const res = await fetch(`${base}/upload`, {
        method: 'PUT',
        signal: AbortSignal.timeout(BLOSSOM_UPLOAD_TIMEOUT_MS),
        headers: {
          // A fresh token per host: each carries its own expiry, and reusing one across hosts would
          // link the uploads by pubkey — the exact correlation the ephemeral key exists to prevent.
          Authorization: `Nostr ${buildUploadAuth(x)}`,
          'Content-Type': 'application/octet-stream',
          'X-SHA-256': x,
        },
        body: ciphertext,
      })

      if (res.ok) {
        // BUD-02 answers with a blob descriptor. Its `url` is authoritative (a host may serve blobs
        // from a CDN domain), but the content-addressed form is a correct fallback if it is absent
        // or malformed.
        let url = ''
        try {
          const descriptor = await res.json() as { url?: unknown }
          if (typeof descriptor.url === 'string') url = descriptor.url
        } catch { /* not JSON — fall through to the hash address */ }
        return { status: 'ok', url: url || `${base}/${x}`, host: base }
      }

      const detail = `${base}: HTTP ${res.status}`
      if (isRetryableStatus(res.status)) sawNetworkFailure = true
      rejections.push(detail)
    } catch (e) {
      // Thrown fetch = transport failure, timeout, or a blocked CORS preflight — all indistinguishable
      // from here and all worth retrying later.
      sawNetworkFailure = true
      rejections.push(`${base}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const detail = rejections.join('; ')
  // If ANY host failed transiently, call the whole attempt retryable — a permanent verdict is only
  // honest when every host actually answered and refused.
  return sawNetworkFailure ? { status: 'network_error', detail } : { status: 'rejected', detail }
}

// Fetch the ciphertext, verify it, decrypt it. Tries the primary URL, then the same blob's
// content address on each configured host.
export async function downloadAndDecrypt(
  primaryUrl: string,
  x: string,
  keyB64: string,
  nonceB64: string,
  hosts: readonly string[] = DEFAULT_BLOSSOM_HOSTS,
): Promise<DownloadResult> {
  const urls = candidateUrls(primaryUrl, x, hosts)
  if (urls.length === 0) return { status: 'gone' }

  let sawNetworkFailure = false
  let sawCorrupt = false
  const details: string[] = []

  for (const url of urls) {
    let ciphertext: ArrayBuffer
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(BLOSSOM_DOWNLOAD_TIMEOUT_MS) })
      if (!res.ok) {
        if (isRetryableStatus(res.status)) sawNetworkFailure = true
        details.push(`${url}: HTTP ${res.status}`)
        continue    // 404 here just means THIS host doesn't have it — try the next address
      }
      // Trust the header only as an early exit; the real check is the buffered length below, since
      // Content-Length can be absent or wrong.
      const declared = Number(res.headers.get('content-length') ?? NaN)
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return { status: 'too_large' }
      ciphertext = await res.arrayBuffer()
      if (ciphertext.byteLength > MAX_DOWNLOAD_BYTES) return { status: 'too_large' }
    } catch (e) {
      sawNetworkFailure = true
      details.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    // Wrong bytes from this host — but another host may hold the right ones, so keep going rather
    // than condemning the image on one bad mirror.
    if (!(await verifyCiphertextHash(ciphertext, x))) {
      sawCorrupt = true
      details.push(`${url}: sha256 mismatch`)
      continue
    }

    try {
      return { status: 'ok', bytes: await decryptMedia(ciphertext, keyB64, nonceB64) }
    } catch {
      // The bytes matched the hash the SENDER published, so the blob is right and the key is not.
      // No other host can fix that — stop immediately.
      return { status: 'undecryptable' }
    }
  }

  if (sawNetworkFailure) return { status: 'network_error', detail: details.join('; ') }
  if (sawCorrupt) return { status: 'corrupt' }
  return { status: 'gone' }
}
