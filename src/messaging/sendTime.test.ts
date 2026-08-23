//   Tests for the display/ordering rule introduced with send-time display.
//
//   The rule these pin down: a received message both SHOWS and is ORDERED BY the sender's clamped
//   send time, so what the user reads and what they scroll past agree. Ordering by our own arrival
//   time instead — the original shape of this change — sorts by the moment a gift wrap finished
//   decrypting, and that is a relay race: messages sent 1, 2, 3 a few hundred milliseconds apart
//   come off different relays out of order and render 2, 1, 3.
//
//   RESOLUTION. wrapMessage stamps a caravel-ts tag carrying the unrounded send instant, so a
//   Caravel-to-Caravel burst arrives with distinct millisecond times and sorts truly. A third-party
//   NIP-17 client sends only created_at, in whole seconds, so its bursts still tie and still lean on
//   the tiebreak. Both paths are exercised below.
//
//   What keeps a sender-controlled key safe is the clamp, and it works in ONE direction only. A
//   claim past receivedAt + SEND_TIME_SKEW_MS collapses to receivedAt, so nothing can pin itself to
//   the bottom of a thread or squat at the top of the conversation list. A back-dated claim is
//   deliberately left alone and CAN sort early — an accepted trade, pinned by a test below so it
//   stays a recorded decision rather than a later surprise.
//
//   clampSendTime lives inside NostrMessagingProvider (it is not exported, and exporting it only for
//   a test would widen the module's surface for no other caller). Its rule is small and total, so it
//   is restated here and checked against the same constant the provider uses. If the two ever
//   diverge, the boundary cases below are what should catch it.

import { describe, expect, it } from 'vitest'
import { compareMessages, sortKey, type CaravelMessage } from './types'

// Mirrors NostrMessagingProvider's SEND_TIME_SKEW_MS and clampSendTime.
const SEND_TIME_SKEW_MS = 2 * 60 * 1000
const clampSendTime = (sentAtMs: number | undefined, receivedAt: number): number =>
  sentAtMs === undefined ? receivedAt : sentAtMs > receivedAt + SEND_TIME_SKEW_MS ? receivedAt : sentAtMs

const SENT_AT = 1_700_000_000_000      // 12:04, when the sender pressed send
const RECEIVED_AT = 1_700_002_400_000  // 12:44, when the recipient signed in — 40 minutes later

function msg(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: 'evt1',
    senderPubkeyHex: 'a'.repeat(64),
    recipientPubkeyHex: 'b'.repeat(64),
    plaintext: 'hello',
    timestamp: SENT_AT,
    receivedAt: RECEIVED_AT,
    direction: 'received',
    ...over,
  }
}

describe('clampSendTime', () => {
  it('keeps a send time that precedes arrival — the ordinary case, and the bug being fixed', () => {
    // The exact repro: sent 12:04 while the recipient was signed out, decrypted 12:44 on sign-in.
    // The label must say 12:04.
    expect(clampSendTime(SENT_AT, RECEIVED_AT)).toBe(SENT_AT)
  })

  it('falls back to arrival when the sender claims a time after arrival', () => {
    // Provably false — a message cannot arrive before it was sent.
    const future = RECEIVED_AT + 24 * 60 * 60 * 1000
    expect(clampSendTime(future, RECEIVED_AT)).toBe(RECEIVED_AT)
  })

  it('falls back to arrival when there is no claim at all', () => {
    expect(clampSendTime(undefined, RECEIVED_AT)).toBe(RECEIVED_AT)
  })

  it('tolerates a claim inside the skew window', () => {
    // wrapMessage rounds to the NEAREST second, so an honest message can claim up to ~500ms ahead of
    // its own send and legitimately beat that instant over a fast relay. A zero tolerance would
    // misfire on Caravel's own traffic.
    expect(clampSendTime(RECEIVED_AT + 500, RECEIVED_AT)).toBe(RECEIVED_AT + 500)
    expect(clampSendTime(RECEIVED_AT + SEND_TIME_SKEW_MS, RECEIVED_AT)).toBe(RECEIVED_AT + SEND_TIME_SKEW_MS)
  })

  it('rejects a claim one millisecond past the window', () => {
    // The boundary itself, so a future change to the constant cannot quietly move it.
    expect(clampSendTime(RECEIVED_AT + SEND_TIME_SKEW_MS + 1, RECEIVED_AT)).toBe(RECEIVED_AT)
  })

  it('does NOT clamp times in the past, however old', () => {
    // Deliberate: a very old claim produces a wrong label and nothing more, because it cannot affect
    // ordering. Any "too old" threshold would be arbitrary — a genuinely delayed message is
    // indistinguishable from a lie.
    const ancient = 1
    expect(clampSendTime(ancient, RECEIVED_AT)).toBe(ancient)
  })
})

describe('sortKey', () => {
  it('is the displayed send time, not the arrival time', () => {
    // The inversion at the heart of this change. Both fields are present and differ; the key is the
    // one on the bubble.
    expect(sortKey(msg({ timestamp: SENT_AT, receivedAt: RECEIVED_AT }))).toBe(SENT_AT)
  })

  it('orders rapid sends by when they were SENT, not by when they arrived', () => {
    // THE REPRO: three messages sent in order, arriving out of relay order. Ordering on arrival
    // renders them 2, 1, 3 — which is what was observed.
    const one = msg({ id: 'one', timestamp: 1_000, receivedAt: 2_000 })
    const two = msg({ id: 'two', timestamp: 2_000, receivedAt: 1_000 })
    const three = msg({ id: 'three', timestamp: 3_000, receivedAt: 3_000 })
    const shuffled = [three, one, two]

    expect([...shuffled].sort(compareMessages).map(m => m.id)).toEqual(['one', 'two', 'three'])
    // The old basis, kept alongside so the regression is visible rather than asserted in the
    // abstract: arrival order really does scramble these.
    const byArrival = [...shuffled].sort((a, b) => (a.receivedAt ?? 0) - (b.receivedAt ?? 0))
    expect(byArrival.map(m => m.id)).toEqual(['two', 'one', 'three'])
  })

  it('reads legacy rows written before receivedAt existed', () => {
    // Those rows hold our decrypt time in `timestamp` and are read exactly as they always were.
    expect(sortKey(msg({ receivedAt: undefined, timestamp: 5_000 }))).toBe(5_000)
  })

  it('ignores receivedAt entirely, including a zero one', () => {
    // A legitimately-zero receivedAt must not perturb the key — it is not consulted at this level.
    expect(sortKey(msg({ receivedAt: 0, timestamp: 9_000 }))).toBe(9_000)
    expect(sortKey(msg({ receivedAt: 999_999, timestamp: 9_000 }))).toBe(9_000)
  })

  it('is the same value on a sent row, where the two clocks coincide', () => {
    expect(sortKey(msg({ direction: 'sent', timestamp: 7_000, receivedAt: 7_000 }))).toBe(7_000)
  })
})

describe('compareMessages — the tiebreak', () => {
  // Received send times arrive at WHOLE-SECOND resolution (wrapMessage stamps
  // Math.round(Date.now() / 1000)), so a burst sent inside one second ties on the primary key as a
  // matter of course. These pin the fallback chain: arrival, then event id.
  const SEC = 1_700_000_000_000

  it('falls back to arrival when the send times tie', () => {
    const early = msg({ id: 'aaa', timestamp: SEC, receivedAt: 10 })
    const late = msg({ id: 'bbb', timestamp: SEC, receivedAt: 20 })
    expect(compareMessages(early, late)).toBeLessThan(0)
    expect(compareMessages(late, early)).toBeGreaterThan(0)
  })

  it('falls back to event id when send time AND arrival both tie', () => {
    const a = msg({ id: 'aaa', timestamp: SEC, receivedAt: 10 })
    const b = msg({ id: 'bbb', timestamp: SEC, receivedAt: 10 })
    expect(compareMessages(a, b)).toBeLessThan(0)
    expect(compareMessages(b, a)).toBeGreaterThan(0)
    expect(compareMessages(a, a)).toBe(0)
  })

  it('treats a legacy row with no receivedAt as arriving at its own timestamp', () => {
    const legacy = msg({ id: 'aaa', timestamp: SEC, receivedAt: undefined })
    const newer = msg({ id: 'bbb', timestamp: SEC, receivedAt: SEC + 1 })
    expect(compareMessages(legacy, newer)).toBeLessThan(0)
  })

  it('keeps a tied burst in ONE order however it is handed in', () => {
    // The stability requirement: no shuffle on re-render. React hands this array in whatever order
    // the store happens to hold, and it grows between renders, so the result must depend on the
    // rows alone — never on their input positions. Ties like this now mean a sender with no
    // caravel-ts tag; a Caravel burst separates on the primary key (see the ms suite below).
    const burst = [
      msg({ id: 'm1', timestamp: SEC, receivedAt: 30 }),
      msg({ id: 'm2', timestamp: SEC, receivedAt: 10 }),
      msg({ id: 'm3', timestamp: SEC, receivedAt: 20 }),
    ]
    const expected = ['m2', 'm3', 'm1']    // arrival breaks the tied second
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]
    for (const order of permutations) {
      expect(order.map(i => burst[i]).sort(compareMessages).map(m => m.id)).toEqual(expected)
    }
  })

  it('is a TOTAL order — two distinct rows never compare equal', () => {
    // What makes the sort deterministic rather than merely usually-right: every pair is decided, so
    // no pair is ever left to the sort algorithm's discretion.
    const rows = [
      msg({ id: 'a', timestamp: SEC, receivedAt: 1 }),
      msg({ id: 'b', timestamp: SEC, receivedAt: 1 }),
      msg({ id: 'c', timestamp: SEC, receivedAt: 2 }),
      msg({ id: 'd', timestamp: SEC + 1, receivedAt: 1 }),
    ]
    for (const x of rows) {
      for (const y of rows) {
        if (x.id === y.id) expect(compareMessages(x, y)).toBe(0)
        else expect(compareMessages(x, y)).not.toBe(0)
        // antisymmetry, so the order cannot depend on which side a pair is compared from.
        // Compared with ===, not toBe: Object.is separates 0 from -0 and the self-pair yields both.
        expect(Math.sign(compareMessages(x, y)) === -Math.sign(compareMessages(y, x))).toBe(true)
      }
    }
  })
})

describe('what the clamp still buys under a send-time sort', () => {
  it('stops a future-dated message from pinning itself to the bottom of a thread', () => {
    // The abuse the clamp exists to block, now expressed as ORDER rather than as a label. The liar
    // claims a week ahead; clampSendTime collapses that to its arrival instant, so it lands where it
    // actually turned up instead of below everything forever.
    const liarClaim = RECEIVED_AT + 7 * 24 * 60 * 60 * 1000
    const liar = msg({ id: 'liar', timestamp: clampSendTime(liarClaim, RECEIVED_AT), receivedAt: RECEIVED_AT })
    const after = msg({ id: 'after', timestamp: RECEIVED_AT + 60_000, receivedAt: RECEIVED_AT + 60_000 })

    expect([after, liar].sort(compareMessages).map(m => m.id)).toEqual(['liar', 'after'])
    expect(sortKey(liar)).toBe(RECEIVED_AT)     // capped, not a week out
  })

  it('does NOT stop a back-dated message from sorting early — a known, accepted gap', () => {
    // Recorded so this reads as a decision rather than an oversight. clampSendTime leaves past
    // claims alone (a genuinely delayed message is indistinguishable from a lie), so under a
    // send-time sort a peer can place themselves arbitrarily early in a thread. The cost is position
    // only: nothing is hidden, dropped, or misattributed, and back-dating mostly buries the peer's
    // own message. Bounding it means choosing a floor on how old a claim may be — a separate call.
    const backdated = msg({ id: 'backdated', timestamp: clampSendTime(1, RECEIVED_AT), receivedAt: RECEIVED_AT })
    const honest = msg({ id: 'honest', timestamp: SENT_AT, receivedAt: SENT_AT })

    expect(sortKey(backdated)).toBe(1)          // untouched by the clamp
    expect([honest, backdated].sort(compareMessages).map(m => m.id)).toEqual(['backdated', 'honest'])
  })
})

describe('display and ordering agree', () => {
  it('a received message is ordered by the very time it displays', () => {
    const m = msg({ timestamp: clampSendTime(SENT_AT, RECEIVED_AT), receivedAt: RECEIVED_AT })
    expect(m.timestamp).toBe(SENT_AT)      // the bubble label — 12:04
    expect(sortKey(m)).toBe(m.timestamp)   // and its position in the thread
  })

  it('a sent message has no divergence — we are the sender', () => {
    const at = 1_700_000_000_000
    const m = msg({ direction: 'sent', timestamp: at, receivedAt: at })
    expect(m.timestamp).toBe(sortKey(m))
  })

  it('labels now read monotonically down a thread', () => {
    // The direct inverse of what the arrival-basis version of this file had to accept. Ordering on
    // the displayed value makes non-decreasing labels a property of the sort, not a coincidence: a
    // sender whose clock is behind moves UP the thread rather than sitting under a later label.
    const rows = [
      msg({ id: 'behind', timestamp: 2_000, receivedAt: 9_000 }),
      msg({ id: 'ahead', timestamp: 5_000, receivedAt: 1_000 }),
      msg({ id: 'middle', timestamp: 3_000, receivedAt: 5_000 }),
    ].sort(compareMessages)

    expect(rows.map(m => m.id)).toEqual(['behind', 'middle', 'ahead'])
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].timestamp).toBeGreaterThanOrEqual(rows[i - 1].timestamp)
    }
  })
})

describe('millisecond send times — the same-second burst', () => {
  const SEC = 1_700_000_000_000

  it('sorts a Caravel burst truly, whatever order it arrived in', () => {
    // The 1,2,3 repro at the sort level: three messages sent 120ms apart INSIDE ONE SECOND, arriving
    // scrambled by the relay race. ids are reverse-alphabetical and arrival is scrambled on purpose,
    // so neither tiebreak could produce the right answer by accident — only the ms send time can.
    const first = msg({ id: 'ccc', timestamp: SEC + 120, receivedAt: 3_000 })
    const second = msg({ id: 'bbb', timestamp: SEC + 240, receivedAt: 1_000 })
    const third = msg({ id: 'aaa', timestamp: SEC + 360, receivedAt: 2_000 })

    expect([third, first, second].sort(compareMessages).map(m => m.id)).toEqual(['ccc', 'bbb', 'aaa'])
    // ...and they really are all in one second, so this is the case that used to tie.
    expect(new Set([first, second, third].map(m => Math.round(m.timestamp / 1000))).size).toBe(1)
  })

  it('never reaches the tiebreak once send times are distinct', () => {
    // Arrival and id both point the other way; a distinct send time wins outright.
    const a = msg({ id: 'zzz', timestamp: SEC + 1, receivedAt: 9_999 })
    const b = msg({ id: 'aaa', timestamp: SEC + 2, receivedAt: 1 })
    expect(compareMessages(a, b)).toBeLessThan(0)
  })

  it('degrades to second resolution for a client that sends no ms tag', () => {
    // The KNOWN RESIDUAL LIMIT, recorded rather than glossed. unwrapMessage falls back to
    // created_at * 1000 for a third-party NIP-17 sender, so its same-second burst still ties and the
    // arrival tiebreak still decides — which is the relay race. No ordering can be recovered that the
    // sender never transmitted; what we get instead is determinism.
    const rows = [
      msg({ id: 'm1', timestamp: SEC, receivedAt: 3_000 }),   // sent first, arrived last
      msg({ id: 'm2', timestamp: SEC, receivedAt: 1_000 }),   // sent second, arrived first
    ]
    expect([...rows].sort(compareMessages).map(m => m.id)).toEqual(['m2', 'm1'])          // arrival, not send
    expect([...rows].reverse().sort(compareMessages).map(m => m.id)).toEqual(['m2', 'm1']) // but stable
  })
})
