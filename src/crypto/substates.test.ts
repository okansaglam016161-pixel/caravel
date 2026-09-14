// Existence, and what a transaction is allowed to declare because of it.
//
// ── WHY THIS FILE IS WEIGHTED THE WAY IT IS ─────────────────────────────────
//
// resolveAccountInputs decides whether CreateAccount will REUSE the user's account or MINT a new
// one, and the wrong answer in one direction commits a transaction that reports success while the
// money never moves. So the tests that matter most here are the NEGATIVE ones: not "a not-found
// provisions", but "nothing except a not-found provisions". A 503 misread as absence is the silent
// fund-loss case, and it is pinned harder than the happy path.

import { describe, expect, it, vi } from 'vitest'
import { isSubstateNotFound, resolveAccountInputs, type VaultIdResolver } from './substates'

const ACCOUNT = 'component_5fdba3a627a929063e6769d0f420392fa752e0b8c2a2fb13d6b4993e214985fd'
const VAULT_A = 'vault_' + 'a'.repeat(64)
const VAULT_B = 'vault_' + 'b'.repeat(64)

/** The provider is never touched by these paths — the resolver seam is what is exercised. */
const provider = {} as never

const resolver = (ids: string[]): VaultIdResolver => vi.fn(async () => ids)
const rejecting = (message: string): VaultIdResolver => vi.fn(async () => { throw new Error(message) })

/** Everything that means "we could not find out" — none of it may ever provision. */
const NOT_ABSENCE = [
  ['a 503', 'HTTP 503: Service Unavailable'],
  ['a 500', 'HTTP 500: Internal Server Error'],
  ['a timeout', 'The operation was aborted due to timeout'],
  ['an aborted signal', 'signal is aborted without reason'],
  ['a transport failure', 'fetch failed'],
  ['a DNS failure', 'getaddrinfo ENOTFOUND ootle-indexer-a.tari.com'],
  ['a malformed response', 'Unexpected token < in JSON at position 0'],
  ['a browser network error', 'NetworkError when attempting to fetch resource'],
  ['an internal rpc error', '-32603: Internal error'],
  ['rate limiting', 'rate limited'],
] as const

describe('isSubstateNotFound — the narrowest possible predicate', () => {
  it('matches what the indexer says for a substate that is not there', () => {
    expect(isSubstateNotFound(new Error('substate not found: component_abc'))).toBe(true)
    expect(isSubstateNotFound(new Error('Substate component_d1258fa0 not found'))).toBe(true)
    expect(isSubstateNotFound(new Error('Not Found'))).toBe(true)
    expect(isSubstateNotFound(new Error('HTTP 404: Not Found'))).toBe(true)
    expect(isSubstateNotFound(new Error('-32000: 404'))).toBe(true)
    expect(isSubstateNotFound('substate not found')).toBe(true)   // a non-Error rejection
  })

  it.each(NOT_ABSENCE)('does NOT match %s', (_label, message) => {
    expect(isSubstateNotFound(new Error(message))).toBe(false)
  })

  // ENOTFOUND is the trap: a DNS failure whose message contains "NOTFOUND", which a looser test
  // would read as "the account does not exist" and answer by minting a second account over a
  // wallet that already has one.
  it('does not mistake a DNS failure for a missing substate', () => {
    expect(isSubstateNotFound(new Error('getaddrinfo ENOTFOUND indexer.example'))).toBe(false)
  })
})

describe('resolveAccountInputs — the account EXISTS (unchanged behaviour)', () => {
  it('declares the component and every vault, in that order', async () => {
    const got = await resolveAccountInputs(provider, ACCOUNT, resolver([VAULT_A, VAULT_B]))
    expect(got).toEqual({ exists: true, declaredInputs: [ACCOUNT, VAULT_A, VAULT_B] })
  })

  // An account that exists but holds nothing yet: the component is STILL declared, because it is
  // still what CreateAccount must reuse. Only its vaults are absent, and a vault a deposit creates
  // is an output, not an input.
  it('declares the component even when it has no vaults yet', async () => {
    const got = await resolveAccountInputs(provider, ACCOUNT, resolver([]))
    expect(got).toEqual({ exists: true, declaredInputs: [ACCOUNT] })
  })

  it('passes the account address through to the resolver', async () => {
    const spy = resolver([VAULT_A])
    await resolveAccountInputs(provider, ACCOUNT, spy)
    expect(spy).toHaveBeenCalledWith(provider, ACCOUNT)
  })
})

describe('resolveAccountInputs — the account does NOT exist (provision)', () => {
  it('declares NOTHING, so CreateAccount mints it', async () => {
    const got = await resolveAccountInputs(provider, ACCOUNT, rejecting(`Substate ${ACCOUNT} not found`))
    expect(got).toEqual({ exists: false, declaredInputs: [] })
  })

  it('declares nothing on a 404 as well', async () => {
    const got = await resolveAccountInputs(provider, ACCOUNT, rejecting('HTTP 404: Not Found'))
    expect(got.exists).toBe(false)
    expect(got.declaredInputs).toEqual([])
  })

  // The absence branch is all-or-nothing. A half-populated declaration — the component without its
  // vaults — is the one shape that could pass review and still fail on deposit.
  it('never returns a partial declaration', async () => {
    const got = await resolveAccountInputs(provider, ACCOUNT, rejecting('not found'))
    expect(got.declaredInputs).toHaveLength(0)
  })
})

describe('resolveAccountInputs — anything else ABORTS, and never provisions', () => {
  // ── THE FUND-CRITICAL ASSERTIONS ──────────────────────────────────────────
  //
  // If any of these ever resolved instead of throwing, a wallet that HAS an account would build a
  // transaction that does not declare it, CreateAccount would mint a throwaway, the deposit would
  // land there, and the transaction would COMMIT reporting success with the balance unmoved. A
  // network blip would silently eat the money.
  it.each(NOT_ABSENCE)('rethrows %s rather than treating it as absence', async (_label, message) => {
    await expect(resolveAccountInputs(provider, ACCOUNT, rejecting(message))).rejects.toThrow(message)
  })

  it('rethrows the original error object, not a wrapped one', async () => {
    const original = new Error('HTTP 503: Service Unavailable')
    const boom: VaultIdResolver = vi.fn(async () => { throw original })
    await expect(resolveAccountInputs(provider, ACCOUNT, boom)).rejects.toBe(original)
  })
})
