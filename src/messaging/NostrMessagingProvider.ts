import type { NostrEvent, Filter } from 'nostr-tools'
import { Relay, type Subscription } from 'nostr-tools/relay'
import { wrapMessage, unwrapMessage, publishGiftWrap } from '../crypto/nostrMessaging'
import type { CaravelMessage, MessagingConnectionStatus, MessagingProvider, PaymentRef, RelayState } from './types'

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2)
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return arr
}

const CONNECT_TIMEOUT_MS = 10_000
const PUBLISH_TIMEOUT_MS = 10_000
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
    onContactAddress?: (senderPubkeyHex: string, tariAddress: string) => void
  ): void {
    this.onMessageCallback = onMessage
    this.onStatusCallback = onStatusChange ?? null
    this.onContactAddressCallback = onContactAddress ?? null
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

  async sendMessage(recipientPubkeyHex: string, plaintext: string, payment?: PaymentRef, tariAddress?: string): Promise<CaravelMessage> {
    const wrapped = wrapMessage(this.secretKey, recipientPubkeyHex, plaintext, payment, tariAddress)
    const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS)

    const anyOk = results.some(r => r.ok)
    if (!anyOk) {
      const detail = results.map(r => `${r.relay}: ${r.error ?? 'rejected'}`).join('; ')
      throw new Error(`NostrMessagingProvider: failed to publish to any relay — ${detail}`)
    }

    return {
      id: wrapped.id,
      senderPubkeyHex: this.pubkeyHex,
      recipientPubkeyHex,
      plaintext,
      timestamp: Date.now(),
      direction: 'sent',
      payment,
    }
  }

  // Send a dedicated silent Tari-address control message (M9.0d): only the address tag, over a
  // single-space content (NIP-44 requires >= 1 byte, so it can't be truly empty). It carries no
  // payment and no note; the recipient extracts + stores the address and renders nothing. Returns
  // true if at least one relay accepted, so the caller can mark the address as delivered.
  async sendContactAddress(recipientPubkeyHex: string, tariAddress: string): Promise<boolean> {
    const wrapped = wrapMessage(this.secretKey, recipientPubkeyHex, ' ', undefined, tariAddress)
    const results = await publishGiftWrap(wrapped, [...this.relayUrls], PUBLISH_TIMEOUT_MS)
    return results.some(r => r.ok)
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
      const { senderPubkeyHex, plaintext, payment, tariAddress } = unwrapMessage(this.secretKey, event)

      // Extract + store any received Tari address FIRST, before any content-based suppression or
      // message handling. A dedicated address-exchange control message is empty; if suppression ran
      // before extraction the address would be silently discarded and payments could never find it.
      if (tariAddress) {
        this.onContactAddressCallback?.(senderPubkeyHex, tariAddress)
        // Dedicated silent control message: address tag over empty content → no bubble.
        // A piggybacked address (address tag on a real message) has content and renders below.
        if (plaintext.trim() === '') return
      }

      const msg: CaravelMessage = {
        id: event.id,
        senderPubkeyHex,
        recipientPubkeyHex: this.pubkeyHex,
        plaintext,
        timestamp: Date.now(),
        direction: 'received',
        payment,
      }
      this.onMessageCallback?.(msg)
    } catch (e) {
      // Not every kind-1059 event p-tagged to us is decryptable — relays may serve
      // events from past sessions or other senders using a different key.
      console.warn(`[NostrMP] decrypt failed for event ${event.id}:`, e)
    }
  }
}
