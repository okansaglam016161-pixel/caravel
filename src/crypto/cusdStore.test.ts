import { beforeEach, describe, expect, it } from 'vitest'
import { loadCusdClaims, recordCusdClaim, cusdClaimsSnapshot, subscribeCusdClaims } from './cusdStore'
import { setStoreKey } from './sessionKey'

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

const ADDR = 'otl_esm_1cusdclaimtest000000000000000000'
const rec = (journalId: string, units: bigint) => ({
  journalId, txId: 'tx' + journalId, outputId: 'utxo_cusd_' + journalId, units, at: 1,
})

beforeEach(() => {
  globalThis.localStorage = memoryStorage()
  setStoreKey(new Uint8Array(32).fill(7))
})

describe('cUSD claim store', () => {
  it('records a claim and reads it back through the sealed store, bigints intact', () => {
    expect(recordCusdClaim(ADDR, rec('j1', 10_000_000_000n))).toBe(true)
    const [back] = loadCusdClaims(ADDR)
    expect(back.units).toBe(10_000_000_000n)
    expect(back.journalId).toBe('j1')
  })

  it('replaces by journal id rather than duplicating', () => {
    recordCusdClaim(ADDR, rec('j1', 1n))
    recordCusdClaim(ADDR, rec('j1', 2n))
    const all = loadCusdClaims(ADDR)
    expect(all).toHaveLength(1)
    expect(all[0].units).toBe(2n)
  })

  it('keeps each wallet’s claims apart', () => {
    recordCusdClaim(ADDR, rec('j1', 1n))
    expect(loadCusdClaims('otl_esm_1other')).toEqual([])
  })

  it('snapshot is stable between writes and invalidated by one (for useSyncExternalStore)', () => {
    recordCusdClaim(ADDR, rec('j1', 1n))
    const a = cusdClaimsSnapshot(ADDR)
    expect(cusdClaimsSnapshot(ADDR)).toBe(a)          // same reference, no churn
    let fired = 0
    const off = subscribeCusdClaims(() => { fired++ })
    recordCusdClaim(ADDR, rec('j2', 2n))
    expect(fired).toBe(1)
    expect(cusdClaimsSnapshot(ADDR)).not.toBe(a)       // invalidated
    off()
  })
})
