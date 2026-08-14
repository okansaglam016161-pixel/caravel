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
//   ["caravel-group-reinvite","v1"]           rides ALONGSIDE the def marker (Phase C): this def is a
//     deliberate RE-INVITE, not the original invite. Only a marked def may lift a locally 'left'
//     group; an unmarked def keeps today's first-def-wins behaviour exactly. That asymmetry is the
//     point — every def sent before this tag existed is unmarked, so upgrading a client can never
//     spuriously resurrect a left group from a stale backfill replay of its ORIGINAL def.
//     Old clients ignore the tag and read the def normally (first-def-wins drops it if they have
//     the group), so mixed-version behaviour degrades to current behaviour, never worse.
const GROUP_REINVITE_TAG = 'caravel-group-reinvite'
const GROUP_REINVITE_VERSION = 'v1'

// Caravel message-identity + edit tags (M2) — same seal-protected, versioned pattern.
//   ["caravel-msgid","v1","<32-hex>"]   the message's stable LOGICAL id, generated once per logical
//     message at send time and copied onto every wrap of it. `id` cannot serve this purpose: a group
//     send fans out N wraps with N distinct event ids and keeps a synthetic local id, so sender and
//     recipients would never agree on a name. This is the handle an edit points at.
//   ["caravel-edit","v1","<target-logical-id>","<revision>"]   this rumor REPLACES the text of the
//     message with that logical id. The new text is the rumor CONTENT, not a tag field, so a client
//     that doesn't know the tag shows the corrected text as an ordinary message rather than nothing.
//     `revision` is a positive integer, strictly increasing per message — event time cannot order
//     edits because gift wraps fuzz created_at by up to 2 days (see CaravelMessage.timestamp).
//     The editor's identity is NOT in the payload: it is seal.pubkey, authenticated by the NIP-17
//     invariant enforced in unwrapMessage, and the receiver checks it against the original sender.
const MSGID_TAG = 'caravel-msgid'
const MSGID_VERSION = 'v1'
const EDIT_TAG = 'caravel-edit'
const EDIT_VERSION = 'v1'

// Upper bound on an id arriving from an untrusted peer. We mint 32 hex chars; the slack leaves room
// for a future format without letting a peer push an unbounded string into localStorage.
const MAX_LOGICAL_ID_LEN = 64

// A fresh logical message id: 16 random bytes as hex. Generated ONCE per logical message — for a
// group fan-out (M4) the same value goes on all N wraps, which is the whole point of the field.
export function newLogicalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

// Pulls the logical message id out of a rumor's tags (same version discipline as its siblings,
// plus a length bound since this value is attacker-controlled).
function extractMsgId(tags: string[][] | undefined): string | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag[0] !== MSGID_TAG) continue
    if (tag[1] !== MSGID_VERSION) return undefined
    const id = tag[2]
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_LOGICAL_ID_LEN) return undefined
    return id
  }
  return undefined
}

// Pulls an edit instruction out of a rumor's tags. Everything is validated: an unknown version, a
// missing/oversized target, or a revision that isn't a positive integer all degrade to undefined,
// which routes the rumor down the ORDINARY message path (it shows as a plain message) rather than
// being half-applied. Deliberately strict on the revision string — a lenient Number() would accept
// " 1 ", "1e3" and "0x2", and revision is the field that decides which edit wins.
function extractEdit(tags: string[][] | undefined): { targetLogicalId: string; revision: number } | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag[0] !== EDIT_TAG) continue
    if (tag[1] !== EDIT_VERSION) return undefined
    const targetLogicalId = tag[2]
    const rawRevision = tag[3]
    if (typeof targetLogicalId !== 'string' || targetLogicalId.length === 0 || targetLogicalId.length > MAX_LOGICAL_ID_LEN) return undefined
    if (typeof rawRevision !== 'string' || !/^[1-9][0-9]*$/.test(rawRevision)) return undefined
    const revision = Number(rawRevision)
    if (!Number.isSafeInteger(revision)) return undefined
    return { targetLogicalId, revision }
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
// `logicalId` (M2) is the 7th positional parameter. Deliberately positional rather than folding all
// seven into an options object: that refactor would touch every call site for no functional gain,
// so it is left as separate cleanup. Pass it for real messages (DM + group) and OMIT it for the
// silent address control message, which creates no row and therefore has nothing to edit.
export function wrapMessage(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  plaintext: string,
  payment?: PaymentRef,
  tariAddress?: string,
  groupId?: string,
  logicalId?: string
): NostrEvent {
  const tags: string[][] = [['p', recipientPubkeyHex]]
  if (payment) tags.push([PAYMENT_TAG, PAYMENT_TAG_VERSION, payment.utxoId])
  if (tariAddress) tags.push([ADDRESS_TAG, ADDRESS_TAG_VERSION, tariAddress])
  if (groupId) tags.push([GROUP_TAG, GROUP_TAG_VERSION, groupId])
  if (logicalId) tags.push([MSGID_TAG, MSGID_VERSION, logicalId])
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

// Wraps an EDIT for one recipient (M2): the target's logical id + the new revision number in the
// tag, the NEW TEXT as the content. Modelled on wrapGroupLeave — a dedicated control-message
// builder — and like it, nothing about the editor's identity rides in the payload: the receiver
// takes it from seal.pubkey, which unwrapMessage authenticates.
//
// Putting the text in `content` is what makes this degrade sanely: a NIP-17 client that doesn't
// know the tag renders the corrected text as an ordinary message instead of dropping it.
export function wrapEdit(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  targetLogicalId: string,
  newText: string,
  revision: number
): NostrEvent {
  const tags: string[][] = [
    ['p', recipientPubkeyHex],
    [EDIT_TAG, EDIT_VERSION, targetLogicalId, String(revision)],
  ]
  const rumor = {
    kind: KIND_PRIVATE_DM,
    created_at: Math.round(Date.now() / 1000),
    content: newText,
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
): { senderPubkeyHex: string; plaintext: string; payment?: PaymentRef; tariAddress?: string; groupId?: string; groupDef?: GroupDef; groupLeave?: boolean; groupReinvite?: boolean; logicalId?: string; edit?: { targetLogicalId: string; revision: number } } {
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
    logicalId: extractMsgId(rumor.tags),
    edit: extractEdit(rumor.tags),
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
