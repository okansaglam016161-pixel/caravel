// Unit tests for insert-at-cursor (B). Small surface, but every one of these is a bug the two
// composers would otherwise have had to discover independently — which is the whole reason the
// rule was pulled out of them (see composerInsert.ts).

import { describe, expect, it } from 'vitest'
import { insertAtCursor } from './composerInsert'

const MAX = 2000

describe('insertAtCursor — placement', () => {
  it('inserts at a collapsed caret and reports where the caret lands', () => {
    expect(insertAtCursor('hello world', 5, 5, '👍', MAX)).toEqual({ text: 'hello👍 world', caret: 7 })
  })

  it('appends when the caret is at the end', () => {
    expect(insertAtCursor('hi', 2, 2, '👍', MAX)).toEqual({ text: 'hi👍', caret: 4 })
  })

  it('prepends when the caret is at the start', () => {
    expect(insertAtCursor('hi', 0, 0, '👍', MAX)).toEqual({ text: '👍hi', caret: 2 })
  })

  it('inserts into an empty draft', () => {
    expect(insertAtCursor('', 0, 0, '👍', MAX)).toEqual({ text: '👍', caret: 2 })
  })

  it('REPLACES a selection, the way typing a character would', () => {
    expect(insertAtCursor('hello world', 6, 11, '🔥', MAX)).toEqual({ text: 'hello 🔥', caret: 8 })
  })

  it('handles a backwards selection (dragged right-to-left)', () => {
    // selectionStart/selectionEnd are always ordered by the DOM, but the guard costs one Math.min
    // and removes a whole class of "how did the text get mangled" bug.
    expect(insertAtCursor('hello world', 11, 6, '🔥', MAX)).toEqual({ text: 'hello 🔥', caret: 8 })
  })

  it('counts the caret in UTF-16 code units, so multi-unit emoji stay whole', () => {
    // Placing a caret between the surrogates of an existing emoji is not expressible here: the
    // offsets come from the textarea, which never reports one.
    const out = insertAtCursor('👍', 2, 2, '🔥', MAX)
    expect(out).toEqual({ text: '👍🔥', caret: 4 })
    expect([...out.text]).toHaveLength(2)
  })

  it('inserts a ZWJ sequence as one unit', () => {
    const family = '👨‍👩‍👧‍👦'
    const out = insertAtCursor('ab', 1, 1, family, MAX)
    expect(out.text).toBe('a' + family + 'b')
    expect(out.caret).toBe(1 + family.length)
  })
})

describe('insertAtCursor — an unknown or bogus caret degrades to append', () => {
  it('appends when the selection is null (no selection reported)', () => {
    expect(insertAtCursor('hi', null, null, '👍', MAX)).toEqual({ text: 'hi👍', caret: 4 })
    expect(insertAtCursor('hi', undefined, undefined, '👍', MAX)).toEqual({ text: 'hi👍', caret: 4 })
  })

  it('clamps an out-of-range or non-finite offset instead of producing "undefined" text', () => {
    expect(insertAtCursor('hi', 99, 99, '👍', MAX).text).toBe('hi👍')
    expect(insertAtCursor('hi', -5, -5, '👍', MAX).text).toBe('👍hi')
    expect(insertAtCursor('hi', NaN, NaN, '👍', MAX).text).toBe('hi👍')
    expect(insertAtCursor('hi', 1.7, 1.7, '👍', MAX).text).toBe('h👍i')
  })
})

describe('insertAtCursor — the length cap (F9)', () => {
  // The textarea's own maxLength attribute gates TYPING and PASTE only, never a programmatic write.
  // Without this the picker would be the one way to push a draft past the limit the counter shows.
  it('no-ops when the insert would overflow, leaving the caret where it was', () => {
    const full = 'x'.repeat(MAX)
    expect(insertAtCursor(full, 3, 3, '👍', MAX)).toEqual({ text: full, caret: 3 })
  })

  it('allows an insert that lands exactly on the cap', () => {
    const nearly = 'x'.repeat(MAX - 2)
    const out = insertAtCursor(nearly, MAX - 2, MAX - 2, '👍', MAX)
    expect(out.text).toHaveLength(MAX)
    expect(out.caret).toBe(MAX)
  })

  it('refuses one code unit over the cap', () => {
    const nearly = 'x'.repeat(MAX - 1)
    expect(insertAtCursor(nearly, 0, 0, '👍', MAX).text).toBe(nearly)
  })

  it('counts a REPLACED selection as freed space', () => {
    // Replacing four characters with a two-unit emoji shortens the draft, so it must be allowed
    // even at the cap. Charging for the insert without crediting the replacement would make a full
    // draft impossible to edit with the picker.
    const full = 'x'.repeat(MAX)
    const out = insertAtCursor(full, 0, 4, '👍', MAX)
    expect(out.text).toHaveLength(MAX - 2)
    expect(out.caret).toBe(2)
  })

  it('respects a smaller cap verbatim', () => {
    expect(insertAtCursor('abc', 3, 3, '👍', 4).text).toBe('abc')       // would be 5
    expect(insertAtCursor('abc', 3, 3, '👍', 5).text).toBe('abc👍')
  })
})

describe('insertAtCursor — nothing to insert', () => {
  it('returns the text untouched and the caret at the selection end', () => {
    expect(insertAtCursor('hello', 1, 3, '', MAX)).toEqual({ text: 'hello', caret: 3 })
  })
})
