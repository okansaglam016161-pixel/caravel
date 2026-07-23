import type { NostrEvent } from 'nostr-tools'
import { Relay } from 'nostr-tools/relay'
import { wrapMessage, unwrapMessage, publishGiftWrap } from '../crypto/nostrMessaging'
import type { CaravelMessage, MessagingProvider } from './types'

// Nostr NIP-17 implementation of MessagingProvider.
// Wraps send as gift-wrapped kind-1059 events; subscribes for the same on inbound.
// Reconnection and relay-lifecycle management are NOT implemented here — deferred to M8.2.

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

export class NostrMessagingProvider implements MessagingProvider {
  private secretKey: Uint8Array
  private pubkeyHex: string
  private relays: readonly string[]
  private openRelays: Relay[]
  private seen: Set<string>
  private onMessageCallback: ((msg: CaravelMessage) => void) | null
  private _isConnected: boolean

  constructor(secretKeyHex: string, pubkeyHex: string, relays: readonly string[]) {
    this.secretKey = hexToBytes(secretKeyHex)
    this.pubkeyHex = pubkeyHex
    this.relays = relays
    this.openRelays = []
    this.seen = new Set()
    this.onMessageCallback = null
    this._isConnected = false
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  async sendMessage(recipientPubkeyHex: string, plaintext: string): Promise<CaravelMessage> {
    const wrapped = wrapMessage(this.secretKey, recipientPubkeyHex, plaintext)
    const results = await publishGiftWrap(wrapped, [...this.relays], PUBLISH_TIMEOUT_MS)

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
    }
  }

  async subscribe(onMessage: (msg: CaravelMessage) => void): Promise<void> {
    this.onMessageCallback = onMessage
    const since = Math.floor(Date.now() / 1000) - SINCE_WINDOW_S
    const filter = { kinds: [1059], '#p': [this.pubkeyHex], since }

    await Promise.allSettled(
      [...this.relays].map(async (url) => {
        const relay = new Relay(url)
        try {
          await relay.connect({ timeout: CONNECT_TIMEOUT_MS })
          this.openRelays.push(relay)
          relay.subscribe([filter], {
            onevent: (event: NostrEvent) => this.handleEvent(event),
            oneose: () => {},
          })
          this._isConnected = true
        } catch {
          console.warn(`[NostrMessagingProvider] could not connect to ${url}`)
        }
      })
    )
  }

  disconnect(): void {
    for (const relay of this.openRelays) {
      try { relay.close() } catch { /* ignore — relay may already be closed */ }
    }
    this.openRelays = []
    this._isConnected = false
  }

  private handleEvent(event: NostrEvent): void {
    // Dedup: the same event arrives from every relay we are subscribed to.
    if (this.seen.has(event.id)) return
    this.seen.add(event.id)

    try {
      const { senderPubkeyHex, plaintext } = unwrapMessage(this.secretKey, event)
      const msg: CaravelMessage = {
        id: event.id,
        senderPubkeyHex,
        recipientPubkeyHex: this.pubkeyHex,
        plaintext,
        timestamp: Date.now(),
        direction: 'received',
      }
      this.onMessageCallback?.(msg)
    } catch (e) {
      // Not every kind-1059 event p-tagged to us is decryptable by us — relays may serve
      // events from past sessions or other senders using a different key. Log and continue.
      console.warn(`[NostrMessagingProvider] decrypt failed for event ${event.id}:`, e)
    }
  }
}
