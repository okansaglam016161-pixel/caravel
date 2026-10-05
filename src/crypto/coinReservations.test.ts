// Coins held by a prepared transaction: excluded from selection, never from the balance, released
// by their own token only, and gone by themselves after the TTL.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RESERVATION_TTL_MS, __resetReservationsForTests, loadReservedIds, loadSelectionExcludedIds,
  newReservationToken, releaseCoins, reserveCoins,
} from './coinReservations'
import { loadExcludedIds, markLocked } from './spentOutputs'
import { clearStoreKey, setStoreKey } from './sessionKey'

const ADDR = 'otl_esm_reserve_test'

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

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(new Uint8Array(32).fill(7))
  __resetReservationsForTests()
})
afterEach(() => { clearStoreKey() })

describe('reserveCoins / releaseCoins', () => {
  it('holds coins for selection — and only for selection, never the balance', () => {
    const t = newReservationToken()
    expect(reserveCoins(ADDR, ['utxo_a', 'utxo_b'], t)).toBe(true)
    expect([...loadReservedIds(ADDR)].sort()).toEqual(['utxo_a', 'utxo_b'])
    expect(loadSelectionExcludedIds(ADDR).has('utxo_a')).toBe(true)
    // The balance's exclusion is the spend record alone: a review screen must not hide money.
    expect(loadExcludedIds(ADDR).has('utxo_a')).toBe(false)
  })

  it('selection also skips what the spend record excludes', () => {
    markLocked(ADDR, ['utxo_wire'], 'tx1')
    expect(loadSelectionExcludedIds(ADDR).has('utxo_wire')).toBe(true)
  })

  it('releases only its own token', () => {
    const mine = newReservationToken()
    const theirs = newReservationToken()
    reserveCoins(ADDR, ['utxo_a'], mine)
    reserveCoins(ADDR, ['utxo_b'], theirs)
    releaseCoins(ADDR, mine)
    expect([...loadReservedIds(ADDR)]).toEqual(['utxo_b'])
  })

  it('a coin already held by another live token stays with it, and the clash is reported', () => {
    const first = newReservationToken()
    const second = newReservationToken()
    reserveCoins(ADDR, ['utxo_a'], first)
    expect(reserveCoins(ADDR, ['utxo_a', 'utxo_c'], second)).toBe(false)
    releaseCoins(ADDR, second)
    expect([...loadReservedIds(ADDR)]).toEqual(['utxo_a'])   // still the first's
  })

  it('expires by itself after the TTL — a tab closed on a review screen holds nothing for long', () => {
    const now = 1_000_000
    reserveCoins(ADDR, ['utxo_a'], newReservationToken(), now)
    expect(loadReservedIds(ADDR, now + RESERVATION_TTL_MS - 1).has('utxo_a')).toBe(true)
    expect(loadReservedIds(ADDR, now + RESERVATION_TTL_MS).has('utxo_a')).toBe(false)
  })

  it('is sealed at rest — no coin id in plaintext storage', () => {
    reserveCoins(ADDR, ['utxo_findme'], newReservationToken())
    const raw = localStorage.getItem(`caravel.utxoreserved.v1.${ADDR}`) ?? ''
    expect(raw).not.toBe('')
    expect(raw).not.toContain('utxo_findme')
  })

  it('falls back to this tab\'s memory with no store key', () => {
    clearStoreKey()
    const t = newReservationToken()
    reserveCoins(ADDR, ['utxo_a'], t)
    expect(loadReservedIds(ADDR).has('utxo_a')).toBe(true)
    releaseCoins(ADDR, t)
    expect(loadReservedIds(ADDR).size).toBe(0)
  })
})
