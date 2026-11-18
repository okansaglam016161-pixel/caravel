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
//   queued   waiting for its dueAt (2 to 6 hours after the event, at random); then, once signed,
//            waiting for every COUNT relay to hold it
//   sent     on every COUNT relay (or on some of them when the give-up time came)
//   skipped  happened while "Count me anonymously" was off, or was switched off while queued
//   dropped  could not be sent within STAT_GIVE_UP_MS of being due
//
// Nothing that is skipped or dropped is ever sent later: switching the setting back on does not
// backfill.
//
// ONE NOTE, RESENT UNTIL EVERY COUNT RELAY HAS IT. The landing count is the HIGHEST relay's number,
// so a note only counts if it is on that relay: it has to reach all of them. The note is signed once
// and kept (sealed) with the relays that accepted it; later checks resend the SAME bytes to the
// COUNT relays still missing it. Relays drop exact duplicates, so a resend can never count twice.
// (A fresh note with a fresh key would.) The first send goes to every default relay as well.

import { finalizeEvent, generateSecretKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import { asRecord, loadStore, writeStore, type Parse } from '../crypto/storeIo'
import { COUNT_RELAYS, STAT_DELAY_MS, STAT_GIVE_UP_MS, STAT_NOTE_KIND, statTag, type StatKind } from '../config/stats'
import { DEFAULT_RELAYS } from '../config/relays'

const KINDS: readonly StatKind[] = ['identity_created', 'wallet_connected']

export interface StatsState {
  /** "Count me anonymously" switched off. On by default. */
  optOut: boolean
  queued: Partial<Record<StatKind, QueuedNote>>
  done: Partial<Record<StatKind, 'sent' | 'skipped' | 'dropped'>>
}

export interface QueuedNote {
  dueAt: number
  /** Signed at the first send and kept, so every resend is the same note. */
  event?: NostrEvent
  /** Relays that have accepted it. */
  accepted?: string[]
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
    if (q && typeof q.dueAt === 'number' && Number.isFinite(q.dueAt)) {
      const note: QueuedNote = { dueAt: q.dueAt }
      const ev = q.event as NostrEvent | undefined
      if (ev && typeof ev === 'object' && verifyEvent(ev)) note.event = ev
      if (Array.isArray(q.accepted)) note.accepted = q.accepted.filter((u): u is string => typeof u === 'string')
      out.queued[k] = note
    }
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
    if (now - q.dueAt > STAT_GIVE_UP_MS) {
      // Out of time: on some relays already counts as sent; on none, it is dropped.
      delete s.queued[k]; s.done[k] = q.accepted?.length ? 'sent' : 'dropped'; changed = true; continue
    }
    due.push({ k, at: q.dueAt })
  }
  if (changed) save(me, s)
  return due.sort((a, b) => a.at - b.at).map(d => d.k)
}

/**
 * The note to send for a due `kind`, and where: signed now if this is its first send (and kept), to
 * every default relay plus the COUNT relays; afterwards only to the COUNT relays still missing it.
 */
export function noteToSend(me: string, kind: StatKind, now = Date.now()): { event: NostrEvent; relays: string[] } | null {
  const s = loadStats(me)
  const q = s.queued[kind]
  if (!q || s.optOut) return null
  if (!q.event) {
    q.event = buildStatNote(kind, now)
    save(me, s)
  }
  const accepted = new Set(q.accepted ?? [])
  const relays = q.accepted
    ? COUNT_RELAYS.filter(u => !accepted.has(u))
    : [...new Set([...DEFAULT_RELAYS, ...COUNT_RELAYS])]
  return { event: q.event, relays }
}

/**
 * Record where the note landed. Done (`sent`) once every COUNT relay holds it; otherwise it stays
 * queued and the next check resends it to the missing ones.
 */
export function recordDelivery(me: string, kind: StatKind, acceptedBy: readonly string[]): { done: boolean; missing: string[] } {
  const s = loadStats(me)
  const q = s.queued[kind]
  if (!q) return { done: s.done[kind] === 'sent', missing: [] }
  const accepted = new Set([...(q.accepted ?? []), ...acceptedBy])
  q.accepted = [...accepted]
  const missing = COUNT_RELAYS.filter(u => !accepted.has(u))
  if (missing.length === 0) {
    delete s.queued[kind]
    s.done[kind] = 'sent'
  }
  save(me, s)
  return { done: missing.length === 0, missing }
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
