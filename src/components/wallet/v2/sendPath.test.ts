// The source decision, pinned: each balance spends only an envelope priced for it, and nothing
// falls through to the other balance.

import { describe, expect, it } from 'vitest'
import { resolveSendPath, type PreparedFor } from './sendPath'

const pub = { submit: () => 'public' }
const priv = { submit: () => 'private' }
type P = PreparedFor<typeof pub, typeof priv>

describe('resolveSendPath', () => {
  it('public with its envelope → that envelope', () => {
    expect(resolveSendPath<typeof pub, typeof priv>('public', { source: 'public', p: pub })).toEqual({ kind: 'public', prepared: pub })
  })

  it('private with its envelope → that envelope', () => {
    expect(resolveSendPath<typeof pub, typeof priv>('private', { source: 'private', p: priv })).toEqual({ kind: 'private', prepared: priv })
  })

  it('refuses when the envelope is missing, for either source', () => {
    for (const source of ['public', 'private'] as const) {
      for (const missing of [null, undefined]) {
        const path = resolveSendPath<typeof pub, typeof priv>(source, missing)
        expect(path.kind).toBe('refuse')
        if (path.kind !== 'refuse') throw new Error('expected a refusal')
        expect(path.reason).toMatch(/nothing was sent/i)
        expect(path.reason).not.toMatch(/envelope|prepared\b|null|undefined|µtTARI/i)
      }
    }
  })

  it('refuses an envelope priced for the OTHER balance — never spends different money', () => {
    const forPublic: P = { source: 'public', p: pub }
    const forPrivate: P = { source: 'private', p: priv }
    expect(resolveSendPath('private', forPublic).kind).toBe('refuse')
    expect(resolveSendPath('public', forPrivate).kind).toBe('refuse')
  })
})
