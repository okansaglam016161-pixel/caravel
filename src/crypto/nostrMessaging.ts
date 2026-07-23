import type { NostrEvent } from 'nostr-tools'
import { wrapEvent } from 'nostr-tools/nip17'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'

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
