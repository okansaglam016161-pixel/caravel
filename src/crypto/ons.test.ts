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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { checkOnsAvailable, estimateOnsRegistration, ons, ownedOnsNames, registerOnsName, type NameRecord } from './ons'

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
    expect(r.error).toBe('Could not reach the name registry — try again.')
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

    expect(r.error).toBe('Could not reach the name registry — try again.')
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

// ── The write path: estimate, submit, and what the chain actually said ────────
//
// THE MONEY STAGE, AND THE ONE PLACE STRING MATCHING IS ALLOWED. The vendored browser writer
// classifies the chain's answer properly and then throws a SENTENCE, so the classification dies at
// ons.ts's boundary. These specs pin the translation back — and they are the tripwire if the ONS
// client is ever re-vendored with different prose, which is exactly why they exist.
//
// Both writers are reached through `ons.withBrowserSigner`, so one stub covers both calls.

const WALLET = { getPublicKey: async () => new Uint8Array(32) } as unknown as SecretKeyWallet
const ADDR = 'otl_esm_1test'
const NPUB = 'npub1test'

/** Stub the browser writer. `estimate` and `submit` are whatever the test needs them to do. */
function stubWriter(impl: { estimate?: () => Promise<{ feeMicroTari: bigint }>; submit?: () => Promise<{ transactionId: string; fee: bigint }> }) {
  return vi.spyOn(ons, 'withBrowserSigner').mockResolvedValue({
    estimateRegisterWithNostr: impl.estimate ?? (async () => ({ feeMicroTari: 1_000n })),
    submitRegisterWithNostr: impl.submit ?? (async () => ({ transactionId: 'tx1', fee: 1_000n })),
  } as unknown as Awaited<ReturnType<typeof ons.withBrowserSigner>>)
}

const throwing = (message: string) => async () => { throw new Error(message) }

describe('estimateOnsRegistration — three problems, three instructions', () => {
  it('a wallet with no private outputs is "no-private"', async () => {
    stubWriter({ estimate: throwing('No confidential UTXOs found — this wallet needs a balance to pay the fee.') })

    const r = await estimateOnsRegistration(WALLET, ADDR, 'okz', NPUB)

    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('no-private')
    expect(r.feeMicroTari).toBeUndefined()
  })

  it('a balance the fee cannot be paid from in one piece is "fragmented"', async () => {
    stubWriter({ estimate: throwing("Can't fund the fee from one UTXO: need more than 1500 µtTARI in a single UTXO, but the largest is 900 µtTARI.") })

    const r = await estimateOnsRegistration(WALLET, ADDR, 'okz', NPUB)

    expect(r.errorKind).toBe('fragmented')
    // A DIFFERENT PROBLEM FROM AN EMPTY WALLET: there is money, it is just in the wrong shape.
    expect(r.errorKind).not.toBe('no-private')
  })

  it('a network failure is "unreachable"', async () => {
    stubWriter({ estimate: throwing('UTXO scan HTTP 503') })

    expect((await estimateOnsRegistration(WALLET, ADDR, 'okz', NPUB)).errorKind).toBe('unreachable')
  })

  it('an unrecognised message falls to "unreachable", never to a claim about the wallet', async () => {
    stubWriter({ estimate: throwing('something nobody has written a branch for yet') })

    const r = await estimateOnsRegistration(WALLET, ADDR, 'okz', NPUB)

    expect(r.errorKind).toBe('unreachable')
    // The raw message survives — nothing is swallowed just because it was not recognised.
    expect(r.error).toBe('something nobody has written a branch for yet')
  })

  it('a name that fails policy never reaches the network at all', async () => {
    const spy = stubWriter({})

    const r = await estimateOnsRegistration(WALLET, ADDR, 'Okz 61', NPUB)

    expect(r.errorKind).toBe('policy')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('registerOnsName — the outcome, not the sentence', () => {
  it('a true on-chain Accept is the only "accepted"', async () => {
    stubWriter({ submit: async () => ({ transactionId: 'a41c9f27b3', fee: 1_500n }) })

    const r = await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)

    expect(r.ok).toBe(true)
    expect(r.outcome).toBe('accepted')
    expect(r.txId).toBe('a41c9f27b3')
    expect(r.fee).toBe(1_500n)
  })

  it('a fee-committed rejection is "fee-burned", and keeps its tx reference', async () => {
    stubWriter({ submit: throwing('ONS register+set_record was rejected on-chain: the fee was too low, so no name was registered — but the fee was still spent (tx a41c9f27b3).') })

    const r = await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)

    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('fee-burned')
    // THE REFERENCE IS THE POINT. A burned fee that cannot be looked up afterwards is just a number
    // somebody has to take on trust.
    expect(r.txId).toBe('a41c9f27b3')
  })

  it('a plain on-chain reject is also "fee-burned" — execution ran, and the fee runs first', async () => {
    stubWriter({ submit: throwing('ONS register+set_record was rejected on-chain (tx a41c9f27b3): {"Reject":"…"}. If a name was just taken by someone else, it may already be registered.') })

    const r = await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)

    expect(r.outcome).toBe('fee-burned')
    expect(r.txId).toBe('a41c9f27b3')
  })

  it('a timeout is "timed-out" — pending, and never a failure', async () => {
    stubWriter({ submit: throwing('ONS register+set_record did not confirm in time (tx a41c9f27b3). Check Activity before retrying.') })

    const r = await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)

    expect(r.outcome).toBe('timed-out')
    expect(r.outcome).not.toBe('fee-burned')
    expect(r.txId).toBe('a41c9f27b3')
  })

  it('a throw we do not recognise is treated as NOT KNOWING, not as a failure', async () => {
    stubWriter({ submit: throwing('socket hang up') })

    // The submission may well have landed. Calling that a failure is the lie this whole feature
    // exists to remove, so the unrecognised case defaults to pending.
    expect((await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)).outcome).toBe('timed-out')
  })

  it('a policy refusal is "not-submitted" — nothing was sent and no fee moved', async () => {
    const spy = stubWriter({})

    const r = await registerOnsName(WALLET, ADDR, 'Okz 61', NPUB, 1_500n)

    expect(r.outcome).toBe('not-submitted')
    expect(r.txId).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('the fee margin — 10%, and the floor that used to hide behind it', () => {
  // Pinned at four scales because the OLD formula (2% + a 100 µtTARI floor) was safe only where the
  // floor happened to exceed the measured 2.7% drift, and stopped being safe above ~5 000 µtTARI —
  // where it would have burned the fee on every attempt. These numbers are the evidence for 10%.
  const budgetFor = async (realFee: bigint) => {
    stubWriter({ estimate: async () => ({ feeMicroTari: realFee }) })
    const r = await estimateOnsRegistration(WALLET, ADDR, 'okz', NPUB)
    return r.feeMicroTari!
  }

  it('adds 10% once the percentage clears the floor', async () => {
    expect(await budgetFor(1_400n)).toBe(1_540n)   // +140, was +100 under 2%+floor
    expect(await budgetFor(2_451n)).toBe(2_696n)   // +245, was +100
    expect(await budgetFor(5_000n)).toBe(5_500n)   // +500, was +100 — the old cliff
    expect(await budgetFor(10_000n)).toBe(11_000n) // +1000, was +200
  })

  it('the floor still covers a fee too small for a percentage to matter', async () => {
    expect(await budgetFor(500n)).toBe(600n)   // 10% = 50, below the floor → 100
    expect(await budgetFor(1n)).toBe(101n)
  })

  it('clears the measured 2.7% drift at every scale, which 2% did not', async () => {
    for (const fee of [1_400n, 2_451n, 5_000n, 10_000n, 100_000n]) {
      const budget = await budgetFor(fee)
      const drifted = fee + (fee * 27n) / 1000n   // +2.7%
      expect(budget, `budget for ${fee} must cover a 2.7% drift`).toBeGreaterThanOrEqual(drifted)
    }
  })
})

// ── The fee input: Caravel's spendable set, and Caravel's spend record ────────
//
// The vendored writer used to find its fee input with its own scan — the 1000 OLDEST rows of ONE
// indexer — and told a wallet holding ~2000 tTARI private that it "needs a balance". It now takes
// the input from Caravel's scanOwnedUtxos through a two-field patch (vendor/ons/dist/VENDOR_INFO),
// and reports the input it spent so the spend record can lock it. These pin both ends of that seam.

describe('the fee input comes from Caravel, and is locked like any other spend', () => {
  const FEE_COIN = 'utxo_0101_feecoin'

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

  beforeEach(async () => {
    globalThis.localStorage = memoryStorage()
    const { setStoreKey } = await import('./sessionKey')
    setStoreKey(new Uint8Array(32).fill(5))
  })

  type Signer = Parameters<typeof ons.withBrowserSigner>[0]

  /** A writer that behaves as the patched one does: submit reports its fee input, then resolves. */
  function writerThatSubmits(outcome: () => Promise<{ transactionId: string; fee: bigint }>) {
    const seen: Signer[] = []
    vi.spyOn(ons, 'withBrowserSigner').mockImplementation(async (signer: Signer) => {
      seen.push(signer)
      return {
        estimateRegisterWithNostr: async () => ({ feeMicroTari: 1_000n }),
        submitRegisterWithNostr: async () => {
          signer.onSubmitted?.('tx9', [FEE_COIN])
          return outcome()
        },
      } as unknown as Awaited<ReturnType<typeof ons.withBrowserSigner>>
    })
    return seen
  }

  const statusOf = async (id: string) => {
    const { loadSpentOutputs } = await import('./spentOutputs')
    return loadSpentOutputs(ADDR).records[id]?.status
  }

  it('the estimate hands the writer Caravel\'s owned-output source — the old scan is bypassed', async () => {
    const seen = writerThatSubmits(async () => ({ transactionId: 'tx9', fee: 1n }))
    await estimateOnsRegistration(WALLET, ADDR, 'okz', NPUB)
    expect(typeof seen[0]!.ownedUtxos).toBe('function')
    // Nothing is submitted by an estimate, so nothing may be locked.
    expect(seen[0]!.onSubmitted).toBeUndefined()
  })

  it('the submit hands it the same source, and a lock hook', async () => {
    const seen = writerThatSubmits(async () => ({ transactionId: 'tx9', fee: 1n }))
    await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)
    expect(typeof seen[0]!.ownedUtxos).toBe('function')
    expect(typeof seen[0]!.onSubmitted).toBe('function')
  })

  it('Accept: the fee coin is spent', async () => {
    writerThatSubmits(async () => ({ transactionId: 'tx9', fee: 1n }))
    await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)
    expect(await statusOf(FEE_COIN)).toBe('spent')
  })

  // The fee input is in the FEE instructions, which are exactly what a fee-only commit commits.
  it('fee-only commit: the fee coin is ALSO spent — it was consumed', async () => {
    writerThatSubmits(throwing('ONS register+set_record was rejected on-chain: the fee was too low, so no name was registered — but the fee was still spent (tx tx9).'))
    await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)
    expect(await statusOf(FEE_COIN)).toBe('spent')
  })

  it('a timeout keeps the lock — not a verdict; the sweep resolves it', async () => {
    writerThatSubmits(throwing('ONS register+set_record did not confirm in time (tx tx9). Check Activity before retrying.'))
    await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)
    expect(await statusOf(FEE_COIN)).toBe('locked')
  })

  it('a plain reject keeps the lock too — a sentence is not evidence enough to hand a coin back', async () => {
    writerThatSubmits(throwing('ONS register+set_record was rejected on-chain (tx tx9): {"Reject":"…"}.'))
    await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)
    expect(await statusOf(FEE_COIN)).toBe('locked')
  })

  it('a failure before submission locks nothing', async () => {
    stubWriter({ submit: throwing('socket hang up') })
    await registerOnsName(WALLET, ADDR, 'okz', NPUB, 1_500n)
    expect(await statusOf(FEE_COIN)).toBeUndefined()
  })

  it('no private outputs at all is "no-private"; none because some are locked is "private-settling"', async () => {
    stubWriter({ estimate: throwing('No confidential UTXOs found — this wallet needs a balance to pay the fee.') })
    expect((await estimateOnsRegistration(WALLET, ADDR, 'okz', NPUB)).errorKind).toBe('no-private')

    const { markLocked } = await import('./spentOutputs')
    markLocked(ADDR, ['utxo_0101_inflight'], 'txA')
    expect((await estimateOnsRegistration(WALLET, ADDR, 'okz', NPUB)).errorKind).toBe('private-settling')
  })
})
