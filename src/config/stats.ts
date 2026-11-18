// The anonymous usage count: what Caravel publishes, when, and where it is counted.
//
// One empty Nostr note per event (an identity created; Sapient first connected), signed by a
// brand-new key used once, dated to the day, sent hours later. See messaging/usageStats.ts for the
// note and the queue, hooks/useUsageStats.ts for the sending, components/landing/userCount.ts for
// the live count.
//
// TEST NOTES CAN NEVER REACH THE PRODUCTION COUNT. Dev builds (`npm run dev`) and the live test use
// the `caravel-test/` tag; production builds use `caravel/`. The count filters on the exact `d` tag,
// so a test note never matches, and on `since` = launch day, so nothing older can either.

/** NIP-78 application data. Relays index its `d` tag, which is what the count filters on. */
export const STAT_NOTE_KIND = 30078

export type StatKind = 'identity_created' | 'wallet_connected'

export const PROD_TAG_PREFIX = 'caravel/'
export const TEST_TAG_PREFIX = 'caravel-test/'

/** Dev builds and tests get the test tag; a production build cannot (import.meta.env.DEV is false). */
export const STAT_TAG_PREFIX = import.meta.env.DEV ? TEST_TAG_PREFIX : PROD_TAG_PREFIX

export function statTag(kind: StatKind, prefix: string = STAT_TAG_PREFIX): string {
  return prefix + kind
}

/** Delay before a note is sent: random within this range (2 to 6 hours; 1 to 2 minutes in dev). */
export const STAT_DELAY_MS: readonly [number, number] = import.meta.env.DEV
  ? [60_000, 120_000]
  : [2 * 3_600_000, 6 * 3_600_000]

/** A note that still could not be sent this long after it was due is dropped, not sent late. */
export const STAT_GIVE_UP_MS = 14 * 24 * 3_600_000

/** How often an unlocked app checks for due notes. */
export const STAT_CHECK_MS = import.meta.env.DEV ? 15_000 : 10 * 60_000

/** Relays that answer NIP-45 COUNT (all strfry, checked via NIP-11 on 2026-11-18). */
export const COUNT_RELAYS = ['wss://nos.lol', 'wss://relay.nostr.net', 'wss://nostr.mom', 'wss://relay.damus.io']

/** The landing page waits this long for any relay, then shows nothing. */
export const COUNT_TIMEOUT_MS = 2500

/** Launch day, 2026-11-18 00:00 UTC: the count starts here. No backfill, nothing older. */
export const COUNT_SINCE = 1794960000
