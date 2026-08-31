// The journal's record rules, as tests.
//
// Two of these are the whole reason the module exists, and both are about a distinction that is
// invisible until it is wrong: an unknown amount must never become a zero, and "created no output"
// must never be confused with "could not tell what output was created".

import { describe, expect, it } from 'vitest'
import {
  OUTPUT_CREATING_ACTIONS, applyPatch, coverageComplete, draftToEntry, journalCovers, newJournalId,
  outputsFullyAccounted, unresolvedOutputs,
  type JournalDraft, type JournalEntry, type JournalEpoch,
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

/** A fully healthy, fully covered epoch. Each test below breaks exactly one thing. */
function epoch(over: Partial<JournalEpoch> = {}): JournalEpoch {
  return {
    startedAt: 1_000,
    degradedAt: null,
    covers: [...OUTPUT_CREATING_ACTIONS],
    coverageCompleteAt: 2_000,
    ...over,
  }
}

describe('coverageComplete', () => {
  it('is false for an epoch that covers nothing', () => {
    expect(coverageComplete([])).toBe(false)
  })

  it('is false while any single action is missing', () => {
    // The property that matters for the future: add a seventh way to create an owned output and
    // every stored epoch goes incomplete at once, with no migration and no silent assumption.
    for (const missing of OUTPUT_CREATING_ACTIONS) {
      expect(coverageComplete(OUTPUT_CREATING_ACTIONS.filter(a => a !== missing))).toBe(false)
    }
  })

  it('is true only with the whole set', () => {
    expect(coverageComplete([...OUTPUT_CREATING_ACTIONS])).toBe(true)
  })

  it('names chat payments and @name registrations — the two that were missing', () => {
    // Both create an owned change output and neither was journalled before Phase 3. Naming them
    // here is what stops a healthy-but-blind journal claiming completeness.
    expect(OUTPUT_CREATING_ACTIONS).toContain('chat-payment')
    expect(OUTPUT_CREATING_ACTIONS).toContain('ons-register')
  })
})

describe('journalCovers — the guard reconciliation leans on', () => {
  it('claims nothing when there is no journal at all', () => {
    // A wallet that transacted before journalling existed. Every UTXO it holds is unexplained, and
    // classifying any of them would report the user's own change as a stranger's payment.
    expect(journalCovers(null, 5_000)).toBe(false)
  })

  it('claims nothing while coverage is empty — today’s state for every wallet', () => {
    expect(journalCovers(epoch({ covers: [], coverageCompleteAt: null }), 9_999)).toBe(false)
  })

  it('claims nothing while ANY output-creating action is unrecorded', () => {
    // A perfectly HEALTHY journal that was never asked about chat payments still misses their
    // change outputs. Health and coverage are different questions and both must be yes.
    for (const missing of OUTPUT_CREATING_ACTIONS) {
      const partial = OUTPUT_CREATING_ACTIONS.filter(a => a !== missing)
      expect(journalCovers(epoch({ covers: partial }), 9_999)).toBe(false)
    }
  })

  it('claims nothing if the set is complete but the moment was never stamped', () => {
    expect(journalCovers(epoch({ coverageCompleteAt: null }), 9_999)).toBe(false)
  })

  it('refuses EVERYTHING once a write has been lost, however recent', () => {
    // A dropped write leaves a hole with no other trace, and a hole turns our own output into a
    // fabricated receive. One failure disqualifies the whole record.
    expect(journalCovers(epoch({ degradedAt: 3_000 }), 9_999)).toBe(false)
    expect(journalCovers(epoch({ degradedAt: 3_000 }), 2_500)).toBe(false)
  })

  it('claims nothing about anything first seen BEFORE coverage completed', () => {
    // The output of an action nobody was recording at the time.
    expect(journalCovers(epoch(), 1_999)).toBe(false)
    expect(journalCovers(epoch(), 1_500)).toBe(false)   // after startedAt, before coverage
  })

  it('measures against coverageCompleteAt, not startedAt — the stricter threshold', () => {
    const e = epoch({ startedAt: 1_000, coverageCompleteAt: 5_000 })
    expect(journalCovers(e, 2_000)).toBe(false)   // journalling had begun, coverage had not
    expect(journalCovers(e, 5_000)).toBe(true)
  })

  it('is true ONLY under the full conjunction', () => {
    expect(journalCovers(epoch(), 2_000)).toBe(true)
    expect(journalCovers(epoch(), 9_999)).toBe(true)
  })
})

describe('unresolvedOutputs — the hole the data shows by itself', () => {
  // An action that committed made whatever outputs it made, whether or not we wrote them down. A
  // committed entry with no recorded outputs is therefore an output of OURS sitting in the owned
  // set with nothing to subtract it — which is exactly what a later scan reads as a payment from
  // a stranger. Derived rather than flagged, so a repair clears it and nobody has to remember to
  // set anything.

  const committed = (over: Partial<JournalEntry> = {}): JournalEntry =>
    ({ ...draftToEntry(DRAFT), outcome: 'committed', selfOutputIds: [], ...over })

  it('is clean when every committed action recorded its outputs', () => {
    const journal = [committed({ selfOutputIds: ['utxo_a'] }), committed({ selfOutputIds: [] })]
    expect(unresolvedOutputs(journal)).toEqual([])
    expect(outputsFullyAccounted(journal)).toBe(true)
  })

  it('flags a committed entry that never recorded what it created', () => {
    // The @name capture that failed, or a tab closed before the read finished.
    const hole = committed({ kind: 'ons-register', selfOutputIds: null })
    expect(unresolvedOutputs([committed(), hole])).toEqual([hole])
    expect(outputsFullyAccounted([committed(), hole])).toBe(false)
  })

  it('treats [] as accounted, not as a hole', () => {
    // The distinction the whole field exists for: [] is a positive "this made nothing for us".
    expect(outputsFullyAccounted([committed({ selfOutputIds: [] })])).toBe(true)
  })

  it('does not flag actions that never committed', () => {
    // Neither is known to have landed, so neither is known to have created anything. If one later
    // turns out to have landed, the baseline is what covers its output.
    for (const outcome of ['pending', 'rejected', 'timeout', 'failed'] as const) {
      expect(outputsFullyAccounted([committed({ outcome, selfOutputIds: null })])).toBe(true)
    }
  })

  it('does not flag a receive — somebody else made that output', () => {
    expect(outputsFullyAccounted([committed({ kind: 'receive', selfOutputIds: null })])).toBe(true)
  })

  it('clears once the entry is repaired', () => {
    // Why this is derived instead of degrading the epoch: the transaction result stays fetchable,
    // so the failure is a network blip rather than a lost fact, and a retry fixes it.
    const hole = committed({ kind: 'ons-register', selfOutputIds: null })
    expect(outputsFullyAccounted([hole])).toBe(false)
    expect(outputsFullyAccounted([{ ...hole, selfOutputIds: ['utxo_change'] }])).toBe(true)
  })
})
