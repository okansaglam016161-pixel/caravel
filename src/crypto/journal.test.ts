// The journal's record rules, as tests.
//
// Two of these are the whole reason the module exists, and both are about a distinction that is
// invisible until it is wrong: an unknown amount must never become a zero, and "created no output"
// must never be confused with "could not tell what output was created".

import { describe, expect, it } from 'vitest'
import {
  applyPatch, draftToEntry, journalCovers, newJournalId,
  type JournalDraft, type JournalEntry,
} from './journal'

const DRAFT: JournalDraft = {
  kind: 'send',
  amountMicrotari: 1_500_000n,
  feeMicrotari: null,
  from: 'private',
  to: 'external',
  counterparty: { kind: 'address', value: 'otl_esm_1tnay4uzgpe0cvu4tzwfmhdhtvc3pq97szrnteetuz2dvqmjk2ecwq34fnsm8hz7tk43xrur8d2y6mye4w3shjq4qj5sm7xvpq7yqqngs8224p' },
  note: 'lunch',
  source: 'local-journal',
  selfOutputIds: null,
}

describe('draftToEntry', () => {
  it('starts every action as pending with no txId', () => {
    // The entry exists BEFORE submission — that is what makes a throwing send recoverable.
    const e = draftToEntry(DRAFT, 1_000)
    expect(e.outcome).toBe('pending')
    expect(e.txId).toBeNull()
    expect(e.timestamp).toBe(1_000)
  })

  it('carries the FULL counterparty address, not a truncation', () => {
    const e = draftToEntry(DRAFT)
    expect(e.counterparty?.value).toBe(DRAFT.counterparty!.value)
    expect(e.counterparty?.value).not.toContain('…')
  })

  it('gives every entry its own id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newJournalId()))
    expect(ids.size).toBe(200)
  })

  it('preserves a null amount as null — never zero', () => {
    const e = draftToEntry({ ...DRAFT, amountMicrotari: null })
    expect(e.amountMicrotari).toBeNull()
    expect(e.amountMicrotari).not.toBe(0n)
  })
})

describe('applyPatch — only ever adds knowledge', () => {
  const base = draftToEntry(DRAFT, 1_000)

  it('records the outcome, txId, fee and self-outputs an action reported', () => {
    const p = applyPatch(base, {
      outcome: 'committed', txId: 'abc', feeMicrotari: 14_457n, selfOutputIds: ['utxo_x'],
    })
    expect(p).toMatchObject({ outcome: 'committed', txId: 'abc', feeMicrotari: 14_457n })
    expect(p.selfOutputIds).toEqual(['utxo_x'])
  })

  it('does NOT erase a known figure when the patch omits it', () => {
    // A send that reported an amount and then failed to report a fee must not lose the amount.
    const p = applyPatch(base, { outcome: 'failed' })
    expect(p.amountMicrotari).toBe(1_500_000n)
    expect(p.note).toBe('lunch')
    expect(p.timestamp).toBe(1_000)
  })

  it('keeps the id stable across the two-phase write', () => {
    expect(applyPatch(base, { outcome: 'committed' }).id).toBe(base.id)
  })

  it('can set selfOutputIds to the empty array — which is not the same as leaving it null', () => {
    // [] is a POSITIVE claim: this action made no output for us. It must be settable.
    const p = applyPatch(base, { outcome: 'committed', selfOutputIds: [] })
    expect(p.selfOutputIds).toEqual([])
    expect(p.selfOutputIds).not.toBeNull()
  })

  it('leaves selfOutputIds alone when the patch does not mention them', () => {
    const withIds: JournalEntry = { ...base, selfOutputIds: ['utxo_a'] }
    expect(applyPatch(withIds, { outcome: 'timeout' }).selfOutputIds).toEqual(['utxo_a'])
  })
})

describe('journalCovers — the guard the reconciliation phase will lean on', () => {
  it('claims nothing when there is no journal at all', () => {
    // A wallet that transacted before journalling existed. Every UTXO it holds is unexplained, and
    // classifying any of them would report the user's own change as a stranger's payment.
    expect(journalCovers(null, 5_000)).toBe(false)
  })

  it('claims nothing about anything older than the journal', () => {
    expect(journalCovers({ startedAt: 1_000, degradedAt: null }, 999)).toBe(false)
  })

  it('covers an observation made after journalling began', () => {
    expect(journalCovers({ startedAt: 1_000, degradedAt: null }, 1_000)).toBe(true)
    expect(journalCovers({ startedAt: 1_000, degradedAt: null }, 9_999)).toBe(true)
  })

  it('refuses EVERYTHING once a write has been lost, however recent', () => {
    // The dangerous case: a dropped write leaves a hole with no other trace, and a hole turns our
    // own output into a fabricated receive. One failure disqualifies the whole record.
    const holed = { startedAt: 1_000, degradedAt: 2_000 }
    expect(journalCovers(holed, 9_999)).toBe(false)
    expect(journalCovers(holed, 1_500)).toBe(false)
  })
})
