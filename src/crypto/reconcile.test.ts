// Where the false-receive risk is pinned.
//
// The failure this whole phase exists to prevent has a name and a history: a scan-derived Activity
// once reported the user's own change, faucet deposits and dust as "Received · No note", and was
// reverted. Every test below is a way that could happen again, and the assertion is always the
// same shape — nothing is classified.
//
// The positive cases are almost incidental. What matters is that each guard, broken on its own,
// produces silence rather than a stranger.

import { describe, expect, it } from 'vitest'
import { reconcile, type ReconcileInput } from './reconcile'
import { OUTPUT_CREATING_ACTIONS, draftToEntry, type JournalEntry, type JournalEpoch } from './journal'
import type { UtxoLedger } from './utxoLedger'
import type { ScannedUtxo } from './walletScanner'

const OLD = 'utxo_0101_old'          // owned before coverage — in the baseline
const CHANGE = 'utxo_0101_change'    // our own change from a journalled action
const IN = 'utxo_0101_incoming'      // a genuine receive, after the flip
const CHAT = 'utxo_0101_chatpay'     // a receive chat already attributed

const COVERAGE_AT = 5_000

function utxo(id: string, over: Partial<ScannedUtxo> = {}): ScannedUtxo {
  return { id, commitment: id.slice(-6), amount: 1_000_000n, payRef: '', message: '', ...over }
}

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ...draftToEntry({
      kind: 'send', amountMicrotari: 1n, feeMicrotari: null,
      from: 'private', to: 'external', counterparty: null, note: null,
      source: 'local-journal', selfOutputIds: [CHANGE], spentInputIds: null,
    }),
    outcome: 'committed',
    ...over,
  }
}

const healthyEpoch = (over: Partial<JournalEpoch> = {}): JournalEpoch => ({
  startedAt: 1_000,
  degradedAt: null,
  covers: [...OUTPUT_CREATING_ACTIONS],
  coverageCompleteAt: COVERAGE_AT,
  ...over,
})

const ledgerWith = (over: Partial<UtxoLedger> = {}): UtxoLedger => ({
  firstSeen: { [OLD]: 4_000, [CHANGE]: 6_000, [IN]: 6_000, [CHAT]: 6_000 },
  baseline: [OLD],
  baselineAt: COVERAGE_AT,
  degradedAt: null,
  ...over,
})

/** The good state: coverage complete, journal healthy, one genuine incoming UTXO. */
function base(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    owned: [utxo(OLD), utxo(CHANGE), utxo(IN)],
    journal: [entry()],
    ledger: ledgerWith(),
    epoch: healthyEpoch(),
    ...over,
  }
}

const ids = (rs: { utxoId: string }[]) => rs.map(r => r.utxoId)

describe('the subtraction', () => {
  it('classifies a genuine leftover as a receive', () => {
    const { receives, reason } = reconcile(base())
    expect(reason).toBeNull()
    expect(ids(receives)).toEqual([IN])
  })

  it('NEVER classifies our own journalled change', () => {
    // The core failure. This UTXO is owned, carries no sender, and is indistinguishable from a
    // payment — except that we wrote down its commitment when we made it.
    const { receives } = reconcile(base())
    expect(ids(receives)).not.toContain(CHANGE)
  })

  it('subtracts self-outputs from every kind of action, not just sends', () => {
    for (const kind of ['make-private', 'make-public', 'faucet', 'chat-payment', 'ons-register'] as const) {
      const { receives } = reconcile(base({ journal: [entry({ kind, selfOutputIds: [CHANGE] })] }))
      expect(ids(receives)).not.toContain(CHANGE)
    }
  })

  it('does not double-count a receive chat has already attributed', () => {
    // A chat payment's UTXO is owned and is NOT one of our outputs, so the subtraction alone leaves
    // it as an unattributed receive sitting beside the row that already names the sender.
    const r = reconcile(base({
      owned: [utxo(OLD), utxo(CHANGE), utxo(IN), utxo(CHAT)],
      knownReceiveUtxoIds: [CHAT],
    }))
    expect(ids(r.receives)).toEqual([IN])
    expect(ids(r.suppressed)).not.toContain(CHAT)   // removed before classification, not suppressed
  })

  it('reports the amount the scan decrypted, exactly', () => {
    const { receives } = reconcile(base({ owned: [utxo(IN, { amount: 9_007_199_254_740_993n })] }))
    expect(receives[0].amountMicrotari).toBe(9_007_199_254_740_993n)
  })

  it('never names a sender', () => {
    const { receives } = reconcile(base())
    expect(Object.keys(receives[0])).not.toContain('sender')
    expect(Object.keys(receives[0])).not.toContain('counterparty')
  })
})

describe('every guard fails toward suppression', () => {
  it('no journal at all → nothing classified', () => {
    // A wallet older than journalling, or one whose storage was cleared. Every UTXO it holds is
    // unexplained, and every one of them could be its own change.
    const r = reconcile(base({ epoch: null }))
    expect(r.receives).toEqual([])
    expect(r.reason).toBe('no-epoch')
  })

  it('a lost journal write → nothing classified, however recent', () => {
    const r = reconcile(base({ epoch: healthyEpoch({ degradedAt: 9_000 }) }))
    expect(r.receives).toEqual([])
    expect(r.reason).toBe('degraded')
  })

  it('coverage incomplete → nothing classified', () => {
    // A perfectly HEALTHY journal that was never asked to record chat payments still misses their
    // change outputs.
    const partial = OUTPUT_CREATING_ACTIONS.filter(a => a !== 'chat-payment')
    const r = reconcile(base({ epoch: healthyEpoch({ covers: partial }) }))
    expect(r.receives).toEqual([])
    expect(r.reason).toBe('coverage-incomplete')
  })

  it('coverage complete but never stamped → nothing classified', () => {
    const r = reconcile(base({ epoch: healthyEpoch({ coverageCompleteAt: null }) }))
    expect(r.receives).toEqual([])
    expect(r.reason).toBe('coverage-incomplete')
  })

  it('a committed action with unrecorded outputs → nothing classified', () => {
    // The derived hole. That action made an output whether or not we wrote it down, so there is one
    // of ours in the owned set with nothing to subtract it.
    const r = reconcile(base({
      journal: [entry(), entry({ kind: 'ons-register', selfOutputIds: null })],
    }))
    expect(r.receives).toEqual([])
    expect(r.reason).toBe('unresolved-outputs')
  })

  it('reports every leftover as suppressed when the journal is blocked', () => {
    const r = reconcile(base({ epoch: null }))
    // The change output too — nothing is trusted while the journal cannot be reasoned from.
    expect(ids(r.suppressed).sort()).toEqual([OLD, IN].sort())
  })
})

describe('per-UTXO guards', () => {
  it('never classifies a UTXO that was already owned when coverage completed', () => {
    const r = reconcile(base())
    expect(ids(r.receives)).not.toContain(OLD)
    expect(r.suppressed).toContainEqual({ utxoId: OLD, reason: 'pre-epoch' })
  })

  it('classifies nothing while no baseline has been taken', () => {
    // Every wallet before stage D. With no baseline nothing is known to be new.
    const r = reconcile(base({ ledger: ledgerWith({ baseline: null, baselineAt: null }) }))
    expect(r.receives).toEqual([])
    expect(r.suppressed.every(s => s.reason === 'pre-epoch')).toBe(true)
  })

  it('suppresses a UTXO no complete scan has reported', () => {
    // Also how a TRUNCATED scan is handled with no separate guard: the ledger refuses to stamp one,
    // so anything only a partial scan has shown has no date and waits for a complete one.
    const r = reconcile(base({ ledger: ledgerWith({ firstSeen: { [OLD]: 4_000, [CHANGE]: 6_000 } }) }))
    expect(r.receives).toEqual([])
    expect(r.suppressed).toContainEqual({ utxoId: IN, reason: 'never-seen' })
  })

  it('suppresses a UTXO first seen before coverage completed', () => {
    const r = reconcile(base({
      ledger: ledgerWith({ firstSeen: { [OLD]: 4_000, [CHANGE]: 6_000, [IN]: COVERAGE_AT - 1 } }),
    }))
    expect(r.receives).toEqual([])
    expect(r.suppressed).toContainEqual({ utxoId: IN, reason: 'seen-before-coverage' })
  })

  it('classifies one seen exactly AT the coverage moment', () => {
    const r = reconcile(base({
      ledger: ledgerWith({ firstSeen: { [OLD]: 4_000, [CHANGE]: 6_000, [IN]: COVERAGE_AT } }),
    }))
    expect(ids(r.receives)).toEqual([IN])
  })
})

describe('confidence tiers', () => {
  it('is `inferred` with no memo — a receive because the subtraction says so, nothing more', () => {
    const { receives } = reconcile(base())
    expect(receives[0]).toMatchObject({ confidence: 'inferred', message: null, payRef: null })
  })

  it('is `memo` when the sender left words, and surfaces them', () => {
    // Sound in one direction only: every output this wallet builds for itself is created without a
    // memo, so a memo proves the output is not ours. Its ABSENCE proves nothing.
    const { receives } = reconcile(base({ owned: [utxo(IN, { message: 'for lunch' })] }))
    expect(receives[0]).toMatchObject({ confidence: 'memo', message: 'for lunch' })
  })

  it('is `memo` on a payRef alone', () => {
    const { receives } = reconcile(base({ owned: [utxo(IN, { payRef: 'inv-42' })] }))
    expect(receives[0]).toMatchObject({ confidence: 'memo', payRef: 'inv-42', message: null })
  })

  it('treats an empty memo as absent, not as words', () => {
    const { receives } = reconcile(base({ owned: [utxo(IN, { message: '', payRef: '' })] }))
    expect(receives[0]).toMatchObject({ confidence: 'inferred', message: null })
  })

  it('does NOT let a memo bypass a guard', () => {
    // A memo raises confidence in something already classified. It is not a way past the baseline:
    // a pre-epoch UTXO stays unclassified whatever is written on it.
    const r = reconcile(base({ owned: [utxo(OLD, { message: 'hello' })] }))
    expect(r.receives).toEqual([])
    expect(r.suppressed).toContainEqual({ utxoId: OLD, reason: 'pre-epoch' })
  })
})

describe('ordering and shape', () => {
  it('returns receives newest first', () => {
    const A = 'utxo_0101_a', B = 'utxo_0101_b'
    const r = reconcile(base({
      owned: [utxo(A), utxo(B)],
      ledger: ledgerWith({ firstSeen: { [A]: 6_000, [B]: 8_000 }, baseline: [] }),
    }))
    expect(ids(r.receives)).toEqual([B, A])
  })

  it('is empty and unblocked when the wallet owns nothing', () => {
    expect(reconcile(base({ owned: [] }))).toEqual({ receives: [], suppressed: [], reason: null })
  })

  it('does not mutate its inputs', () => {
    const input = base()
    const ownedBefore = [...input.owned]
    reconcile(input)
    expect(input.owned).toEqual(ownedBefore)
  })
})
