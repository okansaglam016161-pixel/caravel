// The anonymous usage count on the device: what a note contains (and does not), and the queue
// across sessions — delay, once per identity, opt-out, give-up, and the test/production split.

import { beforeEach, describe, expect, it } from 'vitest'
import { getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { buildStatNote, dayStart, loadStats, noteToSend, queueStat, recordDelivery, takeDue } from './usageStats'
import {
  COUNT_RELAYS, PROD_TAG_PREFIX, STAT_DELAY_MS, STAT_GIVE_UP_MS, STAT_NOTE_KIND, STAT_TAG_PREFIX, TEST_TAG_PREFIX, statTag,
} from '../config/stats'
import { DEFAULT_RELAYS } from '../config/relays'
import { setStoreKey } from '../crypto/sessionKey'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

const ME = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const T0 = Date.UTC(2026, 10, 18, 15, 42, 7)   // 2026-11-18 15:42:07 UTC
const [LO, HI] = STAT_DELAY_MS

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(new Uint8Array(32).fill(3))
})

describe('the note', () => {
  it('is kind 30078, empty, tagged, dated to the day, and validly signed', () => {
    const ev = buildStatNote('identity_created', T0, PROD_TAG_PREFIX)
    expect(ev.kind).toBe(STAT_NOTE_KIND)
    expect(ev.content).toBe('')
    expect(ev.tags).toEqual([['d', 'caravel/identity_created'], ['alt', 'Anonymous Caravel usage count']])
    expect(ev.created_at).toBe(Date.UTC(2026, 10, 18) / 1000)
    expect(ev.created_at).toBe(dayStart(T0))
    expect(verifyEvent(ev)).toBe(true)
  })

  it('every note is signed by a different, brand-new key', () => {
    const keys = new Set(Array.from({ length: 5 }, () => buildStatNote('wallet_connected', T0).pubkey))
    expect(keys.size).toBe(5)
  })

  it('carries nothing but the kind, the tag and the day: not the identity it was made for', () => {
    const sk = new Uint8Array(32).fill(7)
    const ev = buildStatNote('identity_created', T0, PROD_TAG_PREFIX, sk)
    expect(ev.pubkey).toBe(getPublicKey(sk))
    expect(JSON.stringify(ev)).not.toContain(ME)
    expect(Object.keys(ev).sort()).toEqual(['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags'])
  })
})

describe('test notes can never reach the production count', () => {
  it('tests and dev builds use the test tag; production uses a different, exact tag', () => {
    expect(STAT_TAG_PREFIX).toBe(TEST_TAG_PREFIX)   // vitest runs as a dev build
    expect(statTag('identity_created', TEST_TAG_PREFIX)).toBe('caravel-test/identity_created')
    expect(statTag('identity_created', PROD_TAG_PREFIX)).toBe('caravel/identity_created')
    expect(statTag('identity_created', TEST_TAG_PREFIX)).not.toBe(statTag('identity_created', PROD_TAG_PREFIX))
    expect(buildStatNote('identity_created', T0).tags[0][1]).toBe('caravel-test/identity_created')
  })
})

describe('the queue', () => {
  it('queues with a random delay inside the range, and is due only after it', () => {
    queueStat(ME, 'identity_created', T0, () => 0.5)
    const dueAt = loadStats(ME).queued.identity_created!.dueAt
    expect(dueAt).toBeGreaterThanOrEqual(T0 + LO)
    expect(dueAt).toBeLessThan(T0 + HI)
    expect(takeDue(ME, dueAt - 1)).toEqual([])
    expect(takeDue(ME, dueAt)).toEqual(['identity_created'])
  })

  it('survives "sessions": still due after a long close, sent once, then never again', () => {
    queueStat(ME, 'identity_created', T0, () => 0)
    // The app was closed for three days: the next unlock finds it due.
    const later = T0 + 3 * 86_400_000
    expect(takeDue(ME, later)).toEqual(['identity_created'])
    noteToSend(ME, 'identity_created', later)
    recordDelivery(ME, 'identity_created', [...DEFAULT_RELAYS])
    expect(takeDue(ME, later)).toEqual([])
    queueStat(ME, 'identity_created', later)      // happens again: once per identity
    expect(loadStats(ME).queued.identity_created).toBeUndefined()
    expect(loadStats(ME).done.identity_created).toBe('sent')
  })

  it('a note that failed stays queued and is retried on the next check', () => {
    queueStat(ME, 'wallet_connected', T0, () => 0)
    expect(takeDue(ME, T0 + HI)).toEqual(['wallet_connected'])
    expect(takeDue(ME, T0 + HI + 600_000)).toEqual(['wallet_connected'])   // not marked sent: still there
  })

  it('the first send goes to every default relay and every COUNT relay', () => {
    queueStat(ME, 'identity_created', T0, () => 0)
    const send = noteToSend(ME, 'identity_created', T0 + LO)!
    expect(new Set(send.relays)).toEqual(new Set([...DEFAULT_RELAYS, ...COUNT_RELAYS]))
    expect(send.event.tags[0][1]).toBe(statTag('identity_created'))
  })

  it('stays queued until EVERY COUNT relay holds it, resending the SAME note only to those missing it', () => {
    queueStat(ME, 'identity_created', T0, () => 0)
    const first = noteToSend(ME, 'identity_created', T0 + LO)!
    // One COUNT relay (say damus, rate-limiting us) did not take it.
    const missingOne = COUNT_RELAYS[COUNT_RELAYS.length - 1]
    const r1 = recordDelivery(ME, 'identity_created', first.relays.filter(u => u !== missingOne))
    expect(r1).toEqual({ done: false, missing: [missingOne] })
    expect(takeDue(ME, T0 + LO + 600_000)).toEqual(['identity_created'])
    const again = noteToSend(ME, 'identity_created', T0 + LO + 600_000)!
    expect(again.relays).toEqual([missingOne])
    expect(again.event.id).toBe(first.event.id)          // the same bytes: a relay dedupes, never counts twice
    expect(recordDelivery(ME, 'identity_created', [missingOne])).toEqual({ done: true, missing: [] })
    expect(loadStats(ME).done.identity_created).toBe('sent')
    expect(takeDue(ME, T0 + 2 * HI)).toEqual([])
  })

  it('the kept note survives a reload of the store (a later session resends the same note)', () => {
    queueStat(ME, 'wallet_connected', T0, () => 0)
    const first = noteToSend(ME, 'wallet_connected', T0 + LO)!
    recordDelivery(ME, 'wallet_connected', [])
    expect(noteToSend(ME, 'wallet_connected', T0 + LO + 86_400_000)!.event.id).toBe(first.event.id)
  })

  it('out of time: on some relays counts as sent, on none is dropped', () => {
    queueStat(ME, 'identity_created', T0, () => 0)
    noteToSend(ME, 'identity_created', T0 + LO)
    recordDelivery(ME, 'identity_created', [COUNT_RELAYS[0]])
    expect(takeDue(ME, T0 + LO + STAT_GIVE_UP_MS + 1)).toEqual([])
    expect(loadStats(ME).done.identity_created).toBe('sent')
  })

  it('gives up (dropped, never sent) on a note still unsent long after it was due', () => {
    queueStat(ME, 'identity_created', T0, () => 0)
    expect(takeDue(ME, T0 + LO + STAT_GIVE_UP_MS + 1)).toEqual([])
    expect(loadStats(ME).done.identity_created).toBe('dropped')
    queueStat(ME, 'identity_created', T0 + LO + STAT_GIVE_UP_MS + 2)
    expect(loadStats(ME).queued.identity_created).toBeUndefined()
  })

  it('is per identity', () => {
    queueStat(ME, 'identity_created', T0)
    expect(loadStats(OTHER).queued.identity_created).toBeUndefined()
  })

  it('is sealed under the chat key, not stored in the clear', () => {
    queueStat(ME, 'identity_created', T0)
    expect(localStorage.getItem(`caravel.stats.v1.${ME}`)).not.toContain('identity_created')
  })
})
