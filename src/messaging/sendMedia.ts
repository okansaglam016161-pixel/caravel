// Send an image as a message (images M3): the orchestration that turns a picked file into a sent
// CaravelMessage carrying a MediaRef.
//
// ── WHY THIS LIVES ABOVE THE PROVIDER ────────────────────────────────────────────
// Three layers, deliberately kept apart:
//   crypto/imageProcess + mediaCrypto + blossomClient   the toolkit: pixels, AES-GCM, HTTP
//   NostrMessagingProvider                              relays and gift wraps, knows nothing of Blossom
//   THIS FILE                                           the sequence that joins them
//
// It is the same shape as ChatApp.submitPayment, which settles an on-chain transaction FIRST and
// then sends a message referencing it. The provider has no idea Tari exists; it should have no idea
// Blossom exists either. Both are "do the expensive, failure-prone thing, then send a small
// reference to it".
//
// ── THE ORPHAN CASE IS BENIGN — DO NOT BUILD AN ALERT FOR IT ─────────────────────
// If the upload succeeds and the message send then fails, a blob is left on a third-party host that
// NOBODY CAN EVER DECRYPT: the content key was generated on this device, lives only in the message
// that failed to send, and was never transmitted. The residue is a few hundred KB of noise the host
// eventually evicts.
//
// This is the crucial difference from submitPayment's 'orphan' alert, which exists because money
// MOVED and the recipient has funds with no explanation. Nothing moved here. A future UI milestone
// should surface the send failure exactly as it would for a failed text message — and must NOT add a
// scary payment-style warning about the uploaded blob.

import { ImageTooLargeError, processImage } from '../crypto/imageProcess'
import { encryptMedia } from '../crypto/mediaCrypto'
import { uploadEncryptedBlob } from '../crypto/blossomClient'
import type { CaravelMessage, GroupSendResult, MediaRef, MessagingProvider } from './types'

// NIP-44 requires at least one byte of content, so a captionless image sends a single space — the
// same floor wrapGroupLeave and the address control message already use.
const EMPTY_CAPTION = ' '

// Why a send failed, for a UI that has to say something useful. Distinguishes the stages AND the
// reason within a stage, because they need different words and different affordances: "that image is
// too big" is the user's problem to fix, "no host accepted it" is ours, and only some of them are
// worth a Retry button.
export type MediaSendError =
  | { stage: 'process'; reason: 'too_large' | 'undecodable'; detail: string }
  | { stage: 'upload'; reason: 'too_large' | 'rejected' | 'network_error'; detail: string }
  | { stage: 'send'; detail: string }      // uploaded fine; the gift wrap did not reach a relay

export class MediaSendFailure extends Error {
  // Declared explicitly rather than as a constructor parameter property: this tsconfig sets
  // `erasableSyntaxOnly`, which forbids the shorthand.
  readonly info: MediaSendError
  constructor(info: MediaSendError) {
    super(`${info.stage}: ${info.detail}`)
    this.name = 'MediaSendFailure'
    this.info = info
  }
}

// Everything up to (but not including) the send: downscale + strip metadata → encrypt → upload.
// Shared by the DM and group paths so a group upload can never accidentally happen per-member.
async function prepare(file: Blob, onStage?: (stage: MediaSendStage) => void): Promise<{ media: MediaRef; plaintextBytes: ArrayBuffer }> {
  onStage?.('process')
  let processed
  try {
    processed = await processImage(file)
  } catch (e) {
    // The two process failures need different words: a file over the size cap is the user's to fix,
    // while an undecodable one usually means the browser lacks a codec (HEIC on anything that isn't
    // Safari or Chrome-on-macOS) and no amount of retrying will help.
    throw new MediaSendFailure({
      stage: 'process',
      reason: e instanceof ImageTooLargeError ? 'too_large' : 'undecodable',
      detail: e instanceof Error ? e.message : String(e),
    })
  }

  // Encrypt BEFORE upload, always: the host must never see anything but ciphertext. Encryption is
  // folded into the 'upload' stage rather than given its own: AES-GCM over a few hundred KB is
  // milliseconds, so a label for it would flicker past unread.
  onStage?.('upload')
  const enc = await encryptMedia(processed.bytes)

  const upload = await uploadEncryptedBlob(enc.ciphertext, enc.x)
  if (upload.status !== 'ok') {
    throw new MediaSendFailure({
      stage: 'upload',
      reason: upload.status,
      detail: upload.status === 'too_large' ? `encrypted image is ${upload.bytes} bytes` : upload.detail,
    })
  }

  return {
    media: {
      url: upload.url,
      key: enc.keyB64,
      nonce: enc.nonceB64,
      mime: processed.mime,
      x: enc.x,
      ox: enc.ox,
      width: processed.width,
      height: processed.height,
      size: enc.ciphertext.byteLength,
    },
    // Returned so the caller can seed the blob cache with bytes it already holds, sparing the sender
    // a pointless download of an image they just chose. (Wired in the resolver milestone.)
    plaintextBytes: processed.bytes,
  }
}

// Send an image to one peer. `tariAddress` piggybacks the same self-healing address exchange an
// ordinary message does — captionless images are explicitly handled on the receive side, so this is
// safe to attach here (see the `!media` clause in NostrMessagingProvider.handleEvent).
export async function sendImageToPeer(
  provider: MessagingProvider,
  file: Blob,
  peerHex: string,
  caption?: string,
  tariAddress?: string,
  onStage?: (stage: MediaSendStage) => void,
): Promise<{ message: CaravelMessage; plaintextBytes: ArrayBuffer }> {
  const { media, plaintextBytes } = await prepare(file, onStage)
  onStage?.('send')
  try {
    const message = await provider.sendMessage(peerHex, caption?.trim() || EMPTY_CAPTION, undefined, tariAddress, media)
    return { message, plaintextBytes }
  } catch (e) {
    // The benign orphan — see the header. The blob is undecryptable noise; report only the send.
    throw new MediaSendFailure({ stage: 'send', detail: e instanceof Error ? e.message : String(e) })
  }
}

// Send an image to a group. ONE upload, N wraps: `prepare` runs once, outside the fan-out, and the
// identical MediaRef goes to every member. A 20-person group costs exactly one upload.
export async function sendImageToGroup(
  provider: MessagingProvider,
  file: Blob,
  groupId: string,
  memberPubkeysHex: string[],
  caption?: string,
  onStage?: (stage: MediaSendStage) => void,
): Promise<{ result: GroupSendResult; plaintextBytes: ArrayBuffer }> {
  const { media, plaintextBytes } = await prepare(file, onStage)
  onStage?.('send')
  try {
    const result = await provider.sendGroupMessage(groupId, memberPubkeysHex, caption?.trim() || EMPTY_CAPTION, media)
    return { result, plaintextBytes }
  } catch (e) {
    throw new MediaSendFailure({ stage: 'send', detail: e instanceof Error ? e.message : String(e) })
  }
}

// ── Progress ──────────────────────────────────────────────────────────────────

// Which stage the send is in. THE SAME THREE NAMES MediaSendError uses, deliberately: one vocabulary
// describes where a send has got to and, if it breaks, where it broke.
export type MediaSendStage = 'process' | 'upload' | 'send'

// What the provisional bubble says while a send is running.
//
// STAGES, NOT A PERCENTAGE — and that is a limitation of the platform, not a shortcut. `fetch` cannot
// report upload progress at all; only XMLHttpRequest.upload can, so a real percentage would mean
// rewriting the upload client that has been live-tested against three real hosts (CORS preflight
// included) for a cosmetic gain. And a downscaled 1600px WebP is 200-500KB, which on any ordinary
// connection fills a progress bar faster than the eye resolves — a bar that is always instantly full
// tells the user less than a word saying what is actually happening.
const STAGE_LABEL: Record<MediaSendStage, string> = {
  process: 'Preparing…',
  upload: 'Uploading…',
  send: 'Sending…',
}

export function describeMediaStage(stage: MediaSendStage): string {
  return STAGE_LABEL[stage]
}

// ── Turning a failure into something a user can act on ────────────────────────

// Is this a HEIC/HEIF file? Checks the MIME type AND the extension, because `file.type` comes back
// blank on some platforms and browsers — trusting it alone is how a HEIC gets reported as a generic
// unreadable file with no useful advice.
//
// DELIBERATELY NOT AN ALLOWLIST. Nothing anywhere refuses a file for being HEIC; the pipeline simply
// tries to decode everything and this only supplies a better EXPLANATION when the decode fails. A
// browser that can decode HEIC (Safari, Chrome on macOS, which delegate to the system codec) sails
// straight through and never reaches this.
export function isHeicFile(name: string, type: string): boolean {
  const t = (type || '').toLowerCase()
  if (t.startsWith('image/heic') || t.startsWith('image/heif')) return true
  return /\.(heic|heif)$/i.test(name || '')
}

export interface MediaFailureCopy {
  label: string          // short, shown in red on the failed bubble
  hint: string | null    // the actionable line beneath it, or null when there is nothing to add
  retryable: boolean     // false hides Retry — offering a button that cannot work is worse than none
}

// Is retrying this failure capable of a different outcome?
//
// Same principle as isTerminalDownloadStatus on the receive side: a Retry button that cannot change
// anything is a lie. A file the browser cannot decode, or one over the size cap, will fail
// identically forever; a host that refused the ciphertext will refuse it again. Only genuine network
// trouble and a failed relay publish are worth another go.
export function isRetryableMediaFailure(info: MediaSendError): boolean {
  if (info.stage === 'process') return false
  if (info.stage === 'upload') return info.reason === 'network_error'
  return true   // 'send' — the blob is up; only the gift wrap failed to reach a relay
}

// Human copy for a failed image send.
//
// `file` is optional and used only to recognise HEIC. Passing it turns the single most likely real
// failure — an iPhone photo on a browser with no HEVC licence — from "couldn't prepare this image"
// into advice the user can act on immediately.
export function describeMediaFailure(err: unknown, file?: { name: string; type: string }): MediaFailureCopy {
  if (!(err instanceof MediaSendFailure)) {
    return { label: 'Couldn’t send the image', hint: null, retryable: true }
  }
  const info = err.info
  const retryable = isRetryableMediaFailure(info)

  if (info.stage === 'process') {
    if (info.reason === 'too_large') {
      // ImageTooLargeError's message is already human ("Image is 24.3MB — the limit is 20MB").
      return { label: 'Image is too large', hint: info.detail, retryable }
    }
    if (file && isHeicFile(file.name, file.type)) {
      return {
        label: 'Couldn’t prepare the image',
        hint: 'This image format isn’t supported by your browser. Try a JPEG or PNG.',
        retryable,
      }
    }
    return { label: 'Couldn’t prepare the image', hint: 'This file couldn’t be read as an image.', retryable }
  }

  if (info.stage === 'upload') {
    if (info.reason === 'too_large') return { label: 'Image is too large to upload', hint: info.detail, retryable }
    if (info.reason === 'rejected') {
      return { label: 'Couldn’t upload the image', hint: 'No image host accepted it.', retryable }
    }
    return { label: 'Couldn’t upload the image', hint: 'The image host couldn’t be reached.', retryable }
  }

  // 'send'. Deliberately says NOTHING about the blob already sitting on the host: nobody can decrypt
  // it (the key never left this device) and it will be evicted in time, so mentioning it would raise
  // an alarm about something harmless. See the orphan note at the top of this file.
  return { label: 'Couldn’t send the image', hint: null, retryable }
}

// The blob-cache keys for a set of messages — the harvest the delete paths need.
//
// Collected from the doomed rows BEFORE they are removed, exactly as deleteConversation already
// harvests payment utxoIds for removeResolvedAmounts. Keyed on `x` (the verified ciphertext hash),
// never `ox` — see the note on MediaRef.
export function mediaBlobKeys(messages: CaravelMessage[]): string[] {
  return messages.map(m => m.media?.x).filter((k): k is string => !!k)
}
