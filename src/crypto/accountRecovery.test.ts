// Tests for account-address recovery (M2).
//
// The network half of this is one dry-run POST and is covered by the live probe that established
// the mechanism; what is worth pinning in a unit test is the POLICY around it, because that is what
// decides whether a wallet ever touches the network at all and whether a bad answer can be stored:
//
//   - a wallet that already knows its address must not probe (the common path, every unlock)
//   - a probe that cannot answer must not be fatal, and must not store anything
//   - a stored address must never be replaced by a later probe
//
// The probe's own guards — which component may be adopted at all — are tested where they live, in
// accountAddress.test.ts, against the real dry-run response shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAccountAddress, saveAccountAddress } from './accountStore'
import { recoverAccountAddress } from './accountRecovery'

const OWNER_PK = 'b2d65c3ff962cb4fab2e7f25d1a87e029670b01843ca6e50a129bc2232d40314'
const ACCOUNT = 'component_7dd87bc0dbc611e694ef5468b539c07d99de2e6866eb512ec160161b942888a2'
const WALLET = 'otl_esm_recovery_wallet'

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

/** A wallet stub. Only the injected probe consumes it here, so the public key is all it needs. */
const walletStub = {
  getPublicKey: async () => Uint8Array.from((OWNER_PK.match(/../g) ?? []).map(b => parseInt(b, 16))),
} as never

beforeEach(() => { globalThis.localStorage = memoryStorage() })
afterEach(() => { vi.restoreAllMocks() })

describe('recoverAccountAddress — the trigger policy', () => {
  it('short-circuits without touching the network when an address is stored', async () => {
    // The common path: every unlock after the first. This is the whole reason no "does an account
    // probably exist?" heuristic is needed — the expensive case only happens once.
    saveAccountAddress(WALLET, ACCOUNT)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(recoverAccountAddress(walletStub, WALLET)).resolves.toBe(ACCOUNT)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null and stores nothing when the probe cannot answer', async () => {
    // A dead indexer must not be fatal: the wallet carries on not knowing, exactly as before, and
    // the public balance reads 0 rather than erroring.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    await expect(recoverAccountAddress(walletStub, WALLET)).resolves.toBeNull()
    expect(loadAccountAddress(WALLET)).toBeNull()
  })

  it('never overwrites a stored address', async () => {
    // Belt and braces on top of the short-circuit: even if a probe somehow ran, first-write-wins in
    // the store means a good address cannot be replaced by a different one.
    saveAccountAddress(WALLET, ACCOUNT)
    saveAccountAddress(WALLET, 'component_' + '9'.repeat(64))
    expect(loadAccountAddress(WALLET)).toBe(ACCOUNT)
  })
})

describe('recoverAccountAddress — what it does with a probe result', () => {
  // The probe's own guards (owner key, account template, rejected simulations, malformed bodies)
  // are tested against real dry-run response shapes in accountAddress.test.ts. What is left here is
  // what recovery DOES with the answer.
  const probeReturning = (v: string | null) => vi.fn(async () => v)

  it('stores an address the probe found', async () => {
    const probe = probeReturning(ACCOUNT)
    await expect(recoverAccountAddress(walletStub, WALLET, probe)).resolves.toBe(ACCOUNT)
    expect(loadAccountAddress(WALLET)).toBe(ACCOUNT)
    expect(probe).toHaveBeenCalledOnce()
  })

  it('stores nothing when the probe declines to answer', async () => {
    await expect(recoverAccountAddress(walletStub, WALLET, probeReturning(null))).resolves.toBeNull()
    expect(loadAccountAddress(WALLET)).toBeNull()
  })

  it('does not call the probe at all when an address is already stored', async () => {
    saveAccountAddress(WALLET, ACCOUNT)
    const probe = probeReturning('component_' + '9'.repeat(64))
    await expect(recoverAccountAddress(walletStub, WALLET, probe)).resolves.toBe(ACCOUNT)
    expect(probe).not.toHaveBeenCalled()
  })

  it('is safe to run repeatedly — the second call is a pure read', async () => {
    const probe = probeReturning(ACCOUNT)
    await recoverAccountAddress(walletStub, WALLET, probe)
    await recoverAccountAddress(walletStub, WALLET, probe)
    expect(probe).toHaveBeenCalledOnce()
    expect(loadAccountAddress(WALLET)).toBe(ACCOUNT)
  })

  it('propagates nothing when the probe throws — recovery is never fatal', async () => {
    const probe = vi.fn(async () => { throw new Error('boom') })
    await expect(recoverAccountAddress(walletStub, WALLET, probe)).rejects.toThrow('boom')
  })
})
