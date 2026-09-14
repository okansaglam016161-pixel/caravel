// Who gets the Escape key.
//
// ── WHAT THESE ARE WEIGHTED FOR ──────────────────────────────────────────────
//
// Ordering is the feature, but the UNMOUNT is the hazard. Escape now closes the conversation from
// the bottom of this stack, so a handler left behind by a component that unmounted would sit on top
// of it and swallow the key forever, with nothing on screen to explain why. The release tests are
// therefore the ones that matter most: out-of-order release, double release, releasing something
// never pushed, and the stack ending genuinely empty.
//
// There is no jsdom in this repo, so `document` is faked the same way the store specs fake
// localStorage — which also lets these assert what was actually REGISTERED, not merely returned.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { escapeDepth, popEscape, pushEscape, resetEscapeStack } from './escapeStack'

/** A document that records its listeners, so the tests can fire keys and count registrations. */
function fakeDocument() {
  const listeners = new Set<(e: KeyboardEvent) => void>()
  return {
    addEventListener: vi.fn((type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === 'keydown') listeners.add(fn)
    }),
    removeEventListener: vi.fn((type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === 'keydown') listeners.delete(fn)
    }),
    /** Number of keydown listeners actually attached right now. */
    count: () => listeners.size,
    /** Fire a key at whatever is attached. */
    press: (key = 'Escape') => {
      const e = { key, preventDefault: vi.fn() } as unknown as KeyboardEvent
      for (const fn of [...listeners]) fn(e)
      return e
    },
  }
}

let doc: ReturnType<typeof fakeDocument>

beforeEach(() => {
  resetEscapeStack()
  doc = fakeDocument()
  ;(globalThis as { document?: unknown }).document = doc
})

describe('the top of the stack, and nobody else', () => {
  it('gives Escape to the only handler', () => {
    const only = vi.fn()
    pushEscape(only)
    doc.press()
    expect(only).toHaveBeenCalledTimes(1)
  })

  // THE ORDERING THE FEATURE IS FOR: a picker opened over a thread takes the key, and the thread —
  // which registered first, underneath — hears nothing.
  it('gives Escape to the LAST pushed, leaving the ones below untouched', () => {
    const deselect = vi.fn()
    const picker = vi.fn()
    pushEscape(deselect)
    pushEscape(picker)

    doc.press()

    expect(picker).toHaveBeenCalledTimes(1)
    expect(deselect).not.toHaveBeenCalled()
  })

  it('walks back down as layers close, one key at a time', () => {
    const calls: string[] = []
    const deselect = () => calls.push('deselect')
    const menu = () => calls.push('menu')
    const picker = () => calls.push('picker')

    pushEscape(deselect)
    const closeMenu = pushEscape(menu)
    const closePicker = pushEscape(picker)

    doc.press();  closePicker()
    doc.press();  closeMenu()
    doc.press()

    expect(calls).toEqual(['picker', 'menu', 'deselect'])
  })

  it('ignores every other key', () => {
    const handler = vi.fn()
    pushEscape(handler)
    doc.press('Enter')
    doc.press('a')
    expect(handler).not.toHaveBeenCalled()
  })

  it('consumes the key, so nothing beneath acts on it too', () => {
    pushEscape(vi.fn())
    expect(doc.press().preventDefault).toHaveBeenCalled()
  })

  it('does nothing at all when the stack is empty', () => {
    expect(escapeDepth()).toBe(0)
    expect(() => doc.press()).not.toThrow()
  })
})

// ── THE HAZARD ──────────────────────────────────────────────────────────────
describe('release — a stale handler would swallow Escape forever', () => {
  it('releases, and the layer below takes the key again', () => {
    const deselect = vi.fn()
    const picker = vi.fn()
    pushEscape(deselect)
    const release = pushEscape(picker)

    release()
    doc.press()

    expect(picker).not.toHaveBeenCalled()
    expect(deselect).toHaveBeenCalledTimes(1)
    expect(escapeDepth()).toBe(1)
  })

  // React does not promise that children unmount in the reverse of mount order, so a release from
  // the MIDDLE must take its own handler and leave the rest in place.
  it('releases from the middle by identity, not by position', () => {
    const bottom = vi.fn()
    const middle = vi.fn()
    const top = vi.fn()
    pushEscape(bottom)
    const releaseMiddle = pushEscape(middle)
    pushEscape(top)

    releaseMiddle()

    expect(escapeDepth()).toBe(2)
    doc.press()
    expect(top).toHaveBeenCalledTimes(1)
    expect(middle).not.toHaveBeenCalled()
    expect(bottom).not.toHaveBeenCalled()
  })

  // A cleanup that runs twice must not take an unrelated layer down with it — the failure would be
  // invisible until some other popover stopped answering Escape.
  it('is idempotent: a double release removes exactly one entry', () => {
    const deselect = vi.fn()
    pushEscape(deselect)
    const release = pushEscape(vi.fn())

    release()
    release()

    expect(escapeDepth()).toBe(1)
    doc.press()
    expect(deselect).toHaveBeenCalledTimes(1)
  })

  it('tolerates popping a handler that was never pushed', () => {
    pushEscape(vi.fn())
    expect(() => popEscape(vi.fn())).not.toThrow()
    expect(escapeDepth()).toBe(1)
  })

  it('keeps both entries when the same function is pushed twice, and releases one each time', () => {
    // Two instances of one component share a function identity if it is hoisted; each push must own
    // its own slot or the second unmount would leave a live handler behind.
    const shared = vi.fn()
    const a = pushEscape(shared)
    const b = pushEscape(shared)
    expect(escapeDepth()).toBe(2)
    a(); expect(escapeDepth()).toBe(1)
    b(); expect(escapeDepth()).toBe(0)
  })

  it('ends genuinely empty — no handler, and no listener left attached', () => {
    const release = pushEscape(vi.fn())
    release()
    expect(escapeDepth()).toBe(0)
    expect(doc.count()).toBe(0)
  })
})

describe('the document listener', () => {
  it('attaches only once, however many layers are open', () => {
    pushEscape(vi.fn())
    pushEscape(vi.fn())
    pushEscape(vi.fn())
    expect(doc.count()).toBe(1)
    expect(doc.addEventListener).toHaveBeenCalledTimes(1)
  })

  it('is not attached at all until something claims Escape', () => {
    expect(doc.count()).toBe(0)
  })

  it('detaches when the last layer releases, and re-attaches for the next', () => {
    const release = pushEscape(vi.fn())
    expect(doc.count()).toBe(1)
    release()
    expect(doc.count()).toBe(0)
    pushEscape(vi.fn())
    expect(doc.count()).toBe(1)
  })
})
