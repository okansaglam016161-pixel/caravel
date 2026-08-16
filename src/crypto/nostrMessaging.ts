import type { NostrEvent } from 'nostr-tools'
import { wrapEvent } from 'nostr-tools/nip59'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { Relay } from 'nostr-tools/relay'
import type { PaymentRef, GroupDef, MediaRef } from '../messaging/types'

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
//   ["caravel-group-reinvite","v1"]           rides ALONGSIDE the def marker (Phase C): this def is a
//     deliberate RE-INVITE, not the original invite. Only a marked def may lift a locally 'left'
//     group; an unmarked def keeps today's first-def-wins behaviour exactly. That asymmetry is the
//     point — every def sent before this tag existed is unmarked, so upgrading a client can never
//     spuriously resurrect a left group from a stale backfill replay of its ORIGINAL def.
//     Old clients ignore the tag and read the def normally (first-def-wins drops it if they have
//     the group), so mixed-version behaviour degrades to current behaviour, never worse.
const GROUP_REINVITE_TAG = 'caravel-group-reinvite'
const GROUP_REINVITE_VERSION = 'v1'

// Caravel encrypted-image tag (images M3) — same seal-protected, versioned pattern as its siblings.
//   ["caravel-media","v1","<MediaRef as JSON>"]
//
// THE PAYLOAD IS JSON IN THE TAG VALUE, not spread across positional tag elements and not placed in
// the rumor content. Both alternatives were worse:
//   - positional (["caravel-media","v1",url,key,nonce,mime,x,ox,w,h,size]) is an eleven-element tag
//     nobody can read, where adding a field later (blurhash) is a breaking index change;
//   - JSON in `content` is how caravel-group-def carries its payload, but a group def is a CONTROL
//     message with nothing to say. A media message is an ORDINARY message that also has an image, so
//     `content` belongs to the CAPTION. Putting the ref there would evict the caption.
// Keeping the ref as one self-describing JSON value preserves the [NAME, VERSION, value] shape every
// other Caravel tag uses, and makes future fields additive with no version bump.
//
// The whole thing rides inside the seal, so the decryption key is invisible to relays AND to the blob
// host — the host holds ciphertext it can never read, which is what makes third-party hosting
// compatible with end-to-end encryption.
const MEDIA_TAG = 'caravel-media'
const MEDIA_VERSION = 'v1'

// Upper bound on the media JSON from an untrusted peer. A real ref is ~400 bytes (url ~90, key 44,
// nonce 16, x/ox 128, the rest small); 4KB leaves generous room for future fields while stopping a
// peer from pushing an unbounded string into localStorage. Same reasoning as the length bounds on
// the other attacker-controlled tag values.
const MAX_MEDIA_JSON_LEN = 4096

// Pulls the encrypted-image reference out of a rumor's tags (images M3).
//
// Every field is validated. An unknown version, malformed JSON, a missing or blank required field, a
// non-finite dimension or an oversized value ALL degrade to undefined — which routes the rumor down
// the ordinary message path, so it renders as a plain (captioned) message rather than as a
// half-populated ref the resolver would then fail on. Same discipline as extractPaymentRef: a reader
// that doesn't fully understand a tag must ignore it, never guess at it.
function extractMedia(tags: string[][] | undefined): MediaRef | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag[0] !== MEDIA_TAG) continue
    if (tag[1] !== MEDIA_VERSION) return undefined
    const raw = tag[2]
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MEDIA_JSON_LEN) return undefined
    try {
      const parsed = JSON.parse(raw) as Partial<Record<keyof MediaRef, unknown>>
      const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

      const url = str(parsed.url)
      const key = str(parsed.key)
      const nonce = str(parsed.nonce)
      const x = str(parsed.x)
      const ox = str(parsed.ox)
      const mime = str(parsed.mime)
      const width = num(parsed.width)
      const height = num(parsed.height)
      const size = num(parsed.size)
      // url/key/nonce/x are load-bearing: without any one of them the image cannot be fetched,
      // decrypted or verified, so a ref missing one is not a degraded ref — it is not a ref.
      if (!url || !key || !nonce || !x) return undefined
      return {
        url, key, nonce, x,
        ox: ox ?? '',
        mime: mime ?? 'application/octet-stream',
        width: width ?? 0,
        height: height ?? 0,
        size: size ?? 0,
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

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

// True when the rumor's def carries the RE-INVITE marker (Phase C). Same version discipline as its
// siblings: an unknown version degrades to "not a re-invite", i.e. an ordinary def.
function extractGroupReinvite(tags: string[][] | undefined): boolean {
  if (!tags) return false
  for (const tag of tags) {
    if (tag[0] !== GROUP_REINVITE_TAG) continue
    return tag[1] === GROUP_REINVITE_VERSION
  }
  return false
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
//
// `media` (images M3) is the 6th positional parameter. Positional rather than folding all six into
// an options object: that refactor would touch every call site for no functional gain, so it is left
// as separate cleanup. When present, `plaintext` is the image's CAPTION and may be a single space —
// the same one-byte floor wrapGroupLeave and the address control message use, since NIP-44 requires
// at least one byte of content.
export function wrapMessage(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  plaintext: string,
  payment?: PaymentRef,
  tariAddress?: string,
  groupId?: string,
  media?: MediaRef
): NostrEvent {
  const tags: string[][] = [['p', recipientPubkeyHex]]
  if (payment) tags.push([PAYMENT_TAG, PAYMENT_TAG_VERSION, payment.utxoId])
  if (tariAddress) tags.push([ADDRESS_TAG, ADDRESS_TAG_VERSION, tariAddress])
  if (groupId) tags.push([GROUP_TAG, GROUP_TAG_VERSION, groupId])
  if (media) tags.push([MEDIA_TAG, MEDIA_VERSION, JSON.stringify(media)])
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
// `reinvite` (Phase C) adds the re-invite marker: same def payload, but flagged as a deliberate
// re-send so a recipient who has LEFT this group may lift that state. Defaults false — the original
// invite and every pre-Phase-C def are unmarked.
export function wrapGroupDefinition(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  def: GroupDef,
  reinvite = false
): NostrEvent {
  const tags: string[][] = [
    ['p', recipientPubkeyHex],
    [GROUP_TAG, GROUP_TAG_VERSION, def.id],
    [GROUP_DEF_TAG, GROUP_DEF_VERSION],
  ]
  if (reinvite) tags.push([GROUP_REINVITE_TAG, GROUP_REINVITE_VERSION])
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
): { senderPubkeyHex: string; plaintext: string; payment?: PaymentRef; tariAddress?: string; groupId?: string; groupDef?: GroupDef; groupLeave?: boolean; groupReinvite?: boolean; media?: MediaRef } {
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
    groupReinvite: extractGroupReinvite(rumor.tags),
    media: extractMedia(rumor.tags),
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

// Publishes a gift wrap to each relay in parallel. Each relay gets its own connection with an
// explicit connect timeout and publish timeout. Connections are closed in finally.
//
// `connectTimeoutMs` is passed in rather than derived from `timeoutMs` by a ratio. It used to be
// `timeoutMs * 0.45` — 4.5s — while the subscription's own connect budget was a named 10s constant,
// so a slow link could connect the SUBSCRIPTION while every SEND timed out: relays showing healthy,
// nothing sendable. Callers now pass the same constant the subscription uses, so the two budgets
// cannot drift apart again.
//
// RESOLVES ON FIRST ACCEPT: publishing is satisfied by any one relay accepting, so we return as soon
// as one does and let the remaining attempts settle in the background (each still closes its own
// socket in its own finally — nothing leaks, and no attempt ever rejects). Without this, widening
// the connect budget would make a send wait out a DEAD relay even after a live one had accepted.
// Consequence: on success the returned array may be PARTIAL. That is safe for every current caller
// — four only ask `some(r => r.ok)`, and sendMessage reads the full array only to build its
// all-relays-failed error detail, a path where nothing accepted and we therefore waited for all.
export async function publishGiftWrap(
  giftWrap: NostrEvent,
  relayUrls: string[],
  timeoutMs: number,
  connectTimeoutMs: number
): Promise<PublishResult[]> {
  const publishTimeout = Math.floor(timeoutMs * 0.9)

  const attempts = relayUrls.map(async (url): Promise<PublishResult> => {
    const relay = new Relay(url)
    relay.publishTimeout = publishTimeout
    try {
      await relay.connect({ timeout: connectTimeoutMs })
      await relay.publish(giftWrap)
      return { relay: url, ok: true }
    } catch (e) {
      return { relay: url, ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      relay.close()
    }
  })

  if (attempts.length === 0) return []

  return new Promise<PublishResult[]>(resolve => {
    const results: PublishResult[] = []
    let settled = 0
    let done = false
    for (const attempt of attempts) {
      // Attempts never reject (the catch above turns every failure into a result), so a plain .then
      // is sufficient and cannot leave an unhandled rejection behind after we resolve.
      void attempt.then(result => {
        results.push(result)
        settled++
        if (done) return
        if (result.ok) { done = true; resolve([...results]) }            // first accept wins
        else if (settled === attempts.length) { done = true; resolve(results) }  // all failed — full detail
      })
    }
  })
}
