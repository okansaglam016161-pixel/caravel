// The Activity merge.
//
// Three sources feed one list and two of them overlap, so most of what matters here is about which
// row survives and which figures reach the screen. The swap cases are the load-bearing ones: a
// move between the user's own balances is neither an inflow nor an outflow, and a list that
// classified it as either would be stating a confident wrong figure.

import { describe, expect, it } from 'vitest'
import { buildActivity, type ActivityRow } from './activity'
import { draftToEntry, type JournalEntry } from './journal'
import type { SentEntry } from './txHistory'
import type { CaravelMessage } from '../messaging/types'

const ADDRESS = 'otl_esm_1tnay4uzgpe0cvu4tzwfmhdhtvc3pq97szrnteetuz2dvqmjk2ecwq34fnsm8hz7tk43xrur8d2y6mye4w3shjq4qj5sm7xvpq7yqqngs8224p'

function journalled(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ...draftToEntry({
      kind: 'send',
      amountMicrotari: 8_000_000n,
      feeMicrotari: 14_457n,
      from: 'private',
      to: 'external',
      counterparty: { kind: 'address', value: ADDRESS },
      note: 'oi',
      source: 'local-journal',
      selfOutputIds: [],
    }, 1_000),
    ...over,
  }
}

function legacySend(over: Partial<SentEntry> = {}): SentEntry {
  return {
    type: 'sent', id: 'tx_legacy', recipient: ADDRESS, amountMicrotari: 5_000_000n,
    note: 'old', txHash: 'tx_legacy', timestamp: 500, outcome: 'Commit', ...over,
  }
}

const kinds = (rows: ActivityRow[]) => rows.map(r => r.kind)

describe('the journalled kinds reach the list', () => {
  it('renders a send, both swaps and a faucet claim', () => {
    const rows = buildActivity([
      journalled({ id: 'a', kind: 'send', timestamp: 4 }),
      journalled({ id: 'b', kind: 'make-private', timestamp: 3 }),
      journalled({ id: 'c', kind: 'make-public', timestamp: 2 }),
      journalled({ id: 'd', kind: 'faucet', timestamp: 1 }),
    ], [], [])
    expect(kinds(rows)).toEqual(['sent', 'swap', 'swap', 'faucet'])
  })

  it('takes a swap’s direction from the structured record, not a label', () => {
    const [toPrivate] = buildActivity([journalled({ kind: 'make-private' })], [], [])
    const [toPublic] = buildActivity([journalled({ kind: 'make-public' })], [], [])
    expect(toPrivate).toMatchObject({ kind: 'swap', to: 'private' })
    expect(toPublic).toMatchObject({ kind: 'swap', to: 'public' })
  })

  it('never emits a swap that moves a balance into itself', () => {
    for (const kind of ['make-private', 'make-public'] as const) {
      const [row] = buildActivity([journalled({ kind })], [], [])
      const swap = row as Extract<ActivityRow, { kind: 'swap' }>
      const from = swap.to === 'private' ? 'public' : 'private'
      expect(from).not.toBe(swap.to)
    }
  })

  it('carries the fee the journal recorded, and the FULL address', () => {
    const [row] = buildActivity([journalled()], [], [])
    expect(row).toMatchObject({ kind: 'sent', feeMicrotari: 14_457n, counterpartyValue: ADDRESS })
  })

  it('ignores a `receive` entry — that is the reconciliation phase’s output, not this one’s', () => {
    expect(buildActivity([journalled({ kind: 'receive' })], [], [])).toEqual([])
  })
})

describe('amounts are never invented', () => {
  it('keeps a null amount null', () => {
    const [row] = buildActivity([journalled({ amountMicrotari: null })], [], [])
    expect(row).toMatchObject({ amountMicrotari: null })
  })

  it('keeps a null amount null on a swap and a faucet claim too', () => {
    const rows = buildActivity([
      journalled({ id: 'x', kind: 'make-public', amountMicrotari: null }),
      journalled({ id: 'y', kind: 'faucet', amountMicrotari: null }),
    ], [], [])
    for (const r of rows) expect(r).toMatchObject({ amountMicrotari: null })
  })
})

describe('outcomes normalise onto one vocabulary', () => {
  it('maps the journal’s states through unchanged', () => {
    for (const outcome of ['committed', 'rejected', 'timeout', 'failed', 'pending'] as const) {
      const [row] = buildActivity([journalled({ outcome })], [], [])
      expect(row).toMatchObject({ outcome })
    }
  })

  it('translates the legacy store’s three', () => {
    const [c] = buildActivity([], [legacySend({ outcome: 'Commit' })], [])
    const [r] = buildActivity([], [legacySend({ outcome: 'Reject' })], [])
    const [t] = buildActivity([], [legacySend({ outcome: 'Timeout' })], [])
    expect(c).toMatchObject({ outcome: 'committed' })
    expect(r).toMatchObject({ outcome: 'rejected' })
    // A TIMEOUT IS NOT A FAILURE. It was broadcast and may still land; collapsing the two here is
    // how the list would start telling someone their money is safe when it may not be.
    expect(t).toMatchObject({ outcome: 'timeout' })
  })

  it('says `unknown` for a chat send rather than assuming it landed', () => {
    const [row] = buildActivity([], [], [chatSend()])
    expect(row).toMatchObject({ outcome: 'unknown', source: 'chat-ref' })
  })
})

describe('dedupe', () => {
  it('shows ONE row when a send is in both the journal and the legacy store', () => {
    const rows = buildActivity(
      [journalled({ txId: 'tx_same' })],
      [legacySend({ id: 'tx_same', txHash: 'tx_same' })],
      [],
    )
    expect(rows).toHaveLength(1)
  })

  it('keeps the JOURNAL’s row, because it is the richer one', () => {
    const [row] = buildActivity(
      [journalled({ txId: 'tx_same', feeMicrotari: 14_457n })],
      [legacySend({ id: 'tx_same', txHash: 'tx_same' })],
      [],
    )
    // The legacy store never recorded a fee and truncated the address into prose.
    expect(row).toMatchObject({ source: 'local-journal', feeMicrotari: 14_457n, counterpartyValue: ADDRESS })
  })

  it('keeps a legacy send the journal does not have — every send made before Phase 1', () => {
    const rows = buildActivity([], [legacySend({ txHash: 'tx_old' })], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ feeMicrotari: null })   // unrecoverable now, and said so
  })

  it('does NOT dedupe a journal entry with no txId — an attempt that never reached the network', () => {
    const rows = buildActivity(
      [journalled({ id: 'attempt', txId: null, outcome: 'pending' })],
      [legacySend({ txHash: 'tx_other' })],
      [],
    )
    expect(rows).toHaveLength(2)
  })

  it('keeps BOTH rows for a retry — it really was two attempts', () => {
    const rows = buildActivity([
      journalled({ id: 'first', txId: null, outcome: 'failed', timestamp: 1 }),
      journalled({ id: 'second', txId: 'tx_ok', outcome: 'committed', timestamp: 2 }),
    ], [], [])
    expect(rows).toHaveLength(2)
  })

  it('dedupes a chat send against the journal too, so Phase 3 cannot double-render', () => {
    const rows = buildActivity(
      [journalled({ txId: 'tx_chat' })],
      [],
      [chatSend({ localPayment: { amountMicrotari: '8000000', txId: 'tx_chat' } })],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'local-journal' })
  })
})

describe('ordering', () => {
  it('is newest first across all three sources', () => {
    const rows = buildActivity(
      [journalled({ id: 'j', timestamp: 300 })],
      [legacySend({ id: 'l', txHash: 'l', timestamp: 100 })],
      [chatReceived({ timestamp: 200 })],
    )
    expect(rows.map(r => r.timestamp)).toEqual([300, 200, 100])
  })
})

// ── message fixtures ──────────────────────────────────────────────────────────

function chatSend(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: 'msg_sent', direction: 'sent', plaintext: 'here you go',
    senderPubkeyHex: 'aa'.repeat(32), recipientPubkeyHex: 'bb'.repeat(32),
    timestamp: 10, payment: { utxoId: 'utxo_1' },
    ...over,
  } as CaravelMessage
}

function chatReceived(over: Partial<CaravelMessage> = {}): CaravelMessage {
  return {
    id: 'msg_recv', direction: 'received', plaintext: 'thanks',
    senderPubkeyHex: 'cc'.repeat(32),
    timestamp: 20, payment: { utxoId: 'utxo_2' },
    ...over,
  } as CaravelMessage
}
