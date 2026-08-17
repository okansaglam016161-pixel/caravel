// Single source of truth for relay URLs. No relay URL should be hardcoded anywhere else.
//
// This becomes user-configurable in a later milestone. The eventual proper answer is
// NIP-65 / kind-10050 preferred-DM-relays, where each user publishes their own relay list
// and senders look it up before wrapping. For now, a shared default is sufficient.
//
// ── THE BAR: A RELAY MUST ACCEPT **AND** DELIVER ───────────────────────────────────────────────────
//
// "Connected" is not the bar, and neither is "accepted". A relay can accept the WebSocket, return OK
// for the event, and then never serve it to a subscriber — and that is WORSE than a relay being down,
// because publishGiftWrap records the OK as success. The sender is told the message landed (in groups,
// `membersReached` counts that member as reached) and the recipient receives nothing. A dead relay is
// safe: it is counted as a miss. A relay that accepts-then-drops produces silent loss with a false
// success signal, which is the one thing the app cannot detect.
//
// So every entry below was held to a real kind-1059 gift-wrap ROUND TRIP: published on one connection
// and read back on a SECOND connection (a single socket can appear to work when the relay merely
// echoes your own publish back), fresh throwaway keypair each round, 3 rounds each.
//
// The gate is `node scripts/relay-verify.mjs`. RE-RUN IT BEFORE SHIPPING — these are third-party
// services and a relay that passes today can regress. primal did exactly that (below).
//
// ── THE MEASURED LEVEL 1 SET (12 candidates probed, 3 rounds each) ────────────────────────────────
//
//   relay                accepts   delivers   median   worst    connect dials
//   relay.snort.social   3/3       3/3        73ms     84ms     1
//   nos.lol              3/3       3/3        166ms    181ms    1
//   relay.nostr.net      3/3       3/3        192ms    343ms    1
//   nostr.mom            3/3       3/3        234ms    277ms    1
//   relay.damus.io       2/3       2/3        299ms    330ms    1-4   ← see below
//
// FIVE relays, not two, because RELAYS DO NOT FEDERATE (verified: an event published to damus was
// served back by damus and was invisible on primal). A wrap is deliverable only to members who are
// live on a relay that accepted it, so a DM needs one sender/peer overlap while a group needs N
// independent overlaps — which is why group delivery degraded geometrically with roster size while
// DMs between the same wallets felt reliable. More relays buys overlap; it is the direct mitigation.
//
// COST, so this is a trade and not a free win: every relay multiplies BOTH directions. Each send fans
// out to all five, each client holds five long-lived subscription sockets, and a group of N members
// becomes 5N publishes per message.
//
// ── WHY damus IS KEPT AT 2/3 WHEN OTHER 2/3 RELAYS WERE REJECTED ──────────────────────────────────
//
// The failure CLASS matters far more than the count, and two relays scoring an identical 2/3 needed
// opposite responses. Do not re-litigate this from the numbers alone:
//
//   damus's miss was a FAILED DIAL — it delivered everything it ever accepted. That is the documented
//   ~30% cold-dial failure rate (measured 5/8 sequential, 6-7/8 concurrent), it is RETRYABLE, and
//   PUBLISH_ATTEMPTS in crypto/nostrMessaging.ts now covers it. Damus is also by far the most
//   populated relay, so a recipient using any other Nostr client is likelier to be subscribed there
//   than anywhere else — which is precisely the overlap this list exists to buy. Dropping the biggest
//   relay over a retryable transport fault would trade real reach for a tidier table.
//
//   relay.nostr.wirednet.jp (2/3) missed by ACCEPTING AND THEN DROPPING. No retry can fix that,
//   because as far as the app is concerned the publish already succeeded. Rejected.
//
// ── REMOVED: relay.primal.net (was in this list) ──────────────────────────────────────────────────
//
// It accepts kind-1059 gift wraps and then fails to deliver them to a live subscriber. First measured
// at 1/3 delivery (7.2s on its one success); on re-measurement it had NOT recovered but REGRESSED to
// 0/3 delivery plus 2/3 connect failures. This made it the strongest single explanation for the
// "shows sent but never arrives" reports: unlike the cold-dial theory it needs no coincidence of
// timing or subscription state, and it poisoned the old two-relay list specifically — any wrap damus
// dropped on a bad dial, primal would then accept-and-drop, leaving one relay functionally write-only.
//
// Also rejected: nostr.wine (paid — "restricted: sign up to write events"), nostr21.com (refuses the
// kind outright — "blocked kind 1059 reason: this is not a DM relay"), relay.nostr.bg (unreachable,
// 12 dials). The first two at least refuse HONESTLY, so their rejection is correctly counted as a
// miss rather than a false success. relay.mostr.pub passed 3/3 at 382ms and is a reasonable reserve,
// but it is a Mastodon bridge, so its retention policy is less predictable than the five below.
//
// Ordered best-measured first; nothing in the code depends on the order.
export const DEFAULT_RELAYS = [
  'wss://relay.snort.social',
  'wss://nos.lol',
  'wss://relay.nostr.net',
  'wss://nostr.mom',
  'wss://relay.damus.io',
] as const
