// txHistory at rest (stage 3).
//
// This store had no spec before encryption reached it. These cover the Stage 3 surface — the
// envelope, the migration, and the two write refusals — rather than retro-fitting the store's
// older semantics, with one exception: the legacy `received`-row filter is exercised here because
// it WRITES DURING A READ, and that interaction with the never-clobber guard is new.

import { beforeEach, describe, expect, it } from 'vitest'
import { addSent, loadHistory } from './txHistory'
import { clearStoreKey, setStoreKey } from './sessionKey'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

const ADDR = 'otl_esm_1tnay4uzgpe0cvu4tzwfmhdhtvc3pq97s'
const HKEY = 'caravel.txhistory.v1.' + ADDR
const STORE_KEY = new Uint8Array(32).fill(42)

const SEND = {
  recipient: 'otl_esm_1recipient',
  amountMicrotari: 1_500_000n,
  note: 'lunch with mira',
  txHash: 'tx-abc',
  outcome: 'Commit' as const,
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(Uint8Array.from(STORE_KEY))
})

describe('encryption at rest', () => {
  it('writes ciphertext, not readable JSON', () => {
    addSent(ADDR, [], SEND)
    const stored = localStorage.getItem(HKEY)!
    expect(stored).not.toContain('lunch with mira')
    expect(stored).not.toContain('otl_esm_1recipient')
    expect(stored).not.toContain('1500000')
    expect(JSON.parse(stored).v).toBe(2)
  })

  it('round-trips a send, bigint amount included', () => {
    addSent(ADDR, [], SEND)
    const [entry] = loadHistory(ADDR)
    expect(entry.recipient).toBe('otl_esm_1recipient')
    expect(entry.note).toBe('lunch with mira')
    expect(entry.amountMicrotari).toBe(1_500_000n)
    expect(entry.outcome).toBe('Commit')
  })

  it('cannot be read with a different key, or with none', () => {
    addSent(ADDR, [], SEND)
    setStoreKey(new Uint8Array(32).fill(7))
    expect(loadHistory(ADDR)).toEqual([])
    clearStoreKey()
    expect(loadHistory(ADDR)).toEqual([])
  })

  it('keeps wallets apart', () => {
    addSent(ADDR, [], SEND)
    expect(loadHistory('otl_esm_1someoneelse')).toEqual([])
  })
})

describe('migration from plaintext', () => {
  function seedLegacy(rows: unknown[]) {
    localStorage.setItem(HKEY, JSON.stringify(rows))
  }
  const legacySend = {
    type: 'sent', id: 'tx-old', recipient: 'otl_esm_1old', amountMicrotari: '2500000',
    note: 'older payment', txHash: 'tx-old', timestamp: 900, outcome: 'Commit',
  }

  it('reads a plaintext store written before encryption existed', () => {
    seedLegacy([legacySend])
    const [entry] = loadHistory(ADDR)
    expect(entry.id).toBe('tx-old')
    expect(entry.note).toBe('older payment')
    expect(entry.amountMicrotari).toBe(2_500_000n)
  })

  it('re-emits the whole store SEALED on the next write, losing nothing', () => {
    seedLegacy([legacySend])
    expect(Array.isArray(JSON.parse(localStorage.getItem(HKEY)!))).toBe(true)

    addSent(ADDR, loadHistory(ADDR), SEND)

    expect(JSON.parse(localStorage.getItem(HKEY)!).v).toBe(2)
    const ids = loadHistory(ADDR).map(e => e.id).sort()
    expect(ids).toEqual(['tx-abc', 'tx-old'])
    expect(loadHistory(ADDR).find(e => e.id === 'tx-old')!.amountMicrotari).toBe(2_500_000n)
  })

  it('the legacy received-row filter migrates DURING THE READ, and seals as it does', () => {
    // This store's read path re-persists when it strips legacy `received` noise, so a store
    // carrying those rows reaches the sealed format without waiting for a send.
    seedLegacy([legacySend, { type: 'received', id: 'r1', amountMicrotari: '5' }])
    const entries = loadHistory(ADDR)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('tx-old')
    expect(JSON.parse(localStorage.getItem(HKEY)!).v).toBe(2)
  })
})

describe('refusing to write', () => {
  it('will not write with no store key', () => {
    clearStoreKey()
    addSent(ADDR, [], SEND)
    expect(localStorage.getItem(HKEY)).toBeNull()
  })

  it('NEVER OVERWRITES A HISTORY IT COULD NOT READ', () => {
    addSent(ADDR, [], SEND)
    const original = localStorage.getItem(HKEY)!

    setStoreKey(new Uint8Array(32).fill(7))
    expect(loadHistory(ADDR)).toEqual([])

    addSent(ADDR, [], { ...SEND, txHash: 'tx-new' })
    expect(localStorage.getItem(HKEY)).toBe(original)

    setStoreKey(Uint8Array.from(STORE_KEY))
    expect(loadHistory(ADDR)[0].note).toBe('lunch with mira')
  })

  it('does not let the read-path migration write over an unreadable record', () => {
    // The ordering that matters: the unreadable check runs BEFORE the received-row filter, so a
    // record we could not open never triggers a self-heal that writes over itself.
    addSent(ADDR, [], SEND)
    const original = localStorage.getItem(HKEY)!
    setStoreKey(new Uint8Array(32).fill(7))
    expect(loadHistory(ADDR)).toEqual([])
    expect(localStorage.getItem(HKEY)).toBe(original)
  })

  it('still writes normally over an EMPTY store', () => {
    expect(localStorage.getItem(HKEY)).toBeNull()
    addSent(ADDR, [], SEND)
    expect(loadHistory(ADDR)).toHaveLength(1)
  })
})
