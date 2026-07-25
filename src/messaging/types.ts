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

// A reference to a confidential Tari payment carried by a message (M10.0). Only the UTXO
// substate id travels on the wire — the amount is confidential and stays the sole property of
// the UTXO itself, decrypted from it at render time (never duplicated here). Nested as an object
// (not a bare string) so it can later carry resolved/cached fields (amount, status) without a rename.
export interface PaymentRef {
  utxoId: string           // Tari UTXO substate id, e.g. "utxo_0101…_<commitment>"
}

// LOCAL-ONLY sender-side cache. NEVER travels on the wire (wrapMessage tags only PaymentRef.utxoId)
// and is never set on received messages. Lets our own thread render the amount we sent — which is
// confidential and deliberately absent from the wire — without decrypting the recipient's UTXO.
// amountMicrotari is a decimal µTari STRING so it JSON-serialises without bigint (messageStore).
export interface LocalPaymentMeta {
  amountMicrotari: string
  txId: string
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
  // Present only when the message carried a caravel-payment tag on its rumor.
  payment?: PaymentRef
  // LOCAL-ONLY (see LocalPaymentMeta): cached amount/txId for a payment WE sent. Never on the wire.
  localPayment?: LocalPaymentMeta
}

export interface MessagingProvider {
  // Send a message to the given recipient. Returns the CaravelMessage so the caller
  // can record it immediately without waiting for an echo from the relay.
  // Optional tags ride on the rumor: a payment reference (PaymentRef) and/or MY Tari address
  // (piggybacked for self-healing address exchange — see M9.0d).
  sendMessage(recipientPubkeyHex: string, plaintext: string, payment?: PaymentRef, tariAddress?: string): Promise<CaravelMessage>

  // Send a dedicated, silent Tari-address control message (M9.0d). Carries only the address tag
  // over an empty-content rumor, so the recipient stores the address without a chat bubble.
  // Resolves true if at least one relay accepted it (so the caller can mark it delivered).
  sendContactAddress(recipientPubkeyHex: string, tariAddress: string): Promise<boolean>

  // Open a persistent subscription. Fire-and-forget — returns void immediately.
  // Relay connections happen in the background; onStatusChange fires as relay states change.
  // onContactAddress fires for a received (authenticated) Tari address — see M9.0d.
  subscribe(
    onMessage: (msg: CaravelMessage) => void,
    onStatusChange?: (status: MessagingConnectionStatus) => void,
    onContactAddress?: (senderPubkeyHex: string, tariAddress: string) => void
  ): void

  // Close all relay connections and subscriptions. Idempotent — safe to call more than once.
  disconnect(): void

  readonly isConnected: boolean
}
