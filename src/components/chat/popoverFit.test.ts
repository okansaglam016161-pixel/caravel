// Geometry tests for anchored popover placement (C, fix). Pure rectangles, no DOM — which is the
// point of splitting fitPopover out of the hook: the bug these cover is arithmetic, and arithmetic
// is exactly what this repo's test setup can check.

import { describe, expect, it } from 'vitest'
import { fitPopover, type AnchorSpec, type Rect } from './popoverFit'

// A thread column roughly as the app lays it out: 300px sidebar, then the chat panel, a 70px header
// above the scroller and a composer below it.
const THREAD: Rect = { top: 70, left: 300, right: 1100, bottom: 700 }

const rect = (left: number, top: number, w: number, h: number): Rect =>
  ({ left, top, right: left + w, bottom: top + h })

// A 26px action button, the real anchor size.
const button = (left: number, top: number) => rect(left, top, 26, 26)

const QUICK = { width: 230, height: 38 }
const PICKER = { width: 296, height: 300 }

const above = (align: 'left' | 'right'): AnchorSpec => ({ placement: 'above', align, offset: 36 })
// The "⋯" menu opens DOWNWARD from its button, at the 30px it was hand-positioned at before it was
// measured. ~160px wide: minWidth 150 plus its 5px padding either side.
const below = (align: 'left' | 'right'): AnchorSpec => ({ placement: 'below', align, offset: 30 })
const MORE_MENU = { width: 160, height: 44 }

// Where the panel actually lands once the correction is applied.
function placed(anchor: Rect, size: { width: number; height: number }, spec: AnchorSpec, bounds = THREAD) {
  const fit = fitPopover(anchor, size, bounds, spec)
  const left = (spec.align === 'left' ? anchor.left : anchor.right - size.width) + fit.dx
  const top = (fit.placement === 'above' ? anchor.bottom - spec.offset - size.height : anchor.top + spec.offset) + fit.dy
  return { left, right: left + size.width, top, bottom: top + size.height, ...fit }
}

const inside = (p: { left: number; right: number; top: number; bottom: number }, b = THREAD) =>
  p.left >= b.left && p.right <= b.right && p.top >= b.top && p.bottom <= b.bottom

describe('fitPopover — sent bubbles are untouched', () => {
  // A sent bubble's action row sits on the LEFT of a right-aligned bubble, deep inside the thread,
  // so a panel opening rightward has always fitted. The fix must not move it.
  it('needs no correction for the quick-set', () => {
    const anchor = button(700, 400)
    expect(fitPopover(anchor, QUICK, THREAD, above('left'))).toEqual({ dx: 0, dy: 0, placement: 'above' })
  })

  it('needs no correction for the full picker', () => {
    const anchor = button(700, 400)
    expect(fitPopover(anchor, PICKER, THREAD, above('left'))).toEqual({ dx: 0, dy: 0, placement: 'above' })
  })
})

describe('fitPopover — the reported bug: received bubble, short message', () => {
  // THE CASE THAT BROKE. A short received message puts the action button ~90px from the thread's
  // left edge; a panel pinned by its RIGHT edge then starts far outside the container, and because
  // a scroll container's scrollable region never extends leftward it was clipped rather than
  // scrollable — leaving a remnant floating up and to the right of the bubble.
  const anchor = button(390, 400)      // 90px into a thread whose content starts at x=300

  it('put the picker outside the thread before the fix', () => {
    // Uncorrected: right edge pinned to the anchor, so left = 416 - 296 = 120, well left of 300.
    const uncorrected = anchor.right - PICKER.width
    expect(uncorrected).toBeLessThan(THREAD.left)
  })

  it('slides the picker back inside, still overlapping its own button', () => {
    const p = placed(anchor, PICKER, above('right'))
    expect(inside(p)).toBe(true)
    expect(p.dx).toBeGreaterThan(0)                     // pushed right, into the thread
    // "Adjacent" is the real requirement: the panel must still cover the button it belongs to.
    expect(p.left).toBeLessThanOrEqual(anchor.left)
    expect(p.right).toBeGreaterThanOrEqual(anchor.right)
  })

  it('slides the quick-set back inside too', () => {
    const p = placed(anchor, QUICK, above('right'))
    expect(inside(p)).toBe(true)
    expect(p.left).toBeLessThanOrEqual(anchor.left)
    expect(p.right).toBeGreaterThanOrEqual(anchor.right)
  })

  it('leaves the margin intact rather than sitting flush on the edge', () => {
    expect(placed(anchor, PICKER, above('right')).left).toBe(THREAD.left + 8)
  })
})

describe('fitPopover — received bubble, long message', () => {
  // The mirror hazard, and why no FIXED side could have fixed this: a long received bubble pushes
  // the anchor toward the right edge, so opening rightward would have overflowed the other way.
  const anchor = button(1060, 400)

  it('keeps a right-pinned panel inside without needing to move much', () => {
    const p = placed(anchor, PICKER, above('right'))
    expect(inside(p)).toBe(true)
  })

  it('pulls a left-pinned panel back off the right edge', () => {
    const p = placed(anchor, PICKER, above('left'))
    expect(inside(p)).toBe(true)
    expect(p.dx).toBeLessThan(0)
    expect(p.right).toBe(THREAD.right - 8)
  })
})

describe('fitPopover — the vertical flip', () => {
  it('flips below when there is no room above (first message in the thread)', () => {
    const anchor = button(390, 100)                     // just under the 70px header
    const p = placed(anchor, PICKER, above('right'))
    expect(p.placement).toBe('below')
    expect(inside(p)).toBe(true)
  })

  it('stays above when there IS room, even near the bottom', () => {
    const anchor = button(390, 640)
    const p = placed(anchor, PICKER, above('right'))
    expect(p.placement).toBe('above')
    expect(inside(p)).toBe(true)
  })

  it('does not flip a small panel that fits above near the top', () => {
    // The quick-set is 38px tall, so it still fits where the 300px picker does not — a flip that is
    // not needed is a jump the reader has to re-follow.
    const anchor = button(390, 130)
    expect(placed(anchor, QUICK, above('right')).placement).toBe('above')
  })

  it('flips back above when asked to open below with no room below', () => {
    const anchor = button(390, 660)
    const p = placed(anchor, PICKER, { placement: 'below', align: 'right', offset: 36 })
    expect(p.placement).toBe('above')
    expect(inside(p)).toBe(true)
  })

  it('clamps instead of flipping when neither side fits', () => {
    const tight: Rect = { top: 70, left: 300, right: 1100, bottom: 400 }
    const anchor = button(390, 200)
    const p = placed(anchor, PICKER, above('right'), tight)
    // Taller than the container: pinned to the TOP, so the search box and the first rows survive.
    expect(p.top).toBe(tight.top + 8)
  })
})

describe('fitPopover — degenerate containers', () => {
  it('pins a panel wider than the container flush to its left edge', () => {
    const narrow: Rect = { top: 70, left: 300, right: 500, bottom: 700 }
    const p = placed(button(390, 400), PICKER, above('right'), narrow)
    expect(p.left).toBe(narrow.left + 8)
  })

  it('is idempotent — re-fitting an already-corrected position moves nothing', () => {
    const anchor = button(390, 400)
    const p = placed(anchor, PICKER, above('right'))
    // Feeding the corrected rect back in as if it were the baseline must produce no further shift.
    const again = fitPopover(anchor, PICKER, THREAD, above('right'))
    expect(again.dx).toBe(p.dx)
    expect(again.dy).toBe(p.dy)
  })
})

// ── The "⋯" menu on a SENT bubble ──────────────────────────────────────────
//
// The second bug of this shape, one bubble side over from the one above. The menu is sent-only —
// Edit needs a message of your own — so it always pins its LEFT edge and grows rightward across its
// own bubble. The action row sits outboard-left of a right-aligned bubble, which means the anchor's
// distance from the thread's right edge IS THE BUBBLE'S WIDTH. That is the whole reason the bug was
// width-dependent, and why no fixed side could have avoided it.
//
// Geometry below matches the app: 24px scroller padding, an 8px gap between the row and the bubble,
// and the "⋯" as the last of the three 26px buttons, hard against the bubble.
describe('fitPopover — the "⋯" menu on a sent bubble', () => {
  const CONTENT_RIGHT = THREAD.right - 24
  /** The "⋯" button for a right-aligned bubble of the given width. */
  const moreButton = (bubbleWidth: number) => button(CONTENT_RIGHT - bubbleWidth - 8 - 26, 400)

  it('pulls the menu back inside on a short bubble — the reported bug', () => {
    // A bubble reading "10": about forty pixels, so the menu would have started ~1002 and ended
    // ~1162, seventy past a thread that stops at 1100. Clipped to "Edit mes…".
    const p = placed(moreButton(40), MORE_MENU, below('left'))
    expect(inside(p)).toBe(true)
    expect(p.dx).toBeLessThan(0)
    expect(p.right).toBe(THREAD.right - 8)
  })

  it('leaves a long bubble completely alone — no correction, no transform', () => {
    // THE INVARIANT THAT MATTERS MOST HERE: a wide bubble already had room, so the fix must be a
    // no-op for it. dx and dy of zero is what makes the hook emit no transform at all.
    const p = placed(moreButton(400), MORE_MENU, below('left'))
    expect(inside(p)).toBe(true)
    expect(p.dx).toBe(0)
    expect(p.dy).toBe(0)
  })

  it('opens downward without flipping — there is room below mid-thread', () => {
    expect(placed(moreButton(40), MORE_MENU, below('left')).placement).toBe('below')
  })

  it('still fits a bubble at the exact width where the menu just stops overflowing', () => {
    // The boundary: the menu needs ~126px of bubble before it clears the edge unaided. Either side
    // of it must end up inside the thread — corrected below, untouched above.
    for (const width of [120, 126, 132]) {
      const p = placed(moreButton(width), MORE_MENU, below('left'))
      expect(inside(p), `bubble ${width}px`).toBe(true)
    }
  })

  it('flips above for a message at the very bottom of the thread', () => {
    // The last message in a thread has no room below, which is exactly where a downward menu would
    // otherwise be cut off by the composer.
    const p = placed(button(1000, THREAD.bottom - 30), MORE_MENU, below('left'))
    expect(inside(p)).toBe(true)
  })

  // A group thread's received bubbles pass align 'right' for the same row, and although the menu
  // never renders there today (Edit is sent-only), the component takes the prop — so the mirror is
  // pinned rather than assumed.
  it('keeps a right-pinned menu inside near the thread left edge', () => {
    const p = placed(button(THREAD.left + 30, 400), MORE_MENU, below('right'))
    expect(inside(p)).toBe(true)
    expect(p.left).toBe(THREAD.left + 8)
  })
})
