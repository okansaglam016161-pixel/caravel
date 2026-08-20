// Unit tests for the emoji picker's search (B). The picker component itself has no test — there is
// no component harness in this repo and one is not being added for a grid of buttons — so this file
// and composerInsert.test.ts are the picker's whole testable surface, which is exactly why the
// logic was put in pure modules rather than inline in the component.

import { describe, expect, it } from 'vitest'
import { searchEmoji } from './emojiSearch'
import { ALL_EMOJI, EMOJI_CATEGORIES, QUICK_SET, type EmojiEntry } from './emojiData'

const SET: EmojiEntry[] = [
  { char: '👍', keywords: ['thumbsup', 'yes', 'ok', 'good'] },
  { char: '❤️', keywords: ['heart', 'love', 'red'] },
  { char: '🔥', keywords: ['fire', 'hot', 'lit'] },
  { char: '💔', keywords: ['broken', 'heart', 'sad'] },
]

describe('searchEmoji', () => {
  it('returns everything, in curated order, for an empty query', () => {
    expect(searchEmoji(SET, '').map(e => e.char)).toEqual(['👍', '❤️', '🔥', '💔'])
    expect(searchEmoji(SET, '   ')).toHaveLength(4)
  })

  it('returns a COPY, so a caller cannot mutate the curated set', () => {
    const out = searchEmoji(SET, '')
    expect(out).not.toBe(SET)
    out.pop()
    expect(SET).toHaveLength(4)
  })

  it('matches a keyword substring', () => {
    expect(searchEmoji(SET, 'heart').map(e => e.char)).toEqual(['❤️', '💔'])
    expect(searchEmoji(SET, 'fir').map(e => e.char)).toEqual(['🔥'])
  })

  it('is case- and whitespace-insensitive', () => {
    expect(searchEmoji(SET, 'HEART').map(e => e.char)).toEqual(['❤️', '💔'])
    expect(searchEmoji(SET, '  Fire  ').map(e => e.char)).toEqual(['🔥'])
  })

  it('ranks prefix matches above mid-word matches, keeping curated order in each band', () => {
    // 'ok' is a whole keyword on 👍 (prefix) and sits mid-word in 'broken' on 💔.
    expect(searchEmoji(SET, 'ok').map(e => e.char)).toEqual(['👍', '💔'])
  })

  it('finds an emoji by the character itself, so a pasted emoji resolves', () => {
    expect(searchEmoji(SET, '🔥').map(e => e.char)).toEqual(['🔥'])
    expect(searchEmoji(SET, ' 👍 ').map(e => e.char)).toEqual(['👍'])
  })

  it('returns nothing when nothing matches — the picker shows its empty state', () => {
    expect(searchEmoji(SET, 'zzzz')).toEqual([])
  })

  it('never returns an entry twice, even when several keywords match', () => {
    const both: EmojiEntry[] = [{ char: '🎉', keywords: ['party', 'partying', 'partied'] }]
    expect(searchEmoji(both, 'part')).toHaveLength(1)
  })
})

describe('the curated set itself', () => {
  it('has no duplicate characters', () => {
    const chars = ALL_EMOJI.map(e => e.char)
    expect(new Set(chars).size).toBe(chars.length)
  })

  it('gives every entry at least one keyword, all lowercase and non-blank', () => {
    for (const e of ALL_EMOJI) {
      expect(e.keywords.length, `${e.char} needs keywords`).toBeGreaterThan(0)
      for (const k of e.keywords) {
        expect(k, `${e.char} keyword ${JSON.stringify(k)}`).toBe(k.toLowerCase())
        expect(k.trim(), `${e.char} keyword ${JSON.stringify(k)}`).not.toBe('')
      }
    }
  })

  it('flattens the categories exactly, in order', () => {
    expect(ALL_EMOJI).toEqual(EMOJI_CATEGORIES.flatMap(c => c.emoji))
    expect(EMOJI_CATEGORIES.every(c => c.name.trim() !== '' && c.emoji.length > 0)).toBe(true)
  })

  it('contains every quick-set emoji, so the "+" picker can reach them too', () => {
    // The reaction row (C) offers these six directly; the picker behind "+" must not be a set that
    // excludes them, or removing a reaction picked from the row would be impossible from the picker.
    const chars = new Set(ALL_EMOJI.map(e => e.char))
    for (const q of QUICK_SET) expect(chars.has(q), `quick-set ${q} must be in the curated set`).toBe(true)
    expect(QUICK_SET).toHaveLength(6)
  })

  it('finds the six quick-set emoji by an obvious word', () => {
    // These are the ones Checkpoint C puts on the hover row, so they must be REACHABLE by search
    // too — a picker that cannot find 🙏 by typing "thanks" is the kind of gap nobody notices until
    // they need it. Reachability, not rank: several emoji legitimately answer to "lol" or "wow",
    // and which of them leads is a matter of taste that does not belong in a test.
    const hits = (q: string) => searchEmoji(ALL_EMOJI, q).map(e => e.char)
    expect(hits('thumbsup')).toContain('👍')
    expect(hits('love')).toContain('❤️')
    expect(hits('lol')).toContain('😂')
    expect(hits('wow')).toContain('😮')
    expect(hits('cry')).toContain('😢')
    expect(hits('thanks')).toContain('🙏')
  })

  it('leads with the obvious answer where there IS one', () => {
    // Rank is asserted only for queries with a single sensible top hit. 'heart' is the interesting
    // one: it used to lead with 😍, because that entry carried 'heart' as a keyword for its
    // heart-shaped eyes — nobody types "heart" wanting a face, so the keyword was dropped.
    const first = (q: string) => searchEmoji(ALL_EMOJI, q)[0]?.char
    expect(first('heart')).toBe('❤️')
    expect(first('thumbsup')).toBe('👍')
    expect(first('thanks')).toBe('🙏')
    expect(first('fire')).toBe('🔥')
  })
})
