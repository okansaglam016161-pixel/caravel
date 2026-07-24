import type { NostrEvent } from 'nostr-tools'
import { wrapEvent } from 'nostr-tools/nip17'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { Relay } from 'nostr-tools/relay'

// NIP-17 gift-wrap: https://github.com/nostr-protocol/nips/blob/master/17.md
// Wraps a plaintext message in three layers: rumor (kind 14) → seal (kind 13, NIP-44) →
// gift wrap (kind 1059, NIP-44 with a fresh random key per wrap).

export function wrapMessage(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  plaintext: string
): NostrEvent {
  return wrapEvent(senderSecretKey, { publicKey: recipientPubkeyHex }, plaintext)
}

// Returns the plaintext and the sender's public key (hex), or throws on decryption failure.
// Performs a manual two-layer decrypt (rather than nip59.unwrapEvent) so we can access the
// intermediate seal and enforce the NIP-17 pubkey consistency check below.
export function unwrapMessage(
  recipientSecretKey: Uint8Array,
  giftWrapEvent: NostrEvent
): { senderPubkeyHex: string; plaintext: string } {
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
  }

  // NIP-17 security invariant: seal.pubkey MUST equal rumor.pubkey.
  // Without this check, an attacker can swap the rumor pubkey to impersonate any sender
  // while still producing a valid seal decryption. The spec is explicit: MUST verify.
  if (seal.pubkey !== rumor.pubkey) {
    throw new Error(
      `NIP-17: seal pubkey (${seal.pubkey}) does not match rumor pubkey (${rumor.pubkey}) — possible impersonation`
    )
  }

  return { senderPubkeyHex: seal.pubkey, plaintext: rumor.content }
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
