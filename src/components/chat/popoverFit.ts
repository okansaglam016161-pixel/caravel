// Keeping an anchored popover inside its container (C, fix).
//
// THE BUG THIS EXISTS FOR. The quick-set and the "+" picker were positioned purely by CSS offsets —
// `left: 0` to open rightward from the anchor, `right: 0` to open leftward — with a vertical flip
// decided by one ad-hoc measurement. That is fine when the anchor has room on the chosen side, and
// a SENT bubble always does: its action row sits on the LEFT of a right-aligned bubble, i.e. deep
// inside the thread, so a panel opening rightward has the whole column to grow into.
//
// A RECEIVED bubble is not the mirror image of that, and assuming it was is what broke. Its action
// row sits on the RIGHT of a LEFT-aligned bubble — so for a short message the anchor is only ~90px
// from the thread's left edge, and a panel opening leftward (296px for the picker, ~230px for the
// quick-set) starts hundreds of pixels outside the container. Both threads scroll with
// `overflow-y: auto`, which resolves overflow-x to `auto` as well, and overflow to the LEFT of a
// scroll container is not reachable by scrolling — it is simply clipped. What survives on screen is
// the right-hand remnant of the panel, floating above and to the right of the bubble with no
// visible connection to it. Exactly the reported symptom, and exactly why sent looked fine.
//
// The fix is not a different fixed side — no fixed side works, because a LONG received bubble puts
// the anchor near the right edge instead. The panel has to be measured against the container it
// must stay inside, and moved back in when it does not fit. That is what this does.
//
// The math is a PURE function over rectangles so it can be tested without a DOM (there is no jsdom
// in this repo, and vitest does not even collect .tsx); the hook below is the thin DOM wrapper.

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

// Breathing room kept between the panel and the container edge.
const MARGIN = 8

export interface Rect { top: number; left: number; right: number; bottom: number }

export interface AnchorSpec {
  // The side of the anchor the panel PREFERS. Flipped only when the preferred side does not fit and
  // the other one does — a flip that is not needed is a jump the reader has to re-follow.
  placement: 'above' | 'below'
  // Which of the panel's edges is pinned to the anchor: 'left' pins its left edge to the anchor's
  // left (so it opens rightward), 'right' pins its right edge to the anchor's right.
  align: 'left' | 'right'
  // Gap between anchor and panel, in px — the anchor's own height plus a little.
  offset: number
}

export interface PopoverFit {
  dx: number
  dy: number
  placement: 'above' | 'below'
}

// Where the CSS offsets alone would put the panel's top edge, on each side of the anchor.
// `bottom: offset` measures up from the anchor's bottom; `top: offset` measures down from its top.
function topFor(placement: 'above' | 'below', anchor: Rect, height: number, offset: number): number {
  return placement === 'above' ? anchor.bottom - offset - height : anchor.top + offset
}

// How far the panel must be nudged to sit inside `bounds`, and which side it ended up on.
//
// Returns a CORRECTION rather than an absolute position on purpose: the CSS offsets stay in the
// stylesheet where they read as intent ("open leftward from the button"), and this only says how
// much reality had to differ. A panel that already fits gets {0, 0} and renders exactly as it did
// before this function existed — which is what keeps the sent-bubble case untouched.
export function fitPopover(anchor: Rect, size: { width: number; height: number }, bounds: Rect, spec: AnchorSpec): PopoverFit {
  // ── Vertical: flip only if the preferred side is clipped AND the other side is not ──
  const fits = (p: 'above' | 'below') => {
    const t = topFor(p, anchor, size.height, spec.offset)
    return t >= bounds.top + MARGIN && t + size.height <= bounds.bottom - MARGIN
  }
  const placement: 'above' | 'below' = fits(spec.placement)
    ? spec.placement
    : fits(spec.placement === 'above' ? 'below' : 'above')
      ? (spec.placement === 'above' ? 'below' : 'above')
      : spec.placement                                  // neither fits — keep the preference, clamp

  const top = topFor(placement, anchor, size.height, spec.offset)
  let dy = 0
  if (top + size.height > bounds.bottom - MARGIN) dy = (bounds.bottom - MARGIN) - (top + size.height)
  // Top clamp runs SECOND so that a panel taller than the container is pinned to the top rather than
  // the bottom: losing the end of a long list is recoverable by scrolling it, losing the start and
  // the search box is not.
  if (top + dy < bounds.top + MARGIN) dy = (bounds.top + MARGIN) - top

  // ── Horizontal: pure clamping, no flip. Which edge is pinned is a deliberate visual relationship
  //    (the panel grows over its own bubble); sliding it back into view preserves that, whereas
  //    flipping it to the other side of the anchor would not. ──
  const left = spec.align === 'left' ? anchor.left : anchor.right - size.width
  let dx = 0
  if (left + size.width > bounds.right - MARGIN) dx = (bounds.right - MARGIN) - (left + size.width)
  // Left clamp second, same reasoning as above: a panel wider than the container goes flush left.
  if (left + dx < bounds.left + MARGIN) dx = (bounds.left + MARGIN) - left

  return { dx, dy, placement }
}

// The container a popover must stay inside. Tagged explicitly with `data-popover-bounds` rather than
// sniffed by walking up looking for a scrolling ancestor: both message threads carry the attribute,
// and a popover with no tagged ancestor (the composer picker, which sits outside the scroller) falls
// back to the viewport — where it has always fitted, so nothing about it changes.
function boundsFor(el: Element): Rect {
  const host = el.closest('[data-popover-bounds]')
  if (host) return host.getBoundingClientRect()
  return { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }
}

// Anchored-popover positioning. Returns the ref to put on the panel and the style to spread onto it.
//
// ONE measurement, in a LAYOUT effect, before paint — so the correction is applied in the same frame
// and never shows as a jump. It runs exactly once per mount because the correction is derived from
// the UNCORRECTED position: `fit === null` is the baseline render, and once set the effect's deps do
// not change, so a measurement can never compound on a previous one.
export function useAnchoredPopover(spec: AnchorSpec) {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<PopoverFit | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const anchor = el?.offsetParent as HTMLElement | null   // the `position: relative` wrapper
    if (!el || !anchor) return
    const r = el.getBoundingClientRect()
    setFit(fitPopover(anchor.getBoundingClientRect(), { width: r.width, height: r.height }, boundsFor(el), spec))
    // Placement is fixed for the life of one popover: it is opened, used and dismissed, and a panel
    // that re-anchors mid-interaction because the thread scrolled underneath would be worse than one
    // that stays put.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const placement = fit?.placement ?? spec.placement
  const style: CSSProperties = {
    position: 'absolute',
    ...(placement === 'above' ? { bottom: spec.offset } : { top: spec.offset }),
    ...(spec.align === 'left' ? { left: 0 } : { right: 0 }),
    // Omitted entirely when nothing needed correcting, so a panel that already fitted renders with
    // no transform at all — no new stacking context, no change to the sent-bubble case.
    ...(fit && (fit.dx !== 0 || fit.dy !== 0) ? { transform: `translate(${fit.dx}px, ${fit.dy}px)` } : null),
  }
  return { ref, style }
}
