// LIVE end-to-end check of the anonymous usage count, against the real relays.
//
//   npm run test:live
//
// Publishes ONE test note (tag `caravel-test/identity_created`, never the production tag) to each
// relay Caravel publishes to, each signed by its own throwaway key, and reports which relays accepted
// it. Then asks every COUNT relay for the test count and checks it includes the new note.
//
// Relays run spam filters, and a never-seen key publishing kind 30078 is exactly what one might
// refuse; this is the test that says so. Test notes cannot reach the production count: the landing
// page filters on the exact production tag (src/config/stats.ts).

import { describe, expect, it } from 'vitest'
import { Relay } from 'nostr-tools/relay'
import { DEFAULT_RELAYS } from '../src/config/relays'
import { COUNT_RELAYS, TEST_TAG_PREFIX } from '../src/config/stats'
import { buildStatNote } from '../src/messaging/usageStats'
import { countOnRelay, userCountFilter } from '../src/components/landing/userCount'

async function publishOne(url: string): Promise<{ ok: boolean; detail: string }> {
  let relay: Relay | null = null
  try {
    relay = await Relay.connect(url)
    relay.publishTimeout = 10_000
    const reason = await relay.publish(buildStatNote('identity_created', Date.now(), TEST_TAG_PREFIX))
    return { ok: true, detail: reason || 'accepted' }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  } finally {
    try { relay?.close() } catch { /* already closed */ }
  }
}

describe('anonymous usage count, end to end over real relays', () => {
  it('relays accept a test note, and COUNT sees it', async () => {
    const filter = userCountFilter(TEST_TAG_PREFIX)

    const before: Record<string, number | null> = {}
    for (const url of COUNT_RELAYS) before[url] = await countOnRelay(url, filter, 8_000)

    const published: Record<string, { ok: boolean; detail: string }> = {}
    for (const url of DEFAULT_RELAYS) published[url] = await publishOne(url)

    await new Promise(r => setTimeout(r, 2_000))
    const after: Record<string, number | null> = {}
    for (const url of COUNT_RELAYS) after[url] = await countOnRelay(url, filter, 8_000)

    console.log('\nPUBLISH (one test note per relay, fresh key each):')
    for (const [url, r] of Object.entries(published)) console.log(`  ${r.ok ? 'ACCEPTED' : 'REJECTED'}  ${url}  ${r.detail}`)
    console.log('COUNT of caravel-test/identity_created since launch day (before -> after):')
    for (const url of COUNT_RELAYS) console.log(`  ${url}  ${before[url]} -> ${after[url]}`)

    // At least one relay must take the note, and every COUNT relay that took it must count it.
    expect(Object.values(published).some(r => r.ok)).toBe(true)
    for (const url of COUNT_RELAYS) {
      if (!published[url]?.ok) continue
      expect(after[url]).not.toBeNull()
      expect(after[url]!).toBeGreaterThan(before[url] ?? -1)
    }
  })
})
