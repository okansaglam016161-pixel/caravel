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
  // Present when the message belongs to a group (carried a caravel-group tag). Absent = 1-to-1 DM.
  // When set, the message routes to the group thread `groupId` instead of a pairwise peer thread.
  groupId?: string
  // NOTICE, not prose (B-M2). Set on a row that renders as an inline system line in the group
  // thread instead of a chat bubble; `plaintext` is empty and the text is composed at render time
  // from the sender's display name. Absent on every ordinary message — no migration needed.
  //   'group-leave' — senderPubkeyHex has left groupId. Visual only: the roster is NOT edited
  //                   (Phase 1 has no roster changes).
  system?: 'group-leave'
}

// ── Groups (Phase 1: fan-out, in-message roster, fixed membership) ──────────────

// Invite-gating lifecycle (Phase A). One clean field, not scattered booleans:
//   - pending — an inbound def/message introduced this group; held out of the active thread until
//               the user accepts (mirrors the DM 'pending' contact gate).
//   - active  — a normal group (I created it, or I accepted an invite). Behaves as Phase 1 did.
//   - left    — declined (Phase A) or explicitly left (Phase B). Permanent LOCAL suppression:
//               the record is KEPT (not removed) so "gone stays gone" — a new message can't re-open
//               it (it stays held), and a replayed def is ignored by first-def-wins. Stronger than
//               deleteGroup's forget-until-re-invited.
export type GroupState = 'pending' | 'active' | 'left'

// A group a wallet participates in. Membership is the in-message roster (Phase 1) — the members a
// message is fanned out to. `members` includes the creator. A group with an empty name + roster is
// a LAZY placeholder created from a group message seen before its definition arrived.
export interface Group {
  id: string               // random 32-byte hex, generated at creation; independent of the roster
  name: string             // '' for a lazy placeholder (UI shows "Group <shortid>")
  members: string[]        // member Nostr pubkeys (hex), including the creator
  createdAt: number        // ms epoch (local)
  state: GroupState        // invite-gating lifecycle (Phase A). Legacy groups migrate → 'active'.
}

// The on-the-wire group definition (content of a group-def control message). Tells a member the
// group exists, its name, and its roster.
export interface GroupDef {
  id: string
  name: string
  members: string[]
}

// Result of a group send. The count is RELAY ACCEPTANCE (accepted for propagation), NOT delivery
// confirmation — a member's client may still never receive it. Surface only as a soft "sent".
export interface GroupSendResult {
  message: CaravelMessage  // the local 'sent' record (groupId set, blank recipient)
  memberCount: number      // members fanned to (roster minus self)
  membersReached: number   // members whose wrap ≥1 relay ACCEPTED (relays-reached, not delivered)
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

  // Group message (Phase 1): fan out one NIP-17 gift wrap per member (roster minus self), each
  // tagged with the group id. Returns the local 'sent' record + a relays-reached tally (NOT a
  // delivery receipt). Throws only if no member's wrap reached any relay.
  sendGroupMessage(groupId: string, memberPubkeysHex: string[], plaintext: string): Promise<GroupSendResult>

  // Group definition control message: fan out the group's { name, roster } to its members (minus
  // self) so their clients learn the group exists. Empty-of-prose → no chat bubble on receipt.
  sendGroupDefinition(def: GroupDef): Promise<{ memberCount: number; membersReached: number }>

  // Group LEAVE notice (B-M2): fan out "I have left this group" to the roster (minus self) so their
  // clients can render a system line. Like sendGroupDefinition — and deliberately UNLIKE
  // sendGroupMessage — this NEVER throws: leaving is a local act that must not be blocked or undone
  // by relay failure, so the caller fires it and moves on regardless of the tally.
  sendGroupLeave(groupId: string, memberPubkeysHex: string[]): Promise<{ memberCount: number; membersReached: number }>

  // Open a persistent subscription. Fire-and-forget — returns void immediately.
  // Relay connections happen in the background; onStatusChange fires as relay states change.
  // onContactAddress fires for a received (authenticated) Tari address — see M9.0d.
  subscribe(
    onMessage: (msg: CaravelMessage) => void,
    onStatusChange?: (status: MessagingConnectionStatus) => void,
    onContactAddress?: (senderPubkeyHex: string, tariAddress: string) => void,
    // Fires for a received group-definition control message (authenticated to senderPubkeyHex).
    onGroupDefinition?: (senderPubkeyHex: string, def: GroupDef) => void
  ): void

  // Close all relay connections and subscriptions. Idempotent — safe to call more than once.
  disconnect(): void

  // Snapshot of per-relay health (for the connection/relay-health UI). Not reactive — poll it.
  getRelayStates(): RelayState[]

  // Force an immediate reconnect on every relay that isn't already connecting/connected,
  // resetting each one's retry budget (same path as the browser 'online' event).
  reconnectAll(): void

  readonly isConnected: boolean
}
