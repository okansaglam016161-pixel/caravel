// The Sapient wrapper against a fake `window.tari`: detection (present, late, missing), what each
// error code becomes, the calls' shapes, and event subscription.

import { describe, expect, it, vi } from 'vitest'
import {
  checkSession, withTimeout, detectSapient, getAccounts, getViewAccess, requestAccounts, requestViewAccess, shortAddress, subscribeSapient,
  toSapientError, networkLabel, isMainnet, type ProviderHost, type TariProvider,
  TARI_RESOURCE, formatBalance, getPrivateTariBalance, getPublicTariBalance,
} from './provider'

function host(tari?: TariProvider): ProviderHost {
  return Object.assign(new EventTarget(), { tari })
}

function fakeProvider(answers: Record<string, unknown>): TariProvider & { calls: { method: string; params?: unknown }[] } {
  const calls: { method: string; params?: unknown }[] = []
  return {
    calls,
    isTariWallet: true,
    info: { name: 'Sapient', rdns: 'mw.tari.sapient' },
    async request(args) {
      calls.push(args)
      const a = answers[args.method]
      if (a instanceof Error || (a && typeof a === 'object' && 'code' in a && 'message' in a)) throw a
      return a
    },
  }
}

describe('detectSapient', () => {
  it('answers at once when the provider is already injected', async () => {
    const p = fakeProvider({})
    await expect(detectSapient(host(p), 50)).resolves.toBe(p)
  })

  it('waits for tari#initialized', async () => {
    const h = host()
    const p = fakeProvider({})
    const found = detectSapient(h, 1000)
    setTimeout(() => { h.tari = p; h.dispatchEvent(new Event('tari#initialized')) }, 10)
    await expect(found).resolves.toBe(p)
  })

  it('is null when nothing arrives in time', async () => {
    await expect(detectSapient(host(), 20)).resolves.toBeNull()
  })
})

describe('errors', () => {
  it('4001 is declined, 4100 and "Wallet is locked." are locked, the rest keep their reason', () => {
    expect(toSapientError({ code: 4001, message: 'User rejected' }).kind).toBe('declined')
    expect(toSapientError({ code: 4100, message: 'Unauthorized' }).kind).toBe('locked')
    expect(toSapientError(new Error('Wallet is locked.')).kind).toBe('locked')
    const w = toSapientError({ code: -32603, message: 'Amount exceeds your private balance' })
    expect(w).toMatchObject({ kind: 'wallet', code: -32603, message: 'Amount exceeds your private balance' })
  })

  it('a call that fails throws the mapped error', async () => {
    const p = fakeProvider({ tari_requestAccounts: { code: 4001, message: 'User rejected the request.' } })
    await expect(requestAccounts(p)).rejects.toMatchObject({ name: 'SapientError', kind: 'declined' })
  })
})

describe('the calls', () => {
  it('accounts are string arrays, whatever comes back', async () => {
    expect(await getAccounts(fakeProvider({ tari_getAccounts: ['component_a', 7] }))).toEqual(['component_a'])
    expect(await getAccounts(fakeProvider({ tari_getAccounts: null }))).toEqual([])
  })

  it('view access reads { granted }, and a refusal is false rather than a throw', async () => {
    expect(await getViewAccess(fakeProvider({ tari_getViewAccess: { granted: true } }))).toBe(true)
    expect(await requestViewAccess(fakeProvider({ tari_requestViewAccess: { granted: false } }))).toBe(false)
  })

  it('sends no params where the method takes none', async () => {
    const p = fakeProvider({ tari_getAccounts: [] })
    await getAccounts(p)
    expect(p.calls).toEqual([{ method: 'tari_getAccounts' }])
  })
})

describe('checkSession — locked is asked, never told', () => {
  it('BUG 1: getAccounts [] with the site still connected is LOCKED, not "connected" and not "disconnected"', async () => {
    expect(await checkSession(fakeProvider({ tari_getAccounts: ['component_a'] }))).toEqual({ s: 'unlocked', account: 'component_a' })
    expect(await checkSession(fakeProvider({ tari_getAccounts: [], tari_getViewAccess: { granted: true } }))).toEqual({ s: 'locked' })
    expect(await checkSession(fakeProvider({
      tari_getAccounts: [], tari_getViewAccess: { code: -32603, message: 'Site is not connected. Call tari_requestAccounts first.' },
    }))).toEqual({ s: 'disconnected' })
  })

  it('withTimeout: a call that never answers becomes an error instead of a hang', async () => {
    vi.useFakeTimers()
    try {
      const pending = withTimeout(new Promise<never>(() => {}), 1000)
      const check = expect(pending).rejects.toMatchObject({ kind: 'wallet' })
      await vi.advanceTimersByTimeAsync(1000)
      await check
      expect(await withTimeout(Promise.resolve(5), 1000)).toBe(5)
    } finally { vi.useRealTimers() }
  })
})

describe('subscribeSapient', () => {
  it('uses provider.on, and unsubscribes through what it returns', () => {
    const offs = [vi.fn(), vi.fn()]
    const handlers: Record<string, (x: unknown) => void> = {}
    let i = 0
    const p: TariProvider = {
      request: async () => null,
      on: ((event: string, h: (x: unknown) => void) => { handlers[event] = h; return offs[i++] }) as unknown as TariProvider['on'],
    }
    const seen: unknown[] = []
    const unsub = subscribeSapient(p, host(p), { accountsChanged: a => seen.push(a), networkChanged: n => seen.push(n) })
    handlers.accountsChanged(['component_a'])
    handlers.networkChanged('esmeralda')
    expect(seen).toEqual([['component_a'], 'esmeralda'])
    unsub()
    expect(offs[0]).toHaveBeenCalled()
    expect(offs[1]).toHaveBeenCalled()
  })

  it('falls back to the tari#… window events', () => {
    const p: TariProvider = { request: async () => null }
    const h = host(p)
    const seen: unknown[] = []
    const unsub = subscribeSapient(p, h, { accountsChanged: a => seen.push(a), networkChanged: n => seen.push(n) })
    h.dispatchEvent(new CustomEvent('tari#accountsChanged', { detail: [] }))
    h.dispatchEvent(new CustomEvent('tari#networkChanged', { detail: 'mainnet' }))
    unsub()
    h.dispatchEvent(new CustomEvent('tari#networkChanged', { detail: 'igor' }))
    expect(seen).toEqual([[], 'mainnet'])
  })
})

describe('display helpers', () => {
  it('shortens an address for display and names networks', () => {
    expect(shortAddress('otl_esm_1u6frykj99rtg0ttmdlu7lm2rex8hjjlpj704v4vd37gxs8t0uace4lvs6q9rz374nhq9nudflxjzg2cfdn4q894vkz5anpzfgzg86ngha863h'))
      .toBe('otl_esm_1u6f…863h')
    expect(networkLabel('esmeralda')).toBe('Esmeralda')
    expect(networkLabel(null)).toBe('Unknown network')
    expect(isMainnet('mainnet')).toBe(true)
    expect(isMainnet('esmeralda')).toBe(false)
  })
})

describe('TARI balances', () => {
  const OTHER = 'resource_' + 'ab'.repeat(32)

  it('public reads `amount` from tari_getBalances, picking TARI out of every resource', async () => {
    const p = fakeProvider({ tari_getBalances: [
      { resourceAddress: OTHER, amount: '999', confidentialAmount: '0', privateVisible: false, divisibility: 2 },
      { resourceAddress: TARI_RESOURCE, amount: '1500000', confidentialAmount: '0', privateVisible: false, divisibility: 6 },
    ] })
    expect(await getPublicTariBalance(p)).toEqual({ amount: 1_500_000n, divisibility: 6 })
  })

  it('private reads tari_getPrivateBalances; no TARI entry is zero', async () => {
    const p = fakeProvider({ tari_getPrivateBalances: [{ resourceAddress: TARI_RESOURCE, amount: '42000000', outputCount: 3, divisibility: 6 }] })
    expect(await getPrivateTariBalance(p)).toEqual({ amount: 42_000_000n, divisibility: 6 })
    expect(await getPrivateTariBalance(fakeProvider({ tari_getPrivateBalances: [] }))).toEqual({ amount: 0n, divisibility: 6 })
  })

  it('private without view access throws, so the menu can say so', async () => {
    const p = fakeProvider({ tari_getPrivateBalances: { code: -32603, message: 'Private view access not granted.' } })
    await expect(getPrivateTariBalance(p)).rejects.toMatchObject({ name: 'SapientError' })
  })

  it('formats with at most 6 decimals, trailing zeros trimmed, thousands grouped, exactly', () => {
    expect(formatBalance({ amount: 1_500_000n, divisibility: 6 })).toBe('1.5')
    expect(formatBalance({ amount: 1n, divisibility: 6 })).toBe('0.000001')
    expect(formatBalance({ amount: 0n, divisibility: 6 })).toBe('0')
    expect(formatBalance({ amount: 1_234_567_000_000n, divisibility: 6 })).toBe('1,234,567')
    expect(formatBalance({ amount: 123_456_789n, divisibility: 8 })).toBe('1.234567')   // floored past 6
    expect(formatBalance({ amount: 9_007_199_254_740_993_000_000n, divisibility: 6 })).toBe('9,007,199,254,740,993')
  })
})
