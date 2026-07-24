// Transport-agnostic messaging abstractions for Caravel.
// Nothing here mentions relays, gift wraps, Nostr event kinds, or any protocol detail.

export type MessagingConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'degraded'

export interface RelayState {
  url: string
  status: 'connecting' | 'connected' | 'failed' | 'closed'
  retries: number
  // ms epoch of the last successful heartbeat probe (EOSE received), or null if none yet.
  // Lets the UI show "Xs ago" so a silently-dead connection is visible before reconnect kicks in.
  lastHeartbeatOk: number | null
}

export interface CaravelMessage {
  id: string               // unique per message — use the gift wrap event id
  senderPubkeyHex: string
  recipientPubkeyHex: string
  plaintext: string
  // OUR clock at the moment of send/receive, NOT the Nostr event's created_at.
  // Gift wraps deliberately fuzz created_at by up to 2 days in the past (NIP-17 / randomNow),
  // so event time is useless for ordering a conversation thread. This field is.
  timestamp: number        // ms epoch
  direction: 'sent' | 'received'
}

export interface MessagingProvider {
  // Send a message to the given recipient. Returns the CaravelMessage so the caller
  // can record it immediately without waiting for an echo from the relay.
  sendMessage(recipientPubkeyHex: string, plaintext: string): Promise<CaravelMessage>

  // Open a persistent subscription. Fire-and-forget — returns void immediately.
  // Relay connections happen in the background; onStatusChange fires as relay states change.
  subscribe(
    onMessage: (msg: CaravelMessage) => void,
    onStatusChange?: (status: MessagingConnectionStatus) => void
  ): void

  // Close all relay connections and subscriptions. Idempotent — safe to call more than once.
  disconnect(): void

  readonly isConnected: boolean
}
