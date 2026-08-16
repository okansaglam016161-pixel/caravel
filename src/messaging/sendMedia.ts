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

import { processImage } from '../crypto/imageProcess'
import { encryptMedia } from '../crypto/mediaCrypto'
import { uploadEncryptedBlob } from '../crypto/blossomClient'
import type { CaravelMessage, GroupSendResult, MediaRef, MessagingProvider } from './types'

// NIP-44 requires at least one byte of content, so a captionless image sends a single space — the
// same floor wrapGroupLeave and the address control message already use.
const EMPTY_CAPTION = ' '

// Why a send failed, for a UI that has to say something useful. Distinguishes the stages because
// they need different words: "that image is too big" is the user's problem to fix, whereas "no host
// accepted it" is ours.
export type MediaSendError =
  | { stage: 'process'; detail: string }   // too large, unreadable, or not an image
  | { stage: 'upload'; detail: string }    // no host took the ciphertext, or the network is down
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
async function prepare(file: Blob): Promise<{ media: MediaRef; plaintextBytes: ArrayBuffer }> {
  let processed
  try {
    processed = await processImage(file)
  } catch (e) {
    throw new MediaSendFailure({ stage: 'process', detail: e instanceof Error ? e.message : String(e) })
  }

  // Encrypt BEFORE upload, always: the host must never see anything but ciphertext.
  const enc = await encryptMedia(processed.bytes)

  const upload = await uploadEncryptedBlob(enc.ciphertext, enc.x)
  if (upload.status !== 'ok') {
    const detail = upload.status === 'too_large'
      ? `encrypted image is ${upload.bytes} bytes`
      : upload.detail
    throw new MediaSendFailure({ stage: 'upload', detail })
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
): Promise<{ message: CaravelMessage; plaintextBytes: ArrayBuffer }> {
  const { media, plaintextBytes } = await prepare(file)
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
): Promise<{ result: GroupSendResult; plaintextBytes: ArrayBuffer }> {
  const { media, plaintextBytes } = await prepare(file)
  try {
    const result = await provider.sendGroupMessage(groupId, memberPubkeysHex, caption?.trim() || EMPTY_CAPTION, media)
    return { result, plaintextBytes }
  } catch (e) {
    throw new MediaSendFailure({ stage: 'send', detail: e instanceof Error ? e.message : String(e) })
  }
}

// The blob-cache keys for a set of messages — the harvest the delete paths need.
//
// Collected from the doomed rows BEFORE they are removed, exactly as deleteConversation already
// harvests payment utxoIds for removeResolvedAmounts. Keyed on `x` (the verified ciphertext hash),
// never `ox` — see the note on MediaRef.
export function mediaBlobKeys(messages: CaravelMessage[]): string[] {
  return messages.map(m => m.media?.x).filter((k): k is string => !!k)
}
