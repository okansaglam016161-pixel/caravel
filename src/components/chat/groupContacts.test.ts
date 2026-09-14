// Who can be added to a group.
//
// THE BUG THESE PIN. The sidebar derives contacts from MESSAGES and treats a peer with no contact
// record as accepted; the group picker read the contacts store alone and could not see such a peer
// at all. So people plainly visible in the sidebar were missing from the picker, which said "No
// contacts yet" about them. The first test is that exact case.

import { describe, expect, it, vi } from 'vitest'
import { buildGroupContactOptions } from './groupContacts'
import type { ContactMap } from '../../messaging/contactStore'

const ME = 'm'.repeat(64)
const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)

const nameFor = (hex: string) => `name:${hex.slice(0, 1)}`
const record = (state: 'accepted' | 'pending') => ({ state, updatedAt: 1 })

const build = (over: Partial<Parameters<typeof buildGroupContactOptions>[0]> = {}) =>
  buildGroupContactOptions({
    conversationPeers: [], contacts: {} as ContactMap, mePubkeyHex: ME, nameFor, ...over,
  })

const hexes = (opts: { hex: string }[]) => opts.map(o => o.hex)

describe('the union — neither half is the whole set', () => {
  // THE REPORTED BUG: messages, no contact record. The sidebar shows them; the picker could not.
  it('offers a peer with messages and NO contact record', () => {
    expect(hexes(build({ conversationPeers: [ALICE] }))).toEqual([ALICE])
  })

  // The other half: accepted before any message exists — what startWith and acceptContact write.
  // Sourcing from conversations alone would have dropped a freshly composed contact.
  it('offers an accepted contact with no conversation yet', () => {
    expect(hexes(build({ contacts: { [BOB]: record('accepted') } as ContactMap }))).toEqual([BOB])
  })

  it('offers both, conversation peers first', () => {
    const opts = build({
      conversationPeers: [ALICE],
      contacts: { [BOB]: record('accepted') } as ContactMap,
    })
    expect(hexes(opts)).toEqual([ALICE, BOB])
  })

  it('keeps conversation order, which is the sidebar’s recency order', () => {
    expect(hexes(build({ conversationPeers: [CAROL, ALICE, BOB] }))).toEqual([CAROL, ALICE, BOB])
  })

  it('offers nobody when there is nothing at all', () => {
    expect(build()).toEqual([])
  })
})

describe('only ACCEPTED peers', () => {
  it('excludes a pending peer, even though they have messages', () => {
    // A request is not a contact. The sidebar holds these back for the request UI; so does this.
    const opts = build({
      conversationPeers: [ALICE, BOB],
      contacts: { [ALICE]: record('pending') } as ContactMap,
    })
    expect(hexes(opts)).toEqual([BOB])
  })

  it('excludes a pending record that has no conversation', () => {
    expect(build({ contacts: { [ALICE]: record('pending') } as ContactMap })).toEqual([])
  })

  it('applies the lazy default ONLY where there is no record', () => {
    // The whole rule in one assertion: absent → accepted, explicit pending → excluded.
    const opts = build({
      conversationPeers: [ALICE, BOB],
      contacts: { [BOB]: record('pending') } as ContactMap,
    })
    expect(hexes(opts)).toEqual([ALICE])
  })
})

describe('dedupe', () => {
  it('offers a peer with BOTH a conversation and a record exactly once', () => {
    const opts = build({
      conversationPeers: [ALICE],
      contacts: { [ALICE]: record('accepted') } as ContactMap,
    })
    expect(hexes(opts)).toEqual([ALICE])
  })

  it('offers a repeated conversation peer once', () => {
    expect(hexes(build({ conversationPeers: [ALICE, ALICE] }))).toEqual([ALICE])
  })
})

describe('self is never offered', () => {
  // Notes-to-self are an ordinary conversation, and sending one writes an accepted record under your
  // OWN key — so self could reach the picker through either half. createGroup already puts the
  // creator in the roster, so picking yourself was a no-op that only looked like a choice.
  it('excludes self arriving as a conversation', () => {
    expect(hexes(build({ conversationPeers: [ME, ALICE] }))).toEqual([ALICE])
  })

  it('excludes self arriving as an accepted record', () => {
    expect(build({ contacts: { [ME]: record('accepted') } as ContactMap })).toEqual([])
  })

  it('offers everyone when the wallet is locked and there is no self to exclude', () => {
    expect(hexes(build({ conversationPeers: [ALICE], mePubkeyHex: null }))).toEqual([ALICE])
  })
})

describe('names', () => {
  it('resolves each name through the caller’s resolver', () => {
    const resolver = vi.fn((hex: string) => `nick:${hex.slice(0, 1)}`)
    expect(build({ conversationPeers: [ALICE], nameFor: resolver })).toEqual([{ hex: ALICE, name: 'nick:a' }])
    expect(resolver).toHaveBeenCalledWith(ALICE)
  })

  it('drops a blank hex rather than offering a nameless row', () => {
    expect(build({ conversationPeers: ['', ALICE] })).toEqual([{ hex: ALICE, name: 'name:a' }])
  })
})
