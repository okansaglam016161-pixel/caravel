// Tests for the ONS owned-names read — the layer every CNS list state depends on.
//
// WHAT IS ACTUALLY BEING GUARDED. This function answers a question about the chain, and there are
// four different true answers: you own several, you own one, you own none, and we could not find
// out. The last two are the pair that matters. An unreachable registry rendered as an empty one
// tells somebody who already holds a name that they hold nothing — and invites them to pay a fee
// to claim a name they cannot have. That is the confident-wrong answer this shape exists to make
// impossible, so the spec asserts the two are never conflated in either direction.
//
// The other half is the two failures. Deriving the owner key is a WALLET operation and reading the
// registry is a NETWORK one; they used to share one catch, so each could return the other's
// sentence. They are separate try blocks now and the spec pins that: a wallet failure must never
// reach the registry at all.
//
// The reader is stubbed at the client boundary (`ons.namesForOwner`) rather than at `fetch`. That
// is the seam this module actually depends on, and stubbing it keeps the spec off the network —
// nothing here talks to an indexer.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { checkOnsAvailable, ons, ownedOnsNames, type NameRecord } from './ons'

// A 32-byte key whose hex is easy to assert against: 0x00, 0x01, … 0x1f.
const KEY = new Uint8Array(Array.from({ length: 32 }, (_, i) => i))
const KEY_HEX = Array.from(KEY, b => b.toString(16).padStart(2, '0')).join('')

/** A wallet that knows who it is. Only getPublicKey is reached by this module. */
function walletOk(): SecretKeyWallet {
  return { getPublicKey: async () => KEY } as unknown as SecretKeyWallet
}

/** A wallet that cannot produce its key — e.g. no view secret set (see the SDK's WalletError). */
function walletBroken(message = 'view key not set'): SecretKeyWallet {
  return { getPublicKey: async () => { throw new Error(message) } } as unknown as SecretKeyWallet
}

function record(name: string): NameRecord {
  return { name, owner: KEY_HEX, records: { nostr: `npub1${name}` } }
}

/** Stub the reader's owner→names lookup. Returns the spy so call arguments can be asserted. */
function stubNames(result: NameRecord[] | Error) {
  return vi.spyOn(ons, 'namesForOwner').mockImplementation(async () => {
    if (result instanceof Error) throw result
    return result
  })
}

afterEach(() => { vi.restoreAllMocks() })

describe('ownedOnsNames — the resolved answers', () => {
  it('returns EVERY name, not the first one', async () => {
    stubNames([record('alpha'), record('beta'), record('gamma')])

    const r = await ownedOnsNames(walletOk())

    expect(r.ok).toBe(true)
    expect(r.names?.map(n => n.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('passes the reader’s order through untouched — sorting lives in the reader, not here', async () => {
    // Deliberately NOT alphabetical. If this function ever re-sorted, there would be two orderings
    // that could disagree; the spec pins that it forwards whatever the reader gave it.
    stubNames([record('zeta'), record('alpha')])

    const r = await ownedOnsNames(walletOk())

    expect(r.names?.map(n => n.name)).toEqual(['zeta', 'alpha'])
  })

  it('returns the single name for a wallet that owns one', async () => {
    stubNames([record('okz')])

    const r = await ownedOnsNames(walletOk())

    expect(r.ok).toBe(true)
    expect(r.names).toHaveLength(1)
    expect(r.names?.[0].name).toBe('okz')
  })

  it('owns-none is ok:true with an empty array — a real answer about the chain', async () => {
    stubNames([])

    const r = await ownedOnsNames(walletOk())

    expect(r.ok).toBe(true)
    expect(r.names).toEqual([])
    // The three ways this could have been dressed up as a failure. None of them.
    expect(r.errorKind).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(r.names).not.toBeUndefined()
  })

  it('derives the owner key as lowercase hex and asks the reader for exactly that', async () => {
    const spy = stubNames([])

    await ownedOnsNames(walletOk())

    expect(spy).toHaveBeenCalledWith(KEY_HEX)
    expect(KEY_HEX).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
  })
})

describe('ownedOnsNames — the failures, and that they stay apart', () => {
  it('an unreachable registry is ok:false with errorKind "unreachable"', async () => {
    stubNames(new Error('ONS indexer request failed: fetch failed'))

    const r = await ownedOnsNames(walletOk())

    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('unreachable')
    expect(r.error).toContain('ONS indexer request failed')
  })

  it('a wallet that cannot produce its key is "no-identity", NOT "unreachable"', async () => {
    const spy = stubNames([])

    const r = await ownedOnsNames(walletBroken())

    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('no-identity')
    expect(r.error).toContain('view key not set')
    // THE SEPARATION, ASSERTED. The registry is never asked when we do not know who is asking, so a
    // wallet failure cannot come back wearing the network's sentence.
    expect(spy).not.toHaveBeenCalled()
  })

  it('a failure never carries names — there is no [] to mistake for "you own none"', async () => {
    stubNames(new Error('ONS indexer HTTP 503'))
    const unreachable = await ownedOnsNames(walletOk())
    const noIdentity = await ownedOnsNames(walletBroken())

    for (const r of [unreachable, noIdentity]) {
      expect(r.ok).toBe(false)
      expect(r.names).toBeUndefined()
    }
  })

  it('falls back to its own sentence when the throw carries no message', async () => {
    stubNames(new Error(''))

    const r = await ownedOnsNames(walletOk())

    expect(r.errorKind).toBe('unreachable')
    expect(r.error).toBe('Could not reach the ONS registry — try again.')
  })
})

describe('ownedOnsNames — no registration date is invented', () => {
  it('carries no date field, because the chain has none to carry', async () => {
    // The contract's NameRecord is {owner, records}; the indexer's substate `version` counts the
    // whole registry's writes, not one name's. A date on a row here could only have come from this
    // device's clock, which is not when the name was registered.
    stubNames([record('okz')])

    const r = await ownedOnsNames(walletOk())

    expect(Object.keys(r).sort()).toEqual(['names', 'ok'])
    expect(Object.keys(r.names![0]).sort()).toEqual(['name', 'owner', 'records'])
  })
})

// ── Availability ──────────────────────────────────────────────────────────────
//
// THE SAME PAIR, ONE LEVEL DOWN. `ownedOnsNames` had to stop reporting an unreachable registry as
// an empty one; this had to stop reporting it as a TAKEN one. It used to return
// `{ available: false }` on a network error, which is byte-identical to what it returns for a name
// somebody else owns — so a caller that read `.available` told the user their chosen name was gone
// when the truth was that nobody had asked. The fix is the same: no answer on a failed read, so
// there is no false lying around to render.

/** Stub the reader's existence check. Returns the spy so call arguments can be asserted. */
function stubRegistered(result: boolean | Error) {
  return vi.spyOn(ons, 'isRegistered').mockImplementation(async () => {
    if (result instanceof Error) throw result
    return result
  })
}

describe('checkOnsAvailable — free, taken, and never asked', () => {
  it('a name nobody holds is ok:true, available:true', async () => {
    const spy = stubRegistered(false)

    const r = await checkOnsAvailable('okz')

    expect(r.ok).toBe(true)
    expect(r.available).toBe(true)
    expect(r.errorKind).toBeUndefined()
    expect(spy).toHaveBeenCalledWith('okz')
  })

  it('a name somebody holds is ok:true, available:false', async () => {
    stubRegistered(true)

    const r = await checkOnsAvailable('okz')

    expect(r.ok).toBe(true)
    expect(r.available).toBe(false)
    // A REAL ANSWER, not a failure. Nothing here may read as an error.
    expect(r.errorKind).toBeUndefined()
    expect(r.error).toBeUndefined()
  })

  it('an unreachable registry is ok:false with errorKind "unreachable"', async () => {
    stubRegistered(new Error('ONS indexer request failed: fetch failed'))

    const r = await checkOnsAvailable('okz')

    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('unreachable')
    expect(r.error).toContain('ONS indexer request failed')
  })

  it('a failed read carries NO available field — there is no false to mistake for "taken"', async () => {
    stubRegistered(new Error('ONS indexer HTTP 503'))

    const r = await checkOnsAvailable('okz')

    expect(r.available).toBeUndefined()
    // Said the other way round too, because this is the assertion the bug would break: a caller
    // reading `.available` off a failure must get nothing, never `false`.
    expect(r.available).not.toBe(false)
    expect(Object.keys(r).sort()).toEqual(['error', 'errorKind', 'ok'])
  })

  it('falls back to its own sentence when the throw carries no message', async () => {
    stubRegistered(new Error(''))

    const r = await checkOnsAvailable('okz')

    expect(r.error).toBe('Could not reach the ONS registry — try again.')
  })
})

// ── Name policy ───────────────────────────────────────────────────────────────
//
// The rules mirror the contract (template/src/lib.rs validate_name: non-empty, <= 32 bytes, ASCII
// lowercase a-z 0-9 _ -). Pinned here because a local check that drifted from the contract's would
// either refuse names the chain accepts, or wave through a transaction that panics after the fee.

describe('validateOnsName — the contract\'s rules, in the product\'s words', () => {
  it('accepts the charset the contract accepts', async () => {
    const { validateOnsName } = await import('./ons')
    for (const ok of ['okz', 'okz61', 'a', 'a-b_c', '0123456789', 'x'.repeat(32)]) {
      expect(validateOnsName(ok), ok).toBeNull()
    }
  })

  it('refuses what the contract refuses, one message per rule', async () => {
    const { validateOnsName } = await import('./ons')
    expect(validateOnsName('')).toBe('Enter a name.')
    expect(validateOnsName('x'.repeat(33))).toBe('Too long, 32 characters max.')
    for (const bad of ['Okz', 'okz 61', 'okz.61', 'okz@61', 'ökz']) {
      expect(validateOnsName(bad), bad).toBe('Only lowercase letters, numbers, hyphen and underscore.')
    }
  })
})
