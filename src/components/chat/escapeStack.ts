// Who gets the Escape key.
//
// ── WHY A STACK, AND NOT NINE LISTENERS ──────────────────────────────────────
//
// Every dismissible thing in the chat used to install its own `window` keydown and call its own
// onClose. That works while only one can be open, and it has no answer at all for ordering — which
// is the whole of this problem, because Escape now also CLOSES THE CONVERSATION. A picker open over
// a thread must take the key for itself and leave the thread alone; only when nothing is open may
// the key reach the thread.
//
// Propagation cannot express that. `stopPropagation` governs ancestors, not two listeners on the
// same target, and `stopImmediatePropagation` resolves by REGISTRATION order — which here is mount
// order, so a popover that opens later registers later and fires later. Exactly backwards.
//
// So ordering is made explicit instead of inferred: handlers are pushed on mount and popped on
// unmount, ONE document listener runs the TOP one and nobody else. A later-mounted popover is, by
// construction, the one on top.
//
// ── THE FAILURE THIS MUST NOT HAVE ───────────────────────────────────────────
//
// A handler left behind by a component that unmounted swallows Escape for everything under it,
// forever, with nothing on screen to explain why. `pop` therefore removes BY IDENTITY rather than by
// position — an unmount out of order (React does not promise the reverse of mount) must not take the
// wrong handler with it, and must not shift the rest. It is also idempotent: popping twice, or
// popping something already gone, is a no-op rather than a corruption of the stack.
//
// The listener is attached only while the stack is non-empty, so an app with nothing open has no
// keydown listener at all.

type EscapeHandler = () => void

// Ordered bottom → top. The LAST entry is the one that gets the key.
let stack: EscapeHandler[] = []
let listening = false

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  const top = stack[stack.length - 1]
  if (!top) return
  // Consumed: the key belongs to exactly one layer, and anything still listening the old way
  // (the wallet's modals, which are deliberately not part of this) is outside the chat pane.
  e.preventDefault()
  top()
}

function sync() {
  const shouldListen = stack.length > 0
  if (shouldListen === listening) return
  if (shouldListen) document.addEventListener('keydown', onKeyDown)
  else document.removeEventListener('keydown', onKeyDown)
  listening = shouldListen
}

/**
 * Claim Escape until the returned function is called.
 *
 * The return value is a release, so a React effect is exactly `useEffect(() => pushEscape(fn), [])`
 * — the cleanup IS the pop, which is what makes forgetting to release it hard to do accidentally.
 */
export function pushEscape(handler: EscapeHandler): () => void {
  stack.push(handler)
  sync()
  let released = false
  return () => {
    if (released) return          // idempotent: React may invoke a cleanup more than once
    released = true
    popEscape(handler)
  }
}

/** Remove a handler BY IDENTITY, wherever it sits. A handler that is not there is a no-op. */
export function popEscape(handler: EscapeHandler): void {
  const at = stack.lastIndexOf(handler)
  if (at === -1) return
  stack.splice(at, 1)
  sync()
}

/** How many layers currently claim Escape. Tests and assertions only. */
export function escapeDepth(): number {
  return stack.length
}

/**
 * Drop everything. TEST ONLY — module state outlives a single spec otherwise, and a handler left by
 * one test would silently take the key in the next.
 */
export function resetEscapeStack(): void {
  stack = []
  sync()
}
