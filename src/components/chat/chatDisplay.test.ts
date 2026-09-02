// Tests for the media box geometry (images M4).
//
// This is the one piece of the render path that is both pure and load-bearing: the same box is drawn
// in every state, so if it computes a different size once the image is ready, the thread jumps under
// the user's scroll. Everything else about the card — object URLs, <img> decode, IndexedDB through
// React — needs a real browser and is covered by the two-browser test instead.

import { describe, expect, it } from 'vitest'
import { isNewDay, mediaBoxSize, mediaFilename, mergeThreadItems, threadContentKey, type ThreadItem } from './chatDisplay'

const MAX_W = 320
const MAX_H = 400
const box = (w: number, h: number) => mediaBoxSize(w, h, MAX_W, MAX_H)

describe('mediaBoxSize', () => {
  it('fits a landscape image to the width bound, preserving aspect', () => {
    expect(box(1600, 1200)).toEqual({ w: 320, h: 240 })
  })

  it('fits a portrait image to the HEIGHT bound when the aspect demands it', () => {
    // 1200x1600 scaled to w=320 would be h=427, past the 400 ceiling — so height binds instead.
    const { w, h } = box(1200, 1600)
    expect(h).toBe(400)
    expect(w).toBe(300)
  })

  it('never exceeds either bound, for any plausible photo shape', () => {
    for (const [w0, h0] of [[4000, 3000], [3000, 4000], [1000, 1000], [5000, 400], [400, 5000]]) {
      const { w, h } = box(w0, h0)
      expect(w).toBeLessThanOrEqual(MAX_W)
      expect(h).toBeLessThanOrEqual(MAX_H)
    }
  })

  it('preserves the aspect ratio within a pixel of rounding', () => {
    const { w, h } = box(1600, 1200)
    expect(Math.abs(w / h - 1600 / 1200)).toBeLessThan(0.01)
  })

  it('never upscales a small image', () => {
    expect(box(120, 90)).toEqual({ w: 120, h: 90 })
  })

  it('falls back to 4:3 for a ref with no dimensions', () => {
    // extractMedia lets a dimensionless ref through — a missing width does not stop an image being
    // fetched and decrypted, so it must still get a sensible box.
    expect(box(0, 0)).toEqual({ w: 320, h: 240 })
    expect(box(-5, 100)).toEqual({ w: 320, h: 240 })
    expect(box(NaN, NaN)).toEqual({ w: 320, h: 240 })
  })

  it('never collapses a side to zero on an extreme aspect ratio', () => {
    // A 5000x3 banner: naive rounding gives a zero-height box, which would collapse the frame and
    // reintroduce exactly the layout jump this function prevents.
    const wide = box(5000, 3)
    expect(wide.h).toBeGreaterThanOrEqual(1)
    const tall = box(3, 5000)
    expect(tall.w).toBeGreaterThanOrEqual(1)
  })

  it('returns whole pixels', () => {
    const { w, h } = box(1999, 1001)
    expect(Number.isInteger(w)).toBe(true)
    expect(Number.isInteger(h)).toBe(true)
  })

  it('is deterministic — the loading box and the ready box are identical', () => {
    // The entire point: the size cannot depend on anything that changes between states.
    expect(box(1600, 1200)).toEqual(box(1600, 1200))
  })
})

// ── Thread ordering (images M4 follow-up) ─────────────────────────────────────
//
// Pending bubbles used to render in a separate pass AFTER the messages, which pinned them to the
// bottom of the thread. Fine while a send is in flight — it IS the newest thing — but a FAILED entry
// lingers, and every later message pushed it further out of place until it sat below messages sent
// long after it. These assert the ordering rule that fixes it.

const m = (id: string, timestamp: number) => ({ id, timestamp })
const p = (id: string, attemptedAt: number) => ({ id, attemptedAt })
// Generic rather than ReturnType<typeof mergeThreadItems>, which erases the type parameters down to
// their constraints and loses `id`.
function ids<M extends { id: string; timestamp: number }, P extends { id: string; attemptedAt: number }>(
  items: ThreadItem<M, P>[],
): string[] {
  return items.map(i => (i.kind === 'message' ? i.message : i.pending).id)
}

describe('mergeThreadItems', () => {
  it('interleaves a failed send back into its chronological position', () => {
    // THE BUG: without this, 'failed' renders after 'later' no matter how much later 'later' is.
    const merged = mergeThreadItems([m('early', 100), m('later', 300)], [p('failed', 200)])
    expect(ids(merged)).toEqual(['early', 'failed', 'later'])
  })

  it('still puts an in-flight send at the bottom, with no special-casing', () => {
    // A 'sending' entry is by construction the newest, so one ordering rule covers both statuses.
    const merged = mergeThreadItems([m('a', 100), m('b', 200)], [p('sending-now', 999)])
    expect(ids(merged)).toEqual(['a', 'b', 'sending-now'])
  })

  it('orders several pending entries among several messages', () => {
    const merged = mergeThreadItems(
      [m('m1', 100), m('m2', 300), m('m3', 500)],
      [p('p1', 200), p('p2', 400)],
    )
    expect(ids(merged)).toEqual(['m1', 'p1', 'm2', 'p2', 'm3'])
  })

  it('puts a real message before a pending one at the SAME instant', () => {
    // Deliberate, not incidental: a real row beats a provisional one for the same moment. Relies on
    // Array.prototype.sort being stable and messages being concatenated first.
    expect(ids(mergeThreadItems([m('real', 500)], [p('prov', 500)]))).toEqual(['real', 'prov'])
  })

  it('tags each item so the caller can render the right component', () => {
    const merged = mergeThreadItems([m('a', 1)], [p('b', 2)])
    expect(merged.map(i => i.kind)).toEqual(['message', 'pending'])
  })

  it('handles either side being empty', () => {
    expect(ids(mergeThreadItems([m('a', 1), m('b', 2)], []))).toEqual(['a', 'b'])
    expect(ids(mergeThreadItems([], [p('x', 1)]))).toEqual(['x'])
    expect(mergeThreadItems([], [])).toEqual([])
  })

  it('does not mutate its inputs', () => {
    // The messages array is memoised upstream and shared; sorting it in place would corrupt it.
    const messages = [m('b', 200), m('a', 100)]
    const pending = [p('x', 150)]
    mergeThreadItems(messages, pending)
    expect(messages.map(x => x.id)).toEqual(['b', 'a'])
    expect(pending.map(x => x.id)).toEqual(['x'])
  })

  it('sorts messages that arrive out of order', () => {
    expect(ids(mergeThreadItems([m('late', 300), m('early', 100)], []))).toEqual(['early', 'late'])
  })
})

describe('threadContentKey — the auto-scroll trigger', () => {
  const send = (status: string) => ({ status })

  it('CHANGES across the swap of a provisional bubble for the real row', () => {
    // THE BUG. `messages.length + pending.length` is identical either side of a successful send, so
    // the scroll fired for the pending bubble and never again. Text survived it because both bubbles
    // are the same height; an image swapped a filename bubble for a card up to 400px tall.
    const whileSending = threadContentKey(new Array(5), [send('sending')])
    const afterSuccess = threadContentKey(new Array(6), [])
    expect(whileSending).not.toBe(afterSuccess)
  })

  it('changes when a provisional bubble first appears', () => {
    expect(threadContentKey(new Array(5), [])).not.toBe(threadContentKey(new Array(5), [send('sending')]))
  })

  it('changes when a send FAILS, so the taller failed bubble is scrolled into view', () => {
    // 'sending' → 'failed' moves neither count, but the bubble grows by a label, a hint and buttons.
    expect(threadContentKey(new Array(5), [send('sending')]))
      .not.toBe(threadContentKey(new Array(5), [send('failed')]))
  })

  it('changes when a message is received', () => {
    expect(threadContentKey(new Array(5), [])).not.toBe(threadContentKey(new Array(6), []))
  })

  it('is STABLE when nothing changed, so the thread is not yanked on every render', () => {
    expect(threadContentKey(new Array(5), [send('sending')])).toBe(threadContentKey(new Array(5), [send('sending')]))
    expect(threadContentKey([], [])).toBe(threadContentKey([], []))
  })

  it('distinguishes several pending rows from one', () => {
    expect(threadContentKey(new Array(2), [send('sending')]))
      .not.toBe(threadContentKey(new Array(2), [send('sending'), send('sending')]))
  })

  it('does not collide across the counts that used to sum equal', () => {
    // 5 messages + 1 pending vs 6 messages + 0 pending summed to the same number. They must not.
    expect(threadContentKey(new Array(5), [send('failed')])).not.toBe(threadContentKey(new Array(6), []))
  })
})

describe('mediaFilename', () => {
  // 2026-08-16 21:03:07 local
  const TS = new Date(2026, 7, 16, 21, 3, 7).getTime()

  it('names a file from the message timestamp and the MIME type', () => {
    expect(mediaFilename('image/webp', TS)).toBe('caravel-2026-08-16-210307.webp')
  })

  it('maps each supported MIME to its conventional extension', () => {
    expect(mediaFilename('image/jpeg', TS)).toMatch(/\.jpg$/)   // .jpg, not .jpeg
    expect(mediaFilename('image/png', TS)).toMatch(/\.png$/)
    expect(mediaFilename('image/gif', TS)).toMatch(/\.gif$/)
  })

  it('is case-insensitive about the MIME type', () => {
    expect(mediaFilename('IMAGE/WEBP', TS)).toMatch(/\.webp$/)
  })

  it('falls back to a neutral extension for an unknown or missing type', () => {
    // A ref can carry application/octet-stream (extractMedia's default) — better a generic name than
    // a wrong one claiming to be a webp.
    expect(mediaFilename('application/octet-stream', TS)).toMatch(/\.img$/)
    expect(mediaFilename('', TS)).toMatch(/\.img$/)
  })

  it('is STABLE for the same message — saving twice offers the same name', () => {
    // Derived from the message timestamp, not from Date.now(), which is the whole point.
    expect(mediaFilename('image/webp', TS)).toBe(mediaFilename('image/webp', TS))
  })

  it('zero-pads so names sort chronologically in a file listing', () => {
    const early = new Date(2026, 0, 5, 4, 5, 6).getTime()
    expect(mediaFilename('image/webp', early)).toBe('caravel-2026-01-05-040506.webp')
  })

  it('contains nothing hostile to a filesystem', () => {
    // No slashes, colons or spaces — a colon alone would break the save on macOS.
    expect(mediaFilename('image/webp', TS)).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('distinguishes two images sent a second apart', () => {
    expect(mediaFilename('image/webp', TS)).not.toBe(mediaFilename('image/webp', TS + 1000))
  })
})

// ── Day grouping (stage 4) ──────────────────────────────────────────────────────
//
// isNewDay decides where a "TODAY" divider goes. It compares LOCAL CALENDAR DAYS, so the cases that
// matter are the ones a duration test would get wrong: a few minutes that cross midnight (new day)
// and most of a day that does not (same day). Built from local Date components rather than epoch
// literals so the suite does not depend on the runner's timezone.
//
// dayLabel is deliberately NOT tested — it calls toLocaleDateString, exactly like compactTime and
// bubbleTime, which this file has never covered for the same reason.

describe('isNewDay — the day-divider boundary', () => {
  const at = (y: number, m: number, d: number, hh = 12, mm = 0) => new Date(y, m, d, hh, mm).getTime()

  it('is false for two moments in the same calendar day', () => {
    expect(isNewDay(at(2026, 2, 4, 0, 1), at(2026, 2, 4, 23, 59))).toBe(false)
  })

  it('is true across midnight, even minutes apart', () => {
    expect(isNewDay(at(2026, 2, 4, 23, 58), at(2026, 2, 5, 0, 2))).toBe(true)
  })

  it('is false for 23 hours that stay inside one day', () => {
    expect(isNewDay(at(2026, 2, 4, 0, 30), at(2026, 2, 4, 23, 30))).toBe(false)
  })

  it('is true across a month boundary', () => {
    expect(isNewDay(at(2026, 2, 31, 22, 0), at(2026, 3, 1, 1, 0))).toBe(true)
  })

  it('is true across a year boundary', () => {
    expect(isNewDay(at(2026, 11, 31, 23, 0), at(2027, 0, 1, 1, 0))).toBe(true)
  })

  it('distinguishes the same date in different years', () => {
    expect(isNewDay(at(2025, 2, 4), at(2026, 2, 4))).toBe(true)
  })

  it('is symmetric — order does not change whether a boundary was crossed', () => {
    const a = at(2026, 2, 4, 23, 58)
    const b = at(2026, 2, 5, 0, 2)
    expect(isNewDay(a, b)).toBe(isNewDay(b, a))
  })
})
