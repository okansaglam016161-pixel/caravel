import type { NostrEvent } from 'nostr-tools'
import { wrapEvent } from 'nostr-tools/nip59'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { Relay } from 'nostr-tools/relay'
import type { PaymentRef, GroupDef } from '../messaging/types'

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

// Caravel Tari-address tag (M9.0d) — same seal-protected, versioned pattern as the payment tag.
// Wire format: ["caravel-tari-address", "v1", "<otl_esm_...>"]. Carries a contact's Tari address,
// authenticated by the seal.pubkey === rumor.pubkey check so it is bound to the sender's identity.
const ADDRESS_TAG = 'caravel-tari-address'
const ADDRESS_TAG_VERSION = 'v1'

// Caravel group tags (Phase 1) — same seal-protected, versioned pattern as the tags above.
//   ["caravel-group","v1","<group-id>"]        marks a rumor as belonging to a group (id).
//   ["caravel-group-def","v1"]                 marks a rumor as a group DEFINITION control message;
//     its content is JSON { name, members: [hex…] }. A non-Caravel client shows the JSON as text.
//   ["caravel-group-leave","v1"]               marks a rumor as a LEAVE notice (B-M2): the sender has
//     left the tagged group. Carries NO payload — the leaver's identity is seal.pubkey, authenticated
//     by the NIP-17 invariant below, so it can't be self-declared/spoofed in the content.
const GROUP_TAG = 'caravel-group'
const GROUP_TAG_VERSION = 'v1'
const GROUP_DEF_TAG = 'caravel-group-def'
const GROUP_DEF_VERSION = 'v1'
const GROUP_LEAVE_TAG = 'caravel-group-leave'
const GROUP_LEAVE_VERSION = 'v1'

// Pulls the group id out of a rumor's tags (version-checked, like extractPaymentRef).
function extractGroupId(tags: string[][] | undefined): string | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag[0] !== GROUP_TAG) continue
    if (tag[1] !== GROUP_TAG_VERSION) return undefined  // unknown version → treat as non-group
    const id = tag[2]
    if (typeof id !== 'string' || id.length === 0) return undefined
    return id
  }
  return undefined
}

// If the rumor is a group DEFINITION (has the def marker), parse content JSON → GroupDef, combining
// the group id from the group tag with the { name, members } payload. Returns undefined otherwise or
// on any malformed field, so a bad def degrades to "not a def" rather than being misread.
function extractGroupDef(tags: string[][] | undefined, content: string): GroupDef | undefined {
  if (!tags) return undefined
  const isDef = tags.some(t => t[0] === GROUP_DEF_TAG && t[1] === GROUP_DEF_VERSION)
  if (!isDef) return undefined
  const id = extractGroupId(tags)
  if (!id) return undefined
  try {
    const parsed = JSON.parse(content) as { name?: unknown; members?: unknown }
    const name = typeof parsed.name === 'string' ? parsed.name : ''
    const members = Array.isArray(parsed.members)
      ? parsed.members.filter((m): m is string => typeof m === 'string' && m.length > 0)
      : []
    if (members.length === 0) return undefined
    return { id, name, members }
  } catch {
    return undefined
  }
}

// True when the rumor is a group LEAVE notice (B-M2). Same version discipline as the extractors
// above: an unknown version degrades to "not a leave", which routes the rumor down the ordinary
// message path rather than being misread.
function extractGroupLeave(tags: string[][] | undefined): boolean {
  if (!tags) return false
  for (const tag of tags) {
    if (tag[0] !== GROUP_LEAVE_TAG) continue
    return tag[1] === GROUP_LEAVE_VERSION
  }
  return false
}

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

// Pulls a Tari address out of the rumor's tags (same version discipline as extractPaymentRef).
function extractTariAddress(tags: string[][] | undefined): string | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag[0] !== ADDRESS_TAG) continue
    if (tag[1] !== ADDRESS_TAG_VERSION) return undefined  // unknown version → ignore
    const addr = tag[2]
    if (typeof addr !== 'string' || addr.length === 0) return undefined
    return addr
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
  payment?: PaymentRef,
  tariAddress?: string,
  groupId?: string
): NostrEvent {
  const tags: string[][] = [['p', recipientPubkeyHex]]
  if (payment) tags.push([PAYMENT_TAG, PAYMENT_TAG_VERSION, payment.utxoId])
  if (tariAddress) tags.push([ADDRESS_TAG, ADDRESS_TAG_VERSION, tariAddress])
  if (groupId) tags.push([GROUP_TAG, GROUP_TAG_VERSION, groupId])
  const rumor = {
    kind: KIND_PRIVATE_DM,
    created_at: Math.round(Date.now() / 1000),
    content: plaintext,
    tags,
  }
  return wrapEvent(rumor, senderSecretKey, recipientPubkeyHex)
}

// Wraps a group-DEFINITION control message for one recipient: content is JSON { name, members },
// tagged with the group id and the def marker. Fan out one of these per member (minus self) so
// their clients learn the group. Reuses the same seal/gift-wrap crypto as wrapMessage.
export function wrapGroupDefinition(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  def: GroupDef
): NostrEvent {
  const tags: string[][] = [
    ['p', recipientPubkeyHex],
    [GROUP_TAG, GROUP_TAG_VERSION, def.id],
    [GROUP_DEF_TAG, GROUP_DEF_VERSION],
  ]
  const rumor = {
    kind: KIND_PRIVATE_DM,
    created_at: Math.round(Date.now() / 1000),
    content: JSON.stringify({ name: def.name, members: def.members }),
    tags,
  }
  return wrapEvent(rumor, senderSecretKey, recipientPubkeyHex)
}

// Wraps a group LEAVE notice for one recipient (B-M2): the group id plus the leave marker, over a
// single-space content (NIP-44 requires >= 1 byte, so it can't be truly empty — same floor as the
// silent address control message). Fan one out per member (minus self) when leaving a group. The
// leaver is identified by the seal pubkey on unwrap, so nothing about identity rides in the payload.
export function wrapGroupLeave(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  groupId: string
): NostrEvent {
  const tags: string[][] = [
    ['p', recipientPubkeyHex],
    [GROUP_TAG, GROUP_TAG_VERSION, groupId],
    [GROUP_LEAVE_TAG, GROUP_LEAVE_VERSION],
  ]
  const rumor = {
    kind: KIND_PRIVATE_DM,
    created_at: Math.round(Date.now() / 1000),
    content: ' ',
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
): { senderPubkeyHex: string; plaintext: string; payment?: PaymentRef; tariAddress?: string; groupId?: string; groupDef?: GroupDef; groupLeave?: boolean } {
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

  return {
    senderPubkeyHex: seal.pubkey,
    plaintext: rumor.content,
    payment: extractPaymentRef(rumor.tags),
    tariAddress: extractTariAddress(rumor.tags),
    groupId: extractGroupId(rumor.tags),
    groupDef: extractGroupDef(rumor.tags, rumor.content),
    groupLeave: extractGroupLeave(rumor.tags),
  }
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
