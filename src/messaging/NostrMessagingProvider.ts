import type { NostrEvent, Filter } from 'nostr-tools'
import { Relay, type Subscription } from 'nostr-tools/relay'
import { wrapMessage, wrapGroupDefinition, wrapGroupLeave, wrapEdit, wrapReaction, unwrapMessage, publishGiftWrap, newLogicalId } from '../crypto/nostrMessaging'
import type { CaravelMessage, GroupDef, GroupSendResult, MessagingConnectionStatus, MessagingProvider, RelayState, SendGroupMessageOptions, SendMessageOptions } from './types'

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2)
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return arr
}

// Connect budget. Used by BOTH the subscription (connectRelay) and every publish — publishes used
// to derive their own 4.5s from a ratio inside publishGiftWrap, which is how a slow link ended up
// able to subscribe but not send. One constant, one behaviour.
const CONNECT_TIMEOUT_MS = 10_000
const PUBLISH_TIMEOUT_MS = 10_000
// Bounded retry for FIRE-AND-FORGET control messages only (leave notice, group definition,
// re-invite). Nothing awaits these and they have no user-facing retry affordance, so a single slow
// handshake would drop them silently — the leave notice being the case we actually lost. Deliberately
// NOT applied to sendMessage/sendGroupMessage: a human is watching those, they already surface an
// error with a Retry control, and an invisible retry would double the worst-case wait.
const CONTROL_RETRIES = 1
const CONTROL_RETRY_BACKOFF_MS = 2_000
// Gift wraps use randomNow() which backdates created_at by up to 2 days (172800s).
// Using `since = now` silently misses all of them — always cover the full window.
const SINCE_WINDOW_S = 172800

const MAX_RETRIES = 5
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000

// Heartbeat: TCP has no default keepalive, so a WebSocket whose underlying network died
// (wifi off) never fires onclose — it just goes silent. We probe each relay ourselves with
// a lightweight REQ for a nonexistent event id and expect an EOSE. No EOSE within the timeout
// means the connection is silently dead; we kill the socket to route into scheduleReconnect().
const HEARTBEAT_INTERVAL_MS = 30_000 // matches nostr-tools' own default ping cadence; polite
const HEARTBEAT_TIMEOUT_MS = 10_000  // EOSE for a limit:0 query is near-instant on a live relay
// Nonexistent 32-byte event id (all zeros). limit:0 means the relay does no work beyond EOSE.
const HEARTBEAT_PROBE_ID = '0'.repeat(64)
// navigator.onLine safety net: it can be wrongly false (router with no upstream, some
// environments) and may never emit a matching 'online' event. Rather than stall reconnection
// forever, when we believe we're offline we poll on this fixed cadence WITHOUT consuming the
// retry budget — self-healing if connectivity returns without the event firing.
const OFFLINE_POLL_MS = 15_000

// How far a sender's claimed send time may exceed the moment we received it before we stop
// believing it. A message cannot arrive before it was sent, so any future claim is wrong — but
// "future" needs a little slack for two benign reasons:
//
//   1. wrapMessage stamps Math.round(Date.now() / 1000), which rounds to the NEAREST second — so an
//      honest message sent at :00.700 claims :01.000, up to ~500ms ahead of its own send. Over a
//      fast local relay that can genuinely land before the claimed instant. A zero tolerance would
//      misfire on our own messages.
//   2. Ordinary client clock drift between two NTP-synced devices.
//
// Two minutes clears both comfortably — but generosity is NO LONGER FREE, and that is worth stating
// plainly. Threads sort on this clamped value (see sortKey), so the bound is now the only thing
// stopping a future-dated message from parking itself at the bottom of a thread and at the top of
// the conversation list. A too-loose value buys a liar that much room, in position as well as in
// label. Two minutes is small enough that the worst case is invisible; do not widen it casually.
const SEND_TIME_SKEW_MS = 2 * 60 * 1000

/**
 * Resolves the SEND TIME for a received message: the sender's claim when it is usable, our arrival
 * time when it is not. This value is both displayed and sorted on, so it decides position as well as
 * label — see sortKey.
 *
 * `sentAtMs` is sender-controlled. unwrapMessage has already rejected non-numeric, non-finite and
 * non-positive values; what remains to reject here is the one claim that is provably false — a send
 * time later than the arrival it preceded.
 *
 * Deliberately NOT clamped: times in the PAST. Any threshold for "too old" would be arbitrary, since
 * a genuinely delayed message is indistinguishable from a lie. The cost of leaving it open GREW when
 * ordering moved onto this value — a back-dated claim now sorts early, where before it only mislabelled
 * — and that is an accepted, tested trade rather than an oversight; see sortKey and sendTime.test.ts.
 */
function clampSendTime(sentAtMs: number | undefined, receivedAt: number): number {
  if (sentAtMs === undefined) return receivedAt
  return sentAtMs > receivedAt + SEND_TIME_SKEW_MS ? receivedAt : sentAtMs
}

type RelayRecordStatus = 'connecting' | 'connected' | 'failed' | 'closed'

interface RelayRecord {
  url: string
  status: RelayRecordStatus
  retries: number
  relay: Relay | null
  retryHandle: ReturnType<typeof setTimeout> | null
  heartbeatHandle: ReturnType<typeof setInterval> | null
  lastHeartbeatOk: number | null
}

export class NostrMessagingProvider implements MessagingProvider {
  private secretKey: Uint8Array
  private pubkeyHex: string
  private relayUrls: readonly string[]
  private records: RelayRecord[]
  private seen: Set<string>
  private filter: Filter | null
  private onMessageCallback: ((msg: CaravelMessage) => void) | null
  private onStatusCallback: ((status: MessagingConnectionStatus) => void) | null
  private onContactAddressCallback: ((senderPubkeyHex: string, tariAddress: string) => void) | null
  private onGroupDefinitionCallback: ((senderPubkeyHex: string, def: GroupDef, defEventId: string, reinvite: boolean) => void) | null
  private onEditCallback: ((senderPubkeyHex: string, targetLogicalId: string, newText: string, revision: number) => void) | null
  private onReactionCallback: ((senderPubkeyHex: string, targetLogicalId: string, emoji: string, action: 'add' | 'remove', seq: number) => void) | null
  private disconnecting: boolean
  // Bound window listeners — stored so removeEventListener can find them in disconnect().
  private onlineHandler: (() => void) | null
  private offlineHandler: (() => void) | null

  constructor(secretKeyHex: string, pubkeyHex: string, relays: readonly string[]) {
    this.secretKey = hexToBytes(secretKeyHex)
    this.pubkeyHex = pubkeyHex
    this.relayUrls = relays
    this.records = [...relays].map(url => ({
      url,
      status: 'connecting' as RelayRecordStatus,
      retries: 0,
      relay: null,
      retryHandle: null,
      heartbeatHandle: null,
      lastHeartbeatOk: null,
    }))
    this.seen = new Set()
    this.filter = null
    this.onMessageCallback = null
    this.onStatusCallback = null
    this.onContactAddressCallback = null
    this.onGroupDefinitionCallback = null
    this.onEditCallback = null
    this.onReactionCallback = null
    this.disconnecting = false
    this.onlineHandler = null
    this.offlineHandler = null
  }

  get isConnected(): boolean {
    return this.records.some(r => r.status === 'connected')
  }

  getRelayStates(): RelayState[] {
    return this.records.map(r => ({
      url: r.url,
      status: r.status,
      retries: r.retries,
      lastHeartbeatOk: r.lastHeartbeatOk,
    }))
  }

  subscribe(
    onMessage: (msg: CaravelMessage) => void,
    onStatusChange?: (status: MessagingConnectionStatus) => void,
    onContactAddress?: (senderPubkeyHex: string, tariAddress: string) => void,
    onGroupDefinition?: (senderPubkeyHex: string, def: GroupDef, defEventId: string, reinvite: boolean) => void,
    onEdit?: (senderPubkeyHex: string, targetLogicalId: string, newText: string, revision: number) => void,
    onReaction?: (senderPubkeyHex: string, targetLogicalId: string, emoji: string, action: 'add' | 'remove', seq: number) => void
  ): void {
    this.onMessageCallback = onMessage
    this.onStatusCallback = onStatusChange ?? null
    this.onContactAddressCallback = onContactAddress ?? null
    this.onGroupDefinitionCallback = onGroupDefinition ?? null
    this.onEditCallback = onEdit ?? null
    this.onReactionCallback = onReaction ?? null
    const since = Math.floor(Date.now() / 1000) - SINCE_WINDOW_S
    this.filter = { kinds: [1059], '#p': [this.pubkeyHex], since }

    // Fast-path network signals. These COMPLEMENT the heartbeat — 'offline' fires the instant
    // wifi drops (faster than the ~40s worst-case heartbeat detection), and 'online' triggers
    // immediate recovery. They are not sufficient alone: they only see OUR network change, not
    // a relay silently going away, which is what the heartbeat covers.
    if (typeof window !== 'undefined') {
      this.onlineHandler = () => this.handleOnline()
      this.offlineHandler = () => this.handleOffline()
      window.addEventListener('online', this.onlineHandler)
      window.addEventListener('offline', this.offlineHandler)
    }

    for (const record of this.records) {
      void this.connectRelay(record)
    }
  }

  // `media` (images M3) attaches an already-uploaded encrypted image. The provider deliberately knows
  // NOTHING about Blossom: uploading happens before this is called, in messaging/sendMedia.ts, the
  // same way submitPayment settles an on-chain transaction before sending a message that references
  // it. This just carries the reference.
  async sendMessage(recipientPubkeyHex: string, plaintext: string, opts: SendMessageOptions = {}): Promise<CaravelMessage> {
    const { payment, tariAddress, media, replyTo } = opts
    // M2: mint the logical id BEFORE wrapping and keep it on the local row, so sender and recipient
    // store the same handle for this message and an edit can name it.
    const logicalId = newLogicalId()
    const wrapped = wrapMessage(this.secretKey, recipientPubkeyHex, plaintext, { payment, tariAddress, logicalId, media, replyTo })
    const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)

    const anyOk = results.some(r => r.ok)
    if (!anyOk) {
      const detail = results.map(r => `${r.relay}: ${r.error ?? 'rejected'}`).join('; ')
      throw new Error(`NostrMessagingProvider: failed to publish to any relay — ${detail}`)
    }

    // We are the sender, so display time and arrival time are the same instant — there is nothing
    // to diverge. receivedAt is still written: compareMessages uses it as its tiebreak, and rapid
    // local sends are exactly where ties happen.
    const sentAt = Date.now()
    return {
      id: wrapped.id,
      senderPubkeyHex: this.pubkeyHex,
      recipientPubkeyHex,
      plaintext,
      timestamp: sentAt,
      receivedAt: sentAt,
      direction: 'sent',
      payment,
      logicalId,
      ...(media ? { media } : {}),
      // replies v1: same spread discipline as media — the key is absent, not undefined, on a
      // non-reply, so a stored row is byte-identical to one written before replies existed.
      ...(replyTo ? { replyTo } : {}),
    }
  }

  // Send an EDIT of an already-sent message (M2). Boolean, not a throw: acceptance by any one relay
  // is all we can observe, and the caller decides how to surface a miss. Nothing is applied locally
  // here — WalletContext.editMessage applies via the store only after this resolves true, so a
  // failed send never leaves the sender showing text the recipient will never see.
  async sendEdit(recipientPubkeyHex: string, targetLogicalId: string, newText: string, revision: number): Promise<boolean> {
    const wrapped = wrapEdit(this.secretKey, recipientPubkeyHex, targetLogicalId, newText, revision)
    const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
    return results.some(r => r.ok)
  }

  // Group EDIT (M4): sendEdit's payload over sendGroupMessage's fan-out. Every member gets the same
  // (targetLogicalId, revision) pair naming the shared logical id their copy already carries, so all
  // N clients apply the identical change via applyEditByLogicalId.
  //
  // Two contract choices, both deliberate and both DIFFERENT from sendGroupMessage:
  //
  //   1. NEVER THROWS. sendGroupMessage throws when it reaches nobody because ChatApp.sendToGroup
  //      catches it and turns it into a failed bubble with Retry. The edit path has no such catch —
  //      editMessage is `try/finally`, and saveEdit is invoked as `void saveEdit()` — so a throw
  //      would surface as an unhandled rejection instead of UI. Total failure is reported as
  //      membersReached === 0 and the caller's optimistic layer snaps the bubble back.
  //   2. Plain publishGiftWrap, NOT publishControl. An edit is a control message by wire shape but a
  //      human-watching action by UX: M3 already gives it a spinner and an explicit Retry, which is
  //      exactly the reasoning in CONTROL_RETRIES' note for excluding sends from the bounded retry.
  //
  // `groupId` is taken for symmetry with its siblings and is deliberately NOT put on the wire: an
  // edit stays group-agnostic (wrapEdit tags no group), because the RECEIVER's own stored row is the
  // authoritative statement of which group the target belongs to. That is what the left/deleted-group
  // ingest gate keys off — see targetsLeftGroup in messageStore.
  async sendGroupEdit(
    _groupId: string,
    memberPubkeysHex: string[],
    targetLogicalId: string,
    newText: string,
    revision: number
  ): Promise<{ memberCount: number; membersReached: number }> {
    const recipients = memberPubkeysHex.filter(m => m && m !== this.pubkeyHex)
    let membersReached = 0
    await Promise.all(recipients.map(async member => {
      const wrapped = wrapEdit(this.secretKey, member, targetLogicalId, newText, revision)
      const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
      if (results.some(r => r.ok)) membersReached++
    }))
    return { memberCount: recipients.length, membersReached }
  }

  // Send a REACTION on a DM (reactions v1). Boolean, exactly like sendEdit: relay acceptance is all
  // we can observe, and the caller decides how to surface a miss. Nothing is applied locally here —
  // WalletContext.reactMessage writes the store only once this resolves true, so a send that went
  // nowhere never leaves this device showing a reaction no peer will ever see.
  //
  // Note what is NOT checked here, deliberately: neither that the target is mine (it need not be)
  // nor that I am under the two-reaction allowance. The allowance is a decision about STORED state,
  // which the provider does not hold; it is enforced by the caller before this is reached and again
  // by the applier on every receiving device. The provider stays a transport.
  async sendReaction(recipientPubkeyHex: string, targetLogicalId: string, emoji: string, action: 'add' | 'remove', seq: number): Promise<boolean> {
    const wrapped = wrapReaction(this.secretKey, recipientPubkeyHex, targetLogicalId, emoji, action, seq)
    const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
    return results.some(r => r.ok)
  }

  // Group REACTION: sendReaction's payload over sendGroupEdit's fan-out, one wrap per member (minus
  // self), every one naming the shared logical id their copy already carries.
  //
  // Same two contract choices as sendGroupEdit, for the same reasons: it NEVER THROWS (the caller is
  // awaited from a UI handler with no catch, so a rejection would escape as an unhandled rejection),
  // and it uses plain publishGiftWrap rather than the bounded control retry (a human is watching).
  //
  // `groupId` is taken for symmetry and deliberately NOT put on the wire — a reaction is
  // group-agnostic, because the RECEIVER's own stored row is the authoritative statement of which
  // group the target belongs to. That is what the left-group ingest gate keys off; see
  // targetsLeftGroup in messageStore, which reactions share with edits unchanged.
  async sendGroupReaction(
    _groupId: string,
    memberPubkeysHex: string[],
    targetLogicalId: string,
    emoji: string,
    action: 'add' | 'remove',
    seq: number
  ): Promise<{ memberCount: number; membersReached: number }> {
    const recipients = memberPubkeysHex.filter(m => m && m !== this.pubkeyHex)
    let membersReached = 0
    await Promise.all(recipients.map(async member => {
      const wrapped = wrapReaction(this.secretKey, member, targetLogicalId, emoji, action, seq)
      const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
      if (results.some(r => r.ok)) membersReached++
    }))
    return { memberCount: recipients.length, membersReached }
  }

  // Send a dedicated silent Tari-address control message (M9.0d): only the address tag, over a
  // single-space content (NIP-44 requires >= 1 byte, so it can't be truly empty). It carries no
  // payment and no note; the recipient extracts + stores the address and renders nothing. Returns
  // true if at least one relay accepted, so the caller can mark the address as delivered.
  async sendContactAddress(recipientPubkeyHex: string, tariAddress: string): Promise<boolean> {
    const wrapped = wrapMessage(this.secretKey, recipientPubkeyHex, ' ', { tariAddress })
    const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
    return results.some(r => r.ok)
  }

  // Group message (Phase 1): fan out one gift wrap per member, MINUS self (we record a local 'sent'
  // instead — Caravel never self-wraps, so there is no cross-device echo; see messageStore). The
  // returned count is RELAY ACCEPTANCE, not delivery — a member accepted-for-propagation may still
  // never receive it. Throws only if no member's wrap reached any relay at all.
  //
  // `media` (images M3): ONE upload, N wraps. The blob is uploaded once before this is called and the
  // SAME reference — same url, same key, same nonce, same hash — goes to every member, so the group
  // costs one upload no matter how large the roster. (Each member does fetch it independently, so it
  // is N downloads from the host; see the durability note in config/blossom.ts.)
  async sendGroupMessage(groupId: string, memberPubkeysHex: string[], plaintext: string, opts: SendGroupMessageOptions = {}): Promise<GroupSendResult> {
    const { media, replyTo } = opts
    const recipients = memberPubkeysHex.filter(m => m && m !== this.pubkeyHex)
    // ONE logical id for the whole fan-out (M2): every member's wrap carries the same value, so all
    // N copies plus our local row name the same logical message. This is exactly what `id` cannot
    // do here — each member gets a different event id. M4's sendGroupEdit is what consumes it, and
    // because the id shipped from M2 onward that milestone needed no data migration.
    const logicalId = newLogicalId()
    let membersReached = 0
    await Promise.all(recipients.map(async member => {
      // ONE replyTo for the whole fan-out, exactly like logicalId and media: every member's wrap
      // quotes the same logical message, so all N copies resolve the quote to the same row.
      const wrapped = wrapMessage(this.secretKey, member, plaintext, { groupId, logicalId, media, replyTo })
      const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
      if (results.some(r => r.ok)) membersReached++
    }))
    if (recipients.length > 0 && membersReached === 0) {
      throw new Error('NostrMessagingProvider: group message reached no relay for any member')
    }
    // Same instant for both, as in sendMessage — we are the sender.
    const groupSentAt = Date.now()
    const message: CaravelMessage = {
      // Synthetic id — there are N gift-wrap ids; we don't self-wrap so there is nothing to dedup
      // against. Prefixed so it can never collide with a 64-hex gift-wrap event id.
      id: `grp-${crypto.randomUUID()}`,
      senderPubkeyHex: this.pubkeyHex,
      recipientPubkeyHex: '',   // no single recipient — routed by groupId
      plaintext,
      timestamp: groupSentAt,
      receivedAt: groupSentAt,
      direction: 'sent',
      groupId,
      logicalId,
      ...(media ? { media } : {}),
      ...(replyTo ? { replyTo } : {}),
    }
    return { message, memberCount: recipients.length, membersReached }
  }

  // Group definition control message: fan the { name, roster } out to members (minus self) so their
  // clients learn the group. Same relays-reached (not delivery) semantics as sendGroupMessage.
  async sendGroupDefinition(def: GroupDef): Promise<{ memberCount: number; membersReached: number }> {
    return this.fanOutDefinition(def, false)
  }

  // RE-INVITE (Phase C): the same fan-out, with the def marked as a deliberate re-send. Members who
  // still hold the group drop it via first-def-wins; only a member in 'left' lifts.
  //
  // `recipientsHex` (C-M2) narrows WHO receives it — the picker's selection. It is a SEPARATE
  // parameter from def.members ON PURPOSE and the two must never be conflated: `def` is the group's
  // identity and is serialised into the wrap, so the roster it carries has to stay the FULL roster.
  // Passing a subset as def.members would rewrite every re-invited member's roster to that subset on
  // arrival (their lift path rebuilds the record from def.members) — silent group corruption, not a
  // UI bug. Omit `recipientsHex` for the whole roster. Non-throwing, like its sibling.
  async sendGroupReinvite(def: GroupDef, recipientsHex?: string[]): Promise<{ memberCount: number; membersReached: number }> {
    return this.fanOutDefinition(def, true, recipientsHex)
  }

  private async fanOutDefinition(def: GroupDef, reinvite: boolean, recipientsHex?: string[]): Promise<{ memberCount: number; membersReached: number }> {
    // Targets default to the full roster. A caller-supplied list is intersected WITH the roster, so a
    // stale or hand-made selection can never address a non-member. Self is always filtered out.
    const roster = new Set(def.members.filter(Boolean))
    const targets = recipientsHex ? recipientsHex.filter(m => roster.has(m)) : [...roster]
    const recipients = targets.filter(m => m && m !== this.pubkeyHex)
    let membersReached = 0
    await Promise.all(recipients.map(async member => {
      // NOTE: `def` is passed through UNMODIFIED — full roster in the payload, regardless of who is
      // being sent to. Narrowing happens only in `recipients` above.
      const wrapped = wrapGroupDefinition(this.secretKey, member, def, reinvite)
      // Retried, same reasoning as the leave notice: a dropped def/re-invite surfaces much later as
      // "they never got the invite", with nothing to retry from.
      if (await this.publishControl(wrapped)) membersReached++
    }))
    return { memberCount: recipients.length, membersReached }
  }

  // Group LEAVE notice (B-M2): fan "I left" out to the roster (minus self) so members can render a
  // system line. Modelled on sendGroupDefinition, NOT on sendGroupMessage: it reports the tally but
  // NEVER throws, because the caller has already decided to leave locally and a dead relay must cost
  // only the notice. The roster is passed in because the caller's group record is about to go 'left'.
  async sendGroupLeave(groupId: string, memberPubkeysHex: string[]): Promise<{ memberCount: number; membersReached: number }> {
    const recipients = memberPubkeysHex.filter(m => m && m !== this.pubkeyHex)
    let membersReached = 0
    await Promise.all(recipients.map(async member => {
      const wrapped = wrapGroupLeave(this.secretKey, member, groupId)
      // Retried: nothing awaits this, and a silently-dropped leave notice is invisible to both sides.
      if (await this.publishControl(wrapped)) membersReached++
    }))
    return { memberCount: recipients.length, membersReached }
  }

  // Publish a fire-and-forget CONTROL message with a bounded retry. Never throws — the caller has
  // already committed to the local effect (leaving, creating, re-inviting) and a relay failure must
  // cost only the notification. Stops early if the provider is being torn down, so a lock() can't be
  // held up by a pending backoff. Returns whether any relay accepted, for the caller's tally.
  private async publishControl(wrapped: NostrEvent): Promise<boolean> {
    for (let attempt = 0; attempt <= CONTROL_RETRIES; attempt++) {
      const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS, CONNECT_TIMEOUT_MS)
      if (results.some(r => r.ok)) return true
      if (attempt === CONTROL_RETRIES || this.disconnecting) break
      await new Promise(resolve => setTimeout(resolve, CONTROL_RETRY_BACKOFF_MS))
      if (this.disconnecting) break
    }
    return false
  }

  disconnect(): void {
    this.disconnecting = true
    // Remove window listeners first so a late online/offline event can't re-arm anything.
    if (typeof window !== 'undefined') {
      if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler)
      if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler)
    }
    this.onlineHandler = null
    this.offlineHandler = null
    for (const record of this.records) {
      if (record.retryHandle !== null) {
        clearTimeout(record.retryHandle)
        record.retryHandle = null
      }
      this.clearHeartbeat(record)
      if (record.relay !== null) {
        try { record.relay.close() } catch { /* ignore */ }
        record.relay = null
      }
      record.status = 'closed'
    }
  }

  private async connectRelay(record: RelayRecord): Promise<void> {
    if (this.disconnecting) return

    record.status = 'connecting'
    const relay = new Relay(record.url)
    record.relay = relay

    try {
      await relay.connect({ timeout: CONNECT_TIMEOUT_MS })
    } catch {
      record.relay = null
      if (!this.disconnecting) {
        record.status = 'closed'
        this.updateStatus()
        this.scheduleReconnect(record)
      }
      return
    }

    // Check disconnecting again — lock() may have been called while we were awaiting connect
    if (this.disconnecting) {
      try { relay.close() } catch { /* ignore */ }
      return
    }

    // Wire onclose AFTER successful connect so it only fires for mid-session drops,
    // not for initial connection failures already handled by the catch block above.
    relay.onclose = () => {
      if (!this.disconnecting && record.relay === relay) {
        this.clearHeartbeat(record)
        record.status = 'closed'
        record.relay = null
        this.updateStatus()
        this.scheduleReconnect(record)
      }
    }

    record.status = 'connected'
    record.retries = 0
    this.updateStatus()

    if (this.filter) {
      relay.subscribe([this.filter], {
        onevent: (event: NostrEvent) => this.handleEvent(event),
        oneose: () => {},
      })
    }

    this.startHeartbeat(record, relay)
  }

  private startHeartbeat(record: RelayRecord, relay: Relay): void {
    this.clearHeartbeat(record)
    // Fire one probe now so the UI gets a heartbeat immediately instead of showing "never"
    // for a full interval, then settle into the periodic cadence.
    this.probeRelay(record, relay)
    record.heartbeatHandle = setInterval(() => this.probeRelay(record, relay), HEARTBEAT_INTERVAL_MS)
  }

  private clearHeartbeat(record: RelayRecord): void {
    if (record.heartbeatHandle !== null) {
      clearInterval(record.heartbeatHandle)
      record.heartbeatHandle = null
    }
  }

  // Lightweight liveness probe: REQ a nonexistent id and wait for EOSE within the timeout.
  // Success updates lastHeartbeatOk. Failure (silent death) kills the socket, whose onclose
  // hook routes into scheduleReconnect() — so a dead heartbeat costs a retry like any drop.
  private probeRelay(record: RelayRecord, relay: Relay): void {
    // Guard: provider torn down, or this record has since moved to a different relay object.
    if (this.disconnecting || record.relay !== relay) return

    let settled = false
    let sub: Subscription | undefined

    const onResult = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      // Re-check the gates: disconnect() or a natural onclose may have fired while in flight.
      if (this.disconnecting || record.relay !== relay) {
        try { sub?.close() } catch { /* ignore */ }
        return
      }
      if (ok) {
        // Live relay: close just the probe subscription, keep the connection open.
        try { sub?.close() } catch { /* ignore */ }
        record.lastHeartbeatOk = Date.now()
        this.updateStatus()
      } else {
        // Silent death: stop probing and close the socket. relay.close() fires our onclose
        // hook synchronously, which clears state and calls scheduleReconnect().
        this.clearHeartbeat(record)
        try { relay.close() } catch { /* ignore */ }
      }
    }

    const timeoutHandle = setTimeout(() => onResult(false), HEARTBEAT_TIMEOUT_MS)

    try {
      sub = relay.subscribe(
        [{ ids: [HEARTBEAT_PROBE_ID], limit: 0 }],
        {
          onevent: () => {},
          oneose: () => onResult(true),
          onclose: () => onResult(false),
        }
      )
    } catch {
      onResult(false)
    }
  }

  private scheduleReconnect(record: RelayRecord): void {
    // Double-gate: disconnecting flag first, then retry cap
    if (this.disconnecting) return

    // Offline safety net. When we believe we have no network, don't burn the retry budget on
    // attempts that are guaranteed to fail — but DON'T stall either. navigator.onLine can be
    // wrongly false with no matching 'online' event, so poll on a fixed cadence that re-checks
    // and self-heals when connectivity actually returns. This poll does NOT increment retries.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      record.status = 'closed'
      this.updateStatus()
      if (record.retryHandle !== null) clearTimeout(record.retryHandle)
      record.retryHandle = setTimeout(() => {
        record.retryHandle = null
        void this.connectRelay(record)
      }, OFFLINE_POLL_MS)
      return
    }

    if (record.retries >= MAX_RETRIES) {
      record.status = 'failed'
      console.warn(`[NostrMP] ${record.url}: max retries (${MAX_RETRIES}) reached, giving up`)
      this.updateStatus()
      return
    }
    const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, record.retries), MAX_BACKOFF_MS)
    record.retries++
    record.retryHandle = setTimeout(() => {
      record.retryHandle = null
      void this.connectRelay(record)
    }, delay)
  }

  // Public: force an immediate reconnect on every down relay (resets retry budgets). Wired to the
  // relay-health panel's "Reconnect all" — same code path as the browser 'online' event.
  reconnectAll(): void {
    this.handleOnline()
  }

  // Fired on the window 'online' event: connectivity just returned. Force an immediate
  // reconnect attempt on every relay that isn't already connecting/connected.
  private handleOnline(): void {
    if (this.disconnecting) return
    for (const record of this.records) {
      if (record.status === 'connecting' || record.status === 'connected') continue
      // Cancel any pending backoff/offline-poll timer so we don't double-connect.
      if (record.retryHandle !== null) {
        clearTimeout(record.retryHandle)
        record.retryHandle = null
      }
      // Reset the retry budget. This is the ONLY retry reset outside a successful connect, and
      // it's deliberate: a fresh 'online' event is a genuine network-state change, categorically
      // different from a relay being unreachable while we HAD a network. A relay that exhausted
      // MAX_RETRIES (status 'failed') on a dead network deserves a clean slate now that the
      // network is back — otherwise it would stay permanently failed after any offline spell.
      record.retries = 0
      void this.connectRelay(record)
    }
  }

  // Fired on the window 'offline' event: our network just dropped. Proactively tear down live
  // connections so the UI reflects reality immediately instead of waiting out the heartbeat.
  // Each relay.close() routes through onclose → scheduleReconnect, which sees we're offline
  // and switches to the poll cadence.
  private handleOffline(): void {
    if (this.disconnecting) return
    for (const record of this.records) {
      if (record.status === 'connected' && record.relay !== null) {
        // onclose (wired in connectRelay) clears the heartbeat and schedules reconnect.
        try { record.relay.close() } catch { /* ignore */ }
      }
    }
  }

  private updateStatus(): void {
    if (!this.onStatusCallback) return
    const statuses = this.records.map(r => r.status)
    let status: MessagingConnectionStatus
    if (statuses.every(s => s === 'connected')) {
      status = 'connected'
    } else if (statuses.some(s => s === 'connected')) {
      status = 'degraded'
    } else if (statuses.some(s => s === 'connecting')) {
      status = 'connecting'
    } else {
      status = 'disconnected'
    }
    this.onStatusCallback(status)
  }

  private handleEvent(event: NostrEvent): void {
    // Dedup: the same event may arrive from every relay we are subscribed to.
    if (this.seen.has(event.id)) return
    this.seen.add(event.id)
    try {
      const { senderPubkeyHex, plaintext, sentAtMs, payment, tariAddress, groupId, groupDef, groupLeave, groupReinvite, logicalId, edit, media, replyTo, reaction } = unwrapMessage(this.secretKey, event)

      // A group DEFINITION is a control message (no chat bubble): hand it to the group callback and
      // stop. The gate (accept only from known contacts) lives with the callback, which has the
      // contact list. Checked before the address/message handling below.
      if (groupDef) {
        // The gift-wrap event id goes with it (Phase C): unique per publish, so the callback can
        // tell a genuine re-send from a relay replaying the same def out of its ~2-day window.
        this.onGroupDefinitionCallback?.(senderPubkeyHex, groupDef, event.id, !!groupReinvite)
        return
      }

      // A group LEAVE notice (B-M2) rides the ORDINARY message callback rather than a dedicated one,
      // carrying system:'group-leave' as its discriminator — so it inherits every downstream gate
      // (known-contact, group-known, left-group drop) and persists/orders like any other row.
      // Intercepting here is mandatory: the rumor carries a group tag, so falling through would
      // store it as a group message and render a blank bubble for its single-space content.
      if (groupLeave && groupId) {
        const leaveAt = Date.now()
        this.onMessageCallback?.({
          id: event.id,
          senderPubkeyHex,
          recipientPubkeyHex: this.pubkeyHex,
          plaintext: '',            // notice text is composed at render time from the display name
          // Label stays on OUR clock — a leave notice is a local event marker, not a message with a
          // meaningful send time, so it is out of scope for the send-time change. It still needs
          // receivedAt: the re-invite check compares leave rows against ordinary messages, and that
          // comparison must run on a single basis (see ChatApp's newestBy).
          timestamp: leaveAt,
          receivedAt: leaveAt,
          direction: 'received',
          groupId,
          system: 'group-leave',
        })
        return
      }

      // An EDIT (M2) is a control message like a group definition: it MUTATES an existing row and
      // must never become a bubble, so it takes a dedicated callback and returns early. Intercepted
      // before the address/message handling below because an edit carries neither.
      //
      // `senderPubkeyHex` here is seal.pubkey, which unwrapMessage has already verified equals the
      // rumor pubkey — so it is the authenticated editor, not a self-declared one. The receiver is
      // NOT trusted to have authored the target: applyEdit rejects the edit unless this key matches
      // the original message's sender, which is what stops anyone who has seen a public wrap id (or
      // a logical id we sent them) from rewriting somebody else's message.
      if (edit) {
        this.onEditCallback?.(senderPubkeyHex, edit.targetLogicalId, plaintext, edit.revision)
        return
      }

      // A REACTION (reactions v1) is a control message on the same footing as an edit: it MUTATES an
      // existing row, must never become a bubble, and carries a single-space content that would
      // render blank if it fell through. Intercepted here for exactly those reasons.
      //
      // `senderPubkeyHex` is seal.pubkey, already verified against the rumor pubkey by unwrapMessage,
      // and it is the ONLY source of reactor identity — the wire payload carries none. Unlike an edit
      // there is no authorship check downstream, because a reaction is anyone-to-anyone; that is safe
      // because the applier keys every row on this authenticated value, so a reaction can only ever
      // touch the sender's OWN row. See applyReactionByLogicalId.
      //
      // Note this bypasses the tombstone gate in WalletContext's onMessage, exactly as an edit does:
      // control messages never reach it. Harmless — a deleted conversation's rows are gone, so the
      // applier's unknown-logicalId guard no-ops on anything a backfill replays.
      if (reaction) {
        this.onReactionCallback?.(senderPubkeyHex, reaction.targetLogicalId, reaction.emoji, reaction.action, reaction.seq)
        return
      }

      // Extract + store any received Tari address FIRST, before any content-based suppression or
      // message handling. A dedicated address-exchange control message is empty; if suppression ran
      // before extraction the address would be silently discarded and payments could never find it.
      if (tariAddress) {
        this.onContactAddressCallback?.(senderPubkeyHex, tariAddress)
        // Dedicated silent control message: address tag over empty content → no bubble.
        // A piggybacked address (address tag on a real message) has content and renders below.
        //
        // `&& !media` (images M3) is load-bearing, not defensive. Empty content stopped meaning
        // "nothing to show" the moment images arrived: a CAPTIONLESS image sends a single space (the
        // NIP-44 one-byte floor), which trims to empty — so without this clause, the very first image
        // sent to a new peer would piggyback the address, hit this return, and be SILENTLY DROPPED.
        // `!payment` guards the same shape for a payment with no note.
        if (plaintext.trim() === '' && !media && !payment) return
      }

      // Arrival is our clock and is what everything orders by; the label is the sender's claim,
      // clamped. Before this, `timestamp` was Date.now() here — the moment of DECRYPT — so every
      // message that queued while signed out displayed the instant of sign-in rather than when it
      // was actually sent.
      const receivedAt = Date.now()
      const msg: CaravelMessage = {
        id: event.id,
        senderPubkeyHex,
        recipientPubkeyHex: this.pubkeyHex,
        plaintext,
        timestamp: clampSendTime(sentAtMs, receivedAt),
        receivedAt,
        direction: 'received',
        payment,
        // Present → routes to the group thread; the sender-is-a-contact gate is applied downstream.
        ...(groupId ? { groupId } : {}),
        // M2: absent on messages from a pre-M2 sender, which are therefore not editable.
        ...(logicalId ? { logicalId } : {}),
        // An encrypted image (images M3). Note there is deliberately NO early-return intercept for
        // media above, unlike groupDef/groupLeave: those are CONTROL messages with nothing to store,
        // whereas a media message is an ordinary message that also has an image. Falling through here
        // is what gives it the known-contact gate, the left-group drop, tombstoning, group routing and
        // persistence for free — intercepting it would mean reimplementing every one of them.
        ...(media ? { media } : {}),
        // A quoted reply (replies v1). No early-return intercept, for the same reason media has
        // none: a reply is an ORDINARY message that also points at another, so falling through is
        // what gives it the known-contact gate, group routing, tombstoning and persistence. The
        // target is NOT resolved here — the quote is looked up live at render, so a reply whose
        // original has not arrived yet still stores fine and heals when it does.
        ...(replyTo ? { replyTo } : {}),
      }
      this.onMessageCallback?.(msg)
    } catch (e) {
      // Not every kind-1059 event p-tagged to us is decryptable — relays may serve
      // events from past sessions or other senders using a different key.
      console.warn(`[NostrMP] decrypt failed for event ${event.id}:`, e)
    }
  }
}
