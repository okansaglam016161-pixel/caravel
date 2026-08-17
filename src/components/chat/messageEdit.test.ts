// Tests for the pure edit-UI logic (M3): which rows offer the affordance, when a save is worth
// sending, and the optimistic in-flight state machine.

import { describe, expect, it } from 'vitest'
import {
  beginFlight,
  canEditMessage,
  clearFlight,
  displayTextFor,
  flightFor,
  isEditSubmittable,
  settleFlight,
  type EditFlightMap,
} from './messageEdit'
import type { CaravelMessage } from '../../messaging/types'

const ME = 'a'.repeat(64)
const PEER = 'b'.repeat(64)

function msg(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: 'evt1',
    senderPubkeyHex: ME,
    recipientPubkeyHex: PEER,
    plaintext: 'stored text',
    timestamp: 1_000_000,
    direction: 'sent',
    logicalId: 'L1',
    ...over,
  }
}

describe('canEditMessage', () => {
  it('allows my own plain sent DM that carries a logicalId', () => {
    expect(canEditMessage(msg())).toBe(true)
  })

  it('refuses a received message — the peer authored it', () => {
    expect(canEditMessage(msg({ direction: 'received', senderPubkeyHex: PEER }))).toBe(false)
  })

  it('refuses a pre-M2 row with no logicalId (flag 2: affordance is simply absent)', () => {
    expect(canEditMessage(msg({ logicalId: undefined }))).toBe(false)
  })

  it('allows my own sent GROUP message (M4) — same rule, minus the DM-only exclusion', () => {
    // Shaped like a real group 'sent' row: synthetic id, blank recipient, shared logicalId.
    expect(canEditMessage(msg({ id: 'grp-1', recipientPubkeyHex: '', groupId: 'g1' }))).toBe(true)
  })

  it('refuses another member\'s group message — the send-side half of the authorship rule', () => {
    expect(canEditMessage(msg({ groupId: 'g1', direction: 'received', senderPubkeyHex: PEER }))).toBe(false)
  })

  it('refuses a pre-M2 group row, which has no shared handle to name', () => {
    expect(canEditMessage(msg({ groupId: 'g1', logicalId: undefined }))).toBe(false)
  })

  it('refuses a system notice and a payment row', () => {
    expect(canEditMessage(msg({ system: 'group-leave', plaintext: '' }))).toBe(false)
    expect(canEditMessage(msg({ payment: { utxoId: 'utxo_1' } }))).toBe(false)
  })

  it('refuses a group-leave notice in a group thread — the only place system rows live', () => {
    expect(canEditMessage(msg({ groupId: 'g1', system: 'group-leave', plaintext: '', logicalId: 'L9' }))).toBe(false)
  })
})

describe('isEditSubmittable', () => {
  it('accepts a genuine change', () => {
    expect(isEditSubmittable('hello', 'hello there')).toBe(true)
  })

  it('rejects empty or whitespace-only text', () => {
    expect(isEditSubmittable('hello', '')).toBe(false)
    expect(isEditSubmittable('hello', '   ')).toBe(false)
  })

  it('rejects an unchanged save, including one differing only by surrounding space', () => {
    // An unchanged save would burn a revision number for no visible effect.
    expect(isEditSubmittable('hello', 'hello')).toBe(false)
    expect(isEditSubmittable('hello', '  hello  ')).toBe(false)
  })
})

describe('edit flight state machine', () => {
  const m = msg()

  it('shows the new text while saving, and the stored text otherwise', () => {
    const empty: EditFlightMap = {}
    expect(displayTextFor(m, empty)).toBe('stored text')

    const saving = beginFlight(empty, 'L1', 'new text')
    expect(displayTextFor(m, saving)).toBe('new text')
    expect(flightFor(m, saving)).toEqual({ text: 'new text', status: 'saving' })
  })

  it('drops the flight on success, handing rendering back to the store', () => {
    const settled = settleFlight(beginFlight({}, 'L1', 'new text'), 'L1', true)
    expect(settled).toEqual({})
    expect(displayTextFor(m, settled)).toBe('stored text')
  })

  it('SNAPS BACK on failure but keeps the typed text for Retry', () => {
    // The edit never left the device, so the bubble must not keep showing it.
    const failed = settleFlight(beginFlight({}, 'L1', 'new text'), 'L1', false)
    expect(failed.L1).toEqual({ text: 'new text', status: 'failed' })
    expect(displayTextFor(m, failed)).toBe('stored text')
  })

  it('settling an unknown id is a no-op that preserves identity', () => {
    const map = beginFlight({}, 'L1', 'x')
    expect(settleFlight(map, 'other', true)).toBe(map)
  })

  it('clearFlight removes a dismissed failure and is identity-stable when absent', () => {
    const failed = settleFlight(beginFlight({}, 'L1', 'x'), 'L1', false)
    expect(clearFlight(failed, 'L1')).toEqual({})
    const empty: EditFlightMap = {}
    expect(clearFlight(empty, 'L1')).toBe(empty)
  })

  it('never mutates the map it is given', () => {
    const before: EditFlightMap = {}
    const after = beginFlight(before, 'L1', 'x')
    expect(before).toEqual({})
    expect(after).not.toBe(before)
  })

  it('ignores a message with no logicalId', () => {
    const noId = msg({ logicalId: undefined })
    const map = beginFlight({}, 'L1', 'new text')
    expect(flightFor(noId, map)).toBeUndefined()
    expect(displayTextFor(noId, map)).toBe('stored text')
  })

  it('keeps flights for different messages independent', () => {
    let map = beginFlight({}, 'L1', 'one')
    map = beginFlight(map, 'L2', 'two')
    map = settleFlight(map, 'L1', false)

    expect(displayTextFor(msg({ logicalId: 'L1' }), map)).toBe('stored text')   // failed → snapped back
    expect(displayTextFor(msg({ logicalId: 'L2' }), map)).toBe('two')           // still saving
  })
})
