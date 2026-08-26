// Tests for the send-path decision (M9 F2).
//
// The property under test is a NEGATIVE one and it is the whole point: choosing "public" must never
// result in the private balance being spent. Everything else here exists to pin that.

import { describe, expect, it } from 'vitest'
import { resolveSendPath } from './sendPath'

const envelope = { submit: async () => ({}) }

describe('resolveSendPath', () => {
  it('public with an envelope spends the public balance', () => {
    expect(resolveSendPath('public', envelope)).toEqual({ kind: 'public', prepared: envelope })
  })

  it('private always spends the private balance', () => {
    expect(resolveSendPath('private', null)).toEqual({ kind: 'private' })
    expect(resolveSendPath('private', envelope)).toEqual({ kind: 'private' })
  })

  it.each([null, undefined])('PUBLIC WITHOUT AN ENVELOPE REFUSES — never falls back to private (%s)', (missing) => {
    const path = resolveSendPath('public', missing)
    expect(path.kind).toBe('refuse')
    // The regression this file exists for: the old ternary returned the private path here.
    expect(path.kind).not.toBe('private')
  })

  it('NO INPUT COMBINATION CAN SPEND PRIVATE WHILE PUBLIC WAS CHOSEN', () => {
    for (const prepared of [envelope, null, undefined, {} as never]) {
      const path = resolveSendPath('public', prepared)
      expect(path.kind).not.toBe('private')
    }
  })

  it('NO INPUT COMBINATION CAN SPEND PUBLIC WHILE PRIVATE WAS CHOSEN', () => {
    for (const prepared of [envelope, null, undefined]) {
      expect(resolveSendPath('private', prepared).kind).toBe('private')
    }
  })

  it('the refusal explains itself and never mentions machinery', () => {
    const path = resolveSendPath('public', null)
    if (path.kind !== 'refuse') throw new Error('expected a refusal')
    expect(path.reason).toMatch(/nothing was sent/)
    expect(path.reason).not.toMatch(/envelope|prepared\b|null|undefined|µtTARI/i)
  })
})
