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

export interface PublishResult {
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

export interface ReceivedGiftWrap {
  event: NostrEvent
  relay: string
}

// Subscribes to all relays in parallel and returns the first matching kind-1059 event
// p-tagged to recipientPubkeyHex. Returns null if timeoutMs elapses first.
//
// IMPORTANT: gift wraps use randomNow() which backdates created_at by up to 2 days.
// Pass since = Math.floor(Date.now() / 1000) - 172800 to cover the full window.
// All subscriptions and connections are closed on first event or timeout — no leaks.
export async function waitForGiftWrap(
  recipientPubkeyHex: string,
  relayUrls: string[],
  timeoutMs: number,
  since: number
): Promise<ReceivedGiftWrap | null> {
  return new Promise((resolve) => {
    const relays: Relay[] = []
    let done = false

    function closeAll() {
      for (const r of relays) {
        try { r.close() } catch { /* ignore */ }
      }
    }

    const timeoutHandle = setTimeout(() => {
      if (!done) {
        done = true
        closeAll()
        resolve(null)
      }
    }, timeoutMs)

    function onEvent(relayUrl: string) {
      return (event: NostrEvent) => {
        if (!done) {
          done = true
          clearTimeout(timeoutHandle)
          closeAll()
          resolve({ event, relay: relayUrl })
        }
      }
    }

    const filter = { kinds: [1059], '#p': [recipientPubkeyHex], since }

    for (const url of relayUrls) {
      const relay = new Relay(url)
      relays.push(relay)

      relay.connect({ timeout: Math.min(10_000, timeoutMs) })
        .then(() => {
          if (done) { try { relay.close() } catch { /* ignore */ } ; return }
          relay.subscribe([filter], { onevent: onEvent(url), oneose: () => {} })
        })
        .catch(() => { /* connection failed — other relay may succeed */ })
    }
  })
}
