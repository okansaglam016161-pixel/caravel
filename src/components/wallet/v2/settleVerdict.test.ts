import { describe, it, expect } from 'vitest'
import { settleVerdict, journalOutcomeFor } from './settleVerdict'

describe('settleVerdict', () => {
  describe('an observed balance movement is proof, whatever the builder said', () => {
    it('confirms a settled watch that began from Commit', () => {
      expect(settleVerdict('Commit', 'settled')).toEqual({ kind: 'confirmed', lagged: false })
    })

    it('confirms a settled watch that began from Timeout — the self-correction', () => {
      // The whole point of watching a Timeout: the send did land, we just had to wait for it.
      expect(settleVerdict('Timeout', 'settled')).toEqual({ kind: 'confirmed', lagged: false })
    })

    it('never reports a settled watch as lagged', () => {
      expect(settleVerdict('Commit', 'settled').kind).toBe('confirmed')
      expect(settleVerdict('Timeout', 'settled')).not.toMatchObject({ lagged: true })
    })
  })

  describe('a passed deadline means only what the start justifies', () => {
    it('keeps a Commit-started lagged watch a success — the receipt already proved it', () => {
      expect(settleVerdict('Commit', 'lagged')).toEqual({ kind: 'confirmed', lagged: true })
    })

    // ── THE CELL THIS MODULE EXISTS FOR ────────────────────────────────────────
    //
    // Nothing was observed twice: the builder's poll gave up, and the balance never moved. Reusing
    // the Commit row here would render "Sent" over a transaction nobody ever saw land.
    it('NEVER claims it was sent when a Timeout deadline passes with nothing observed', () => {
      const verdict = settleVerdict('Timeout', 'lagged')
      expect(verdict).toEqual({ kind: 'unknown' })
      expect(verdict.kind).not.toBe('confirmed')
    })

    it('does not merely mark a Timeout-lagged watch as a LAGGED success', () => {
      // The specific regression: inheriting { kind: 'confirmed', lagged: true } would still read as
      // "Sent" with a caveat, and would still assert the money moved.
      expect(settleVerdict('Timeout', 'lagged')).not.toMatchObject({ kind: 'confirmed' })
      expect(settleVerdict('Timeout', 'lagged')).not.toEqual(settleVerdict('Commit', 'lagged'))
    })
  })

  describe('journalOutcomeFor', () => {
    it('commits the journal entry on every confirmed verdict', () => {
      expect(journalOutcomeFor(settleVerdict('Commit', 'settled'))).toBe('committed')
      expect(journalOutcomeFor(settleVerdict('Timeout', 'settled'))).toBe('committed')
      expect(journalOutcomeFor(settleVerdict('Commit', 'lagged'))).toBe('committed')
    })

    it('writes NOTHING on an unknown verdict, leaving the entry as it stands', () => {
      // Not 'failed', not 'committed' — no patch at all. A second absence of evidence is not a
      // finding, and the entry keeps saying `timeout`, which is true.
      expect(journalOutcomeFor(settleVerdict('Timeout', 'lagged'))).toBeNull()
    })
  })
})
