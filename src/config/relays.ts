// Single source of truth for relay URLs. No relay URL should be hardcoded anywhere else.
//
// Both relays are proven via M7.2: relay.damus.io accepted kind 1059,
// relay.primal.net accepted and delivered in 669ms.
//
// This becomes user-configurable in a later milestone. The eventual proper answer is
// NIP-65 / kind-10050 preferred-DM-relays, where each user publishes their own relay list
// and senders look it up before wrapping. For now, a shared default is sufficient.
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
] as const
