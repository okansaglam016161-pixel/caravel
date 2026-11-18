// The anonymous usage count, on the device: the note itself, and the per-identity queue that holds
// it until its random delay has passed.
//
// THE NOTE carries nothing about the person: a fresh random key used once, an empty content, the
// `d` tag naming the event, and the date rounded down to the day it is SENT (not the day it
// happened). See config/stats.ts.
//
// THE QUEUE is per chat identity and sealed with the chat key, like every other messaging store, so
// it only exists while chat is unlocked and leaves no plain trace on the device. Each kind goes out
// at most once per identity on this device:
//
//   queued   waiting for its dueAt (2 to 6 hours after the event, at random)
//   sent     published to at least one relay
//   skipped  happened while "Count me anonymously" was off, or was switched off while queued
//   dropped  could not be sent within STAT_GIVE_UP_MS of being due
//
// Nothing that is skipped or dropped is ever sent later: switching the setting back on does not
// backfill.

import { finalizeEvent, generateSecretKey, type NostrEvent } from 'nostr-tools/pure'
import { asRecord, loadStore, writeStore, type Parse } from '../crypto/storeIo'
import { STAT_DELAY_MS, STAT_GIVE_UP_MS, STAT_NOTE_KIND, statTag, type StatKind } from '../config/stats'

const KINDS: readonly StatKind[] = ['identity_created', 'wallet_connected']

export interface StatsState {
  /** "Count me anonymously" switched off. On by default. */
  optOut: boolean
  queued: Partial<Record<StatKind, { dueAt: number }>>
  done: Partial<Record<StatKind, 'sent' | 'skipped' | 'dropped'>>
}

const EMPTY = (): StatsState => ({ optOut: false, queued: {}, done: {} })

function key(myPubkeyHex: string) { return `caravel.stats.v1.${myPubkeyHex}` }

const parse: Parse<StatsState> = decoded => {
  const r = asRecord(decoded)
  if (r === null) return null
  const out = EMPTY()
  out.optOut = r.optOut === true
  const queued = asRecord(r.queued) ?? {}
  const done = asRecord(r.done) ?? {}
  for (const k of KINDS) {
    const q = asRecord(queued[k])
    if (q && typeof q.dueAt === 'number' && Number.isFinite(q.dueAt)) out.queued[k] = { dueAt: q.dueAt }
    const d = done[k]
    if (d === 'sent' || d === 'skipped' || d === 'dropped') out.done[k] = d
  }
  return out
}

export function loadStats(me: string): StatsState {
  return loadStore(key(me), parse, EMPTY)
}

function save(me: string, s: StatsState): void {
  writeStore(key(me), JSON.stringify(s), parse)
}

/**
 * Record that `kind` happened. Queued for a random time within STAT_DELAY_MS — unless it was
 * already queued or done, or counting is off (then it is marked skipped, never sent).
 */
export function queueStat(me: string, kind: StatKind, now = Date.now(), random = Math.random): void {
  const s = loadStats(me)
  if (s.done[kind] || s.queued[kind]) return
  if (s.optOut) {
    s.done[kind] = 'skipped'
  } else {
    const [lo, hi] = STAT_DELAY_MS
    s.queued[kind] = { dueAt: now + lo + Math.floor(random() * (hi - lo)) }
  }
  save(me, s)
}

/** The Profile switch. Off clears the queue (skipped, never sent); on does not backfill. */
export function setCountMe(me: string, on: boolean): void {
  const s = loadStats(me)
  s.optOut = !on
  if (!on) {
    for (const k of KINDS) if (s.queued[k]) { delete s.queued[k]; s.done[k] = 'skipped' }
  }
  save(me, s)
}

/** Kinds whose time has come, oldest first. Gives up (dropped) on any past STAT_GIVE_UP_MS. */
export function takeDue(me: string, now = Date.now()): StatKind[] {
  const s = loadStats(me)
  if (s.optOut) return []
  let changed = false
  const due: { k: StatKind; at: number }[] = []
  for (const k of KINDS) {
    const q = s.queued[k]
    if (!q || q.dueAt > now) continue
    if (now - q.dueAt > STAT_GIVE_UP_MS) { delete s.queued[k]; s.done[k] = 'dropped'; changed = true; continue }
    due.push({ k, at: q.dueAt })
  }
  if (changed) save(me, s)
  return due.sort((a, b) => a.at - b.at).map(d => d.k)
}

export function markSent(me: string, kind: StatKind): void {
  const s = loadStats(me)
  delete s.queued[kind]
  s.done[kind] = 'sent'
  save(me, s)
}

/** UTC midnight of `now`, in seconds — the note's only date. */
export function dayStart(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) * 86_400
}

/** The note: kind 30078, `d` = the tag, empty content, a key made for this note alone. */
export function buildStatNote(kind: StatKind, nowMs = Date.now(), tagPrefix?: string, secretKey: Uint8Array = generateSecretKey()): NostrEvent {
  return finalizeEvent({
    kind: STAT_NOTE_KIND,
    created_at: dayStart(nowMs),
    tags: [['d', statTag(kind, tagPrefix)], ['alt', 'Anonymous Caravel usage count']],
    content: '',
  }, secretKey)
}
