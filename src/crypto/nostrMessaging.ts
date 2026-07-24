import type { NostrEvent } from 'nostr-tools'
import { wrapEvent } from 'nostr-tools/nip59'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { Relay } from 'nostr-tools/relay'
import type { PaymentRef } from '../messaging/types'

// NIP-17 gift-wrap: https://github.com/nostr-protocol/nips/blob/master/17.md
// Wraps a plaintext message in three layers: rumor (kind 14) → seal (kind 13, NIP-44) →
// gift wrap (kind 1059, NIP-44 with a fresh random key per wrap).

// Kind 14 = NIP-17 private direct message (the rumor).
const KIND_PRIVATE_DM = 14

// Caravel payment reference tag (M10.0). Lives on the rumor — inside the encrypted seal — so it
// is invisible to relays and ignored by non-Caravel clients (which show the note as a plain
// message). Wire format: ["caravel-payment", "v1", "<utxo-substate-id>"]. Versioned so the tag
// can be published as a spec; a reader that doesn't recognise the version degrades to plain text.
const PAYMENT_TAG = 'caravel-payment'
const PAYMENT_TAG_VERSION = 'v1'

// Pulls a payment reference out of the rumor's tags, or undefined if none/unrecognised.
// A v1 reader MUST verify the version token and ignore unknown versions, so an unknown-version
// payment degrades to a plain message rather than being misread at a fixed index.
function extractPaymentRef(tags: string[][] | undefined): PaymentRef | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag[0] !== PAYMENT_TAG) continue
    if (tag[1] !== PAYMENT_TAG_VERSION) return undefined  // unknown version → degrade to plain
    const utxoId = tag[2]
    if (typeof utxoId !== 'string' || utxoId.length === 0) return undefined
    return { utxoId }
  }
  return undefined
}

// Wraps plaintext (and an optional payment reference) for the recipient. Builds the kind-14
// rumor ourselves — including the required ["p", recipient] tag and, when present, the
// caravel-payment tag — then hands it to nip59.wrapEvent, which seals and gift-wraps it with
// the library's own crypto. A message with no payment produces a rumor identical to before.
export function wrapMessage(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  plaintext: string,
  payment?: PaymentRef
): NostrEvent {
  const tags: string[][] = [['p', recipientPubkeyHex]]
  if (payment) tags.push([PAYMENT_TAG, PAYMENT_TAG_VERSION, payment.utxoId])
  const rumor = {
    kind: KIND_PRIVATE_DM,
    created_at: Math.round(Date.now() / 1000),
    content: plaintext,
    tags,
  }
  return wrapEvent(rumor, senderSecretKey, recipientPubkeyHex)
}

// Returns the plaintext, the sender's public key (hex), and any payment reference — or throws on
// decryption failure. Performs a manual two-layer decrypt (rather than nip59.unwrapEvent) so we
// can access the intermediate seal and enforce the NIP-17 pubkey consistency check below.
export function unwrapMessage(
  recipientSecretKey: Uint8Array,
  giftWrapEvent: NostrEvent
): { senderPubkeyHex: string; plaintext: string; payment?: PaymentRef } {
  // Layer 1: decrypt gift wrap (kind 1059) → seal (kind 13)
  const sealKey = getConversationKey(recipientSecretKey, giftWrapEvent.pubkey)
  const seal = JSON.parse(decrypt(giftWrapEvent.content, sealKey)) as {
    pubkey: string
    content: string
  }

  // Layer 2: decrypt seal (kind 13) → rumor (kind 14)
  const rumorKey = getConversationKey(recipientSecretKey, seal.pubkey)
  const rumor = JSON.parse(decrypt(seal.content, rumorKey)) as {
    pubkey: string
    content: string
    tags?: string[][]
  }

  // NIP-17 security invariant: seal.pubkey MUST equal rumor.pubkey.
  // Without this check, an attacker can swap the rumor pubkey to impersonate any sender
  // while still producing a valid seal decryption. The spec is explicit: MUST verify.
  if (seal.pubkey !== rumor.pubkey) {
    throw new Error(
      `NIP-17: seal pubkey (${seal.pubkey}) does not match rumor pubkey (${rumor.pubkey}) — possible impersonation`
    )
  }

  return { senderPubkeyHex: seal.pubkey, plaintext: rumor.content, payment: extractPaymentRef(rumor.tags) }
}

// ── Network helpers ────────────────────────────────────────────────────────────
// These are kept separate from the pure crypto functions above.
// They create their own WebSocket connections and clean them up on completion.

// Internal to publishGiftWrap's signature — not exported (nothing outside consumes it).
interface PublishResult {
  relay: string
  ok: boolean
  error?: string
}

// Publishes a gift wrap to each relay in parallel. Each relay gets its own connection
// with an explicit connect timeout and publish timeout. Connections are closed in finally.
export async function publishGiftWrap(
  giftWrap: NostrEvent,
  relayUrls: string[],
  timeoutMs: number
): Promise<PublishResult[]> {
  const connectTimeout = Math.min(10_000, Math.floor(timeoutMs * 0.45))
  const publishTimeout = Math.floor(timeoutMs * 0.9)

  return Promise.all(
    relayUrls.map(async (url): Promise<PublishResult> => {
      const relay = new Relay(url)
      relay.publishTimeout = publishTimeout
      try {
        await relay.connect({ timeout: connectTimeout })
        await relay.publish(giftWrap)
        return { relay: url, ok: true }
      } catch (e) {
        return { relay: url, ok: false, error: e instanceof Error ? e.message : String(e) }
      } finally {
        relay.close()
      }
    })
  )
}
