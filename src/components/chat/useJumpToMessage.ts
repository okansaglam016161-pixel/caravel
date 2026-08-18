// Shared tap-to-jump: scroll a quoted original into view and flash it, in DM and group threads
// alike (replies v1).
//
// SINGLE SOURCE OF TRUTH, for the same reason useScrollToBottom is one. That hook exists because
// five inline lines lived in the DM view and the group thread silently never got them; this one has
// the same shape of state (a ref, a timer, a piece of transient UI state) and the same two consumers,
// so it lands here once rather than being written twice and drifting.
//
// WHY querySelector RATHER THAN A REF MAP. A Map<logicalId, HTMLElement> has to be maintained across
// every mount and unmount of a dynamic list, which means a ref callback per row and a cleanup path
// that is easy to get subtly wrong (a stale entry points at a detached node). The thread is NOT
// virtualized — every message in the open thread is in the DOM — so a single query at click time
// finds the element with no bookkeeping at all, and holds no state that can go stale.

import { useCallback, useEffect, useRef, useState } from 'react'

// How long the jumped-to message stays lit. Long enough to find the bubble after a smooth scroll
// lands, short enough that it reads as a pointer rather than a selection.
const FLASH_MS = 1600

export function useJumpToMessage(threadKey: string | null) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [flashedId, setFlashedId] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  // Neither view REMOUNTS when the open thread changes (the same fact that makes useScrollToBottom
  // take a threadKey), so a flash left running would light up an unrelated message in the next
  // thread — logical ids are per-message, but the flashed one simply stops existing here.
  useEffect(() => {
    setFlashedId(null)
    clearTimer()
  }, [threadKey, clearTimer])

  // Unmount cleanup: a pending timeout calling setState after teardown is a leak and a warning.
  useEffect(() => clearTimer, [clearTimer])

  const jumpTo = useCallback((logicalId: string) => {
    // CSS.escape is load-bearing, not decoration: a logical id can arrive from an untrusted peer and
    // is only bounded in LENGTH by the wire layer (64 chars), never in alphabet. An id containing a
    // quote or a bracket would otherwise build a malformed selector, and querySelector THROWS on one
    // — turning a hostile peer's message into a crashed thread on the reader's device.
    const el = containerRef.current?.querySelector(`[data-lid="${CSS.escape(logicalId)}"]`)
    // Resolvable but not rendered is a real state — a row the store holds but this thread does not
    // display — and it is a silent no-op, never a throw. A genuinely MISSING original never gets
    // here: its quote renders "Original unavailable" and is inert by construction.
    if (!el) return
    // The FLASH is kept under reduced-motion — it is the only thing telling the reader which message
    // they landed on, and a colour fade is not the motion the preference is about. The smooth SCROLL
    // is: an animated jump across a long thread is exactly the vestibular trigger it exists to
    // suppress, so that degrades to an instant one.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
    // Re-jumping to the same message restarts the flash rather than being swallowed by the timer
    // still running from the previous jump.
    clearTimer()
    setFlashedId(logicalId)
    timer.current = window.setTimeout(() => {
      setFlashedId(null)
      timer.current = null
    }, FLASH_MS)
  }, [clearTimer])

  return { containerRef, flashedId, jumpTo }
}
