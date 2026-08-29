// The direction invariants — the regression guard for a bug that actually shipped.
//
// A success screen once read "Now shielded" after an unshield. Nothing about that was cosmetic: it
// told a user the opposite of what had just happened to their money's visibility, on the one screen
// that reports the outcome. These tests pin the properties that make it unsayable.
//
// They test DATA, not rendering. That is the whole reason the copy lives in a .ts module of its
// own — the invariants are about the strings themselves, and a test that had to mount a component
// to check them would be testing the renderer instead.

import { describe, expect, it } from 'vitest'
import {
  DIR, moveAvailLabel, moveBlurb, moveDirectionRow, moveDone, moveMovedTo, moveMovingTo, moveTitle,
  type Dir,
} from './moveCopy'

const DIRS: Dir[] = ['conceal', 'reveal']

/** Every user-facing string the flow derives from a direction. */
const BUILDERS: { name: string; of: (d: Dir) => string }[] = [
  { name: 'moveTitle', of: moveTitle },
  { name: 'moveBlurb', of: moveBlurb },
  { name: 'moveAvailLabel', of: moveAvailLabel },
  { name: 'moveDirectionRow', of: moveDirectionRow },
  { name: 'moveDone', of: moveDone },
  { name: 'moveMovedTo', of: moveMovedTo },
  { name: 'moveMovingTo', of: moveMovingTo },
]

describe('the direction table', () => {
  it('maps conceal to public → private, and reveal to private → public', () => {
    expect(DIR.conceal).toEqual({ from: 'public', to: 'private' })
    expect(DIR.reveal).toEqual({ from: 'private', to: 'public' })
  })

  it('never has a direction moving a balance into itself', () => {
    for (const d of DIRS) expect(DIR[d].from).not.toBe(DIR[d].to)
  })

  it('is a true mirror — one direction’s source is the other’s destination', () => {
    expect(DIR.conceal.from).toBe(DIR.reveal.to)
    expect(DIR.conceal.to).toBe(DIR.reveal.from)
  })
})

describe('every derived string distinguishes the two directions', () => {
  // THE CORE GUARD. If any builder ever returned the same words for both directions, one of them
  // would be describing a move that did not happen.
  it.each(BUILDERS)('$name says something different for each direction', ({ of }) => {
    expect(of('conceal')).not.toBe(of('reveal'))
  })

  it.each(BUILDERS)('$name never mentions shielded or unshielded', ({ of }) => {
    // This flow was the last surface using that vocabulary. Nothing may bring it back.
    for (const d of DIRS) expect(of(d)).not.toMatch(/shielded/i)
  })

  it.each(BUILDERS)('$name names the direction it was asked about', ({ of }) => {
    // Each string must contain its own direction's destination or source, and a string that
    // mentions BOTH nouns must not be describing them in the wrong order — checked per builder
    // below where the order is meaningful.
    for (const d of DIRS) {
      const s = of(d).toLowerCase()
      expect(s.includes(DIR[d].to) || s.includes(DIR[d].from)).toBe(true)
    }
  })
})

describe('the success headline — the string the old bug got wrong', () => {
  it('reports the DESTINATION of the move that ran', () => {
    expect(moveDone('conceal')).toBe('Now private')
    expect(moveDone('reveal')).toBe('Now public')
  })

  it('is never the other direction’s headline', () => {
    expect(moveDone('conceal')).not.toBe('Now public')
    expect(moveDone('reveal')).not.toBe('Now private')
  })

  it('agrees with the sub-line beneath it', () => {
    // The headline and the sentence under it are two strings on one card. If they ever disagreed,
    // the card would contradict itself about where the money went.
    for (const d of DIRS) {
      expect(moveMovedTo(d)).toContain(DIR[d].to)
      expect(moveMovedTo(d)).not.toContain(DIR[d].from)
      expect(moveDone(d)).toContain(DIR[d].to)
    }
  })

  it('agrees with the header and the confirm button that led to it', () => {
    // "Make private" → … → "Now private". The whole flow names one destination throughout.
    for (const d of DIRS) {
      expect(moveTitle(d)).toContain(DIR[d].to)
      expect(moveDirectionRow(d)).toContain(DIR[d].to)
      expect(moveDone(d)).toContain(DIR[d].to)
    }
  })
})

describe('the form names the source, not the destination', () => {
  it('offers the balance being spent FROM', () => {
    // "Available public" on make-private: you are spending public funds. Naming the destination
    // here would offer a maximum drawn from the wrong balance.
    expect(moveAvailLabel('conceal')).toBe('Available public')
    expect(moveAvailLabel('reveal')).toBe('Available private')
  })

  it('describes the move in source-then-destination order', () => {
    for (const d of DIRS) {
      const blurb = moveBlurb(d)
      expect(blurb.indexOf(DIR[d].from)).toBeLessThan(blurb.indexOf(DIR[d].to))
    }
  })
})
