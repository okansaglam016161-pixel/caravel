// Tests for reading the revealed (public) TARI balance (M1 C2).
//
// The vault fixture is the real thing: `vault_5f6cd2ad…` as the public Esmeralda indexer served it
// on 2026-08-24, revealed_amount "999595988", inside a `Stealth` container. If the wire shape moves,
// these fail here rather than presenting as a silent zero in the wallet.
//
// Two properties get the most attention, because they are the two that could mislead a user about
// money: amounts must survive as exact bigints however the union delivers them, and a structural
// zero must never be confused with an unreadable balance.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NETWORK_BUSY_MESSAGE, isBusyError, retryTiming } from './indexerRetry'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import { decodeRevealedAmount, parseAmount, readRevealedBalance, type VaultIdResolver } from './revealedBalance'

// Busy retries wait instantly here; the policy is pinned in indexerRetry.test.ts.
beforeEach(() => { retryTiming.sleep = async () => {} })

const ACCOUNT = 'component_5fdba3a627a929063e6769d0f420392fa752e0b8c2a2fb13d6b4993e214985fd'
const VAULT = 'vault_5f6cd2ad4eb86b31db16d245406d29ab154cfeca4bfc0da729a9df3fef9679cc'
const OTHER_RESOURCE = 'resource_' + '2'.repeat(64)

/** The live vault substate value, verbatim in shape. */
function stealthVault(revealed: unknown, address: string = TARI_RESOURCE_ADDRESS, locked: unknown = '0') {
  return { Vault: { resource_container: { Stealth: { address, revealed_amount: revealed, locked_amount: locked } }, freeze_flags: 0 } }
}

/** A provider stub: only getSubstate is exercised by the read path. */
function providerWith(substates: Record<string, unknown>) {
  return {
    getSubstate: vi.fn(async (id: string) => {
      if (!(id in substates)) throw new Error(`substate not found: ${id}`)
      return { version: 4, substate: substates[id], verified: true }
    }),
  } as never
}

const resolver = (ids: string[]): VaultIdResolver => vi.fn(async () => ids)

describe('parseAmount — exactness is the whole job', () => {
  it('reads the live wire value exactly', () => {
    expect(parseAmount('999595988')).toBe(999_595_988n)
  })

  it('survives values past Number.MAX_SAFE_INTEGER without losing a digit', () => {
    // The TARI resource's own total_supply, straight off the indexer. Number() would round this.
    const huge = '18446744073708810601'
    expect(parseAmount(huge)).toBe(18_446_744_073_708_810_601n)
    expect(parseAmount(huge)).not.toBe(BigInt(Number(huge)))   // proof the naive path is wrong
  })

  it('accepts all three shapes the Amount union admits', () => {
    expect(parseAmount('42')).toBe(42n)
    expect(parseAmount(42)).toBe(42n)
    expect(parseAmount(42n)).toBe(42n)
    expect(parseAmount('0')).toBe(0n)
    expect(parseAmount(0)).toBe(0n)
    expect(parseAmount(0n)).toBe(0n)
  })

  it('REFUSES a number that has already lost precision', () => {
    // Past MAX_SAFE_INTEGER the JSON parser mangled it before we saw it — there is no exact bigint
    // left to recover, so a refusal (visible zero) beats a plausible wrong number.
    expect(parseAmount(Number.MAX_SAFE_INTEGER + 2)).toBeNull()
    expect(parseAmount(1e30)).toBeNull()
  })

  it.each([
    ['a decimal string', '1.5'],
    ['a decimal number', 1.5],
    ['a signed string', '+5'],
    ['a negative string', '-5'],
    ['a negative number', -5],
    ['a negative bigint', -5n],
    ['an exponent', '1e6'],
    ['whitespace', ' 42 '],
    ['hex', '0x2a'],
    ['empty', ''],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['null', null],
    ['undefined', undefined],
    ['an object', { v: 1 }],
    ['an array', ['1']],
    ['a boolean', true],
  ])('refuses %s', (_label, input) => {
    expect(parseAmount(input)).toBeNull()
  })
})

describe('decodeRevealedAmount — the live vault shape', () => {
  it('reads revealed_amount out of a real Stealth vault', () => {
    expect(decodeRevealedAmount(stealthVault('999595988'), TARI_RESOURCE_ADDRESS)).toBe(999_595_988n)
  })

  it('reads a zero vault as 0n, not as absent', () => {
    // The ordinary state after a faucet claim: the whole payout was converted, vault left at zero.
    expect(decodeRevealedAmount(stealthVault('0'), TARI_RESOURCE_ADDRESS)).toBe(0n)
  })

  it('skips a vault belonging to a different resource', () => {
    expect(decodeRevealedAmount(stealthVault('500', OTHER_RESOURCE), TARI_RESOURCE_ADDRESS)).toBeNull()
  })

  it('ignores locked_amount — only the unlocked revealed figure is the balance', () => {
    expect(decodeRevealedAmount(stealthVault('100', TARI_RESOURCE_ADDRESS, '999'), TARI_RESOURCE_ADDRESS)).toBe(100n)
  })
})

describe('decodeRevealedAmount — refuses container shapes that are not Stealth', () => {
  it('refuses a Fungible container', () => {
    const v = { Vault: { resource_container: { Fungible: { address: TARI_RESOURCE_ADDRESS, amount: '500', locked_amount: '0' } } } }
    expect(decodeRevealedAmount(v, TARI_RESOURCE_ADDRESS)).toBeNull()
  })

  it('refuses a Confidential container EVEN THOUGH it has a revealed_amount', () => {
    // The tempting one. A Confidential container really does carry revealed_amount — but TARI is
    // never Confidential, so meeting one means our assumption about the resource is wrong. A visible
    // zero is the right outcome; a plausible number is not.
    const v = { Vault: { resource_container: { Confidential: {
      address: TARI_RESOURCE_ADDRESS, commitments: [], revealed_amount: '777',
      locked_commitments: [], locked_revealed_amount: '0',
    } } } }
    expect(decodeRevealedAmount(v, TARI_RESOURCE_ADDRESS)).toBeNull()
  })

  it('refuses a NonFungible container', () => {
    const v = { Vault: { resource_container: { NonFungible: { address: TARI_RESOURCE_ADDRESS, token_ids: [], locked_token_ids: [] } } } }
    expect(decodeRevealedAmount(v, TARI_RESOURCE_ADDRESS)).toBeNull()
  })

  it.each([
    ['a Component substate', { Component: { header: {}, body: {} } }],
    ['a Utxo substate', { Utxo: { output: null, is_frozen: false } }],
    ['a Resource substate', { Resource: { resource_type: 'Stealth' } }],
    ['an empty container', { Vault: { resource_container: {} } }],
    ['a vault with no container', { Vault: {} }],
    ['an empty object', {}],
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
  ])('refuses %s', (_label, input) => {
    expect(decodeRevealedAmount(input, TARI_RESOURCE_ADDRESS)).toBeNull()
  })

  it('refuses a Stealth container whose amount is unparseable', () => {
    expect(decodeRevealedAmount(stealthVault(1.5), TARI_RESOURCE_ADDRESS)).toBeNull()
    expect(decodeRevealedAmount(stealthVault('abc'), TARI_RESOURCE_ADDRESS)).toBeNull()
    expect(decodeRevealedAmount(stealthVault(undefined), TARI_RESOURCE_ADDRESS)).toBeNull()
  })
})

describe('readRevealedBalance — the empty cases all read 0n', () => {
  it('returns 0n with no stored account address — the common case today', async () => {
    // Every wallet that claimed before C1 shipped looks like this, and 0n is the truth for them:
    // the faucet converts its whole payout, so their vault holds nothing revealed.
    const resolve = vi.fn()
    await expect(readRevealedBalance(providerWith({}), null, resolve as never)).resolves.toBe(0n)
    expect(resolve).not.toHaveBeenCalled()   // and it does not touch the network to find out
  })

  it('returns 0n when the account holds no vaults at all', async () => {
    await expect(readRevealedBalance(providerWith({}), ACCOUNT, resolver([]))).resolves.toBe(0n)
  })

  it('returns 0n when the account has vaults but none for TARI', async () => {
    const other = 'vault_' + '3'.repeat(64)
    const p = providerWith({ [other]: stealthVault('500', OTHER_RESOURCE) })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([other]))).resolves.toBe(0n)
  })

  it('returns 0n for a TARI vault holding zero', async () => {
    const p = providerWith({ [VAULT]: stealthVault('0') })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([VAULT]))).resolves.toBe(0n)
  })
})

describe('readRevealedBalance — reading a real balance', () => {
  it('returns the live vault amount as an exact bigint', async () => {
    const p = providerWith({ [VAULT]: stealthVault('999595988') })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([VAULT]))).resolves.toBe(999_595_988n)
  })

  it('sums TARI vaults and ignores the rest', async () => {
    const a = 'vault_' + 'a'.repeat(64), b = 'vault_' + 'b'.repeat(64), c = 'vault_' + 'c'.repeat(64)
    const p = providerWith({
      [a]: stealthVault('1000'),
      [b]: stealthVault('999', OTHER_RESOURCE),          // different resource — skipped
      [c]: stealthVault('2000'),
    })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([a, b, c]))).resolves.toBe(3000n)
  })

  it('stays exact across a sum that overflows a JS number', async () => {
    const a = 'vault_' + 'a'.repeat(64), b = 'vault_' + 'b'.repeat(64)
    const p = providerWith({ [a]: stealthVault('9007199254740991'), [b]: stealthVault('9007199254740991') })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([a, b]))).resolves.toBe(18_014_398_509_481_982n)
  })
})

describe('readRevealedBalance — unavailable is NOT zero', () => {
  it('throws when the indexer fails, rather than reporting a confident 0', async () => {
    // The lesson from this project's own research: an unreadable balance shown as 0 is the same
    // class of bug as a silently-dropped UTXO. The caller renders "unavailable" from this throw.
    const p = { getSubstate: vi.fn(async () => { throw new Error('indexer 503') }) } as never
    await expect(readRevealedBalance(p, ACCOUNT, resolver([VAULT]))).rejects.toThrow('indexer 503')
  })

  it('throws when vault-id resolution fails', async () => {
    const boom: VaultIdResolver = vi.fn(async () => { throw new Error('network down') })
    await expect(readRevealedBalance(providerWith({}), ACCOUNT, boom)).rejects.toThrow('network down')
  })
})

// ── An account that does not exist yet ──────────────────────────────────────
//
// A wallet that has never claimed has an account ADDRESS — derived from its owner key — and no
// component at it. Reading that component does not come back empty: the indexer answers "substate
// not found" and the SDK rejects, which is why every brand-new wallet reported "Balance unreadable
// right now" over a balance that was verifiably zero.
//
// THE NEGATIVE CASES BELOW ARE THE POINT OF THIS SUITE, not the positive one. Mapping the wrong
// rejection to zero is strictly worse than the bug it fixes: an honest error becomes a confident
// lie about someone's money. So "not found" is the ONLY message that may reach 0n, and the rest of
// these pin everything that must not.
//
// The PREDICATE's own cases moved to substates.test.ts when reveal, conceal and public send came to
// need the same one — a fund-critical test and a balance-read test must not be able to drift. What
// stays here is this module's BEHAVIOUR: which rejection becomes a zero, and which stays an error.

describe('readRevealedBalance — a never-created account reads as the zero it is', () => {
  const notFound: VaultIdResolver = vi.fn(async () => { throw new Error('substate not found: ' + ACCOUNT) })

  it('resolves to 0 when the account component does not exist', async () => {
    await expect(readRevealedBalance(providerWith({}), ACCOUNT, notFound)).resolves.toBe(0n)
  })

  it('resolves to 0 on a 404 from the component read', async () => {
    const http404: VaultIdResolver = vi.fn(async () => { throw new Error('HTTP 404: Not Found') })
    await expect(readRevealedBalance(providerWith({}), ACCOUNT, http404)).resolves.toBe(0n)
  })

  // ── THE NEGATIVES, PINNED HARDER THAN THE POSITIVE ────────────────────────
  it.each([
    ['a 503', 'HTTP 503: Service Unavailable'],
    ['a timeout', 'The operation was aborted due to timeout'],
    ['a malformed response', 'Unexpected token < in JSON at position 0'],
    ['a DNS failure', 'getaddrinfo ENOTFOUND ootle-indexer-a.tari.com'],
    ['a generic transport failure', 'fetch failed'],
    ['an internal rpc error', '-32603: Internal error'],
  ])('still THROWS on %s — never a false zero', async (_label, message) => {
    const failing: VaultIdResolver = vi.fn(async () => { throw new Error(message) })
    // A busy 503 is waited out first (Ootle 0.43) and then thrown as IndexerBusyError — still a
    // throw, never a zero. Every other failure is rethrown exactly as the SDK wrote it.
    await expect(readRevealedBalance(providerWith({}), ACCOUNT, failing))
      .rejects.toThrow(isBusyError(new Error(message)) ? NETWORK_BUSY_MESSAGE : message)
  })

  // The tolerance is for the COMPONENT read only. These ids came out of the component's own state,
  // so it asserts each vault exists; one that then cannot be read is an inconsistency, not an
  // absence, and skipping it would drop a real holding and understate the total.
  it('still throws when a vault the component NAMED is missing', async () => {
    // providerWith throws 'substate not found' for an id it does not hold — the same message that
    // means zero one level up, and deliberately does not here.
    await expect(readRevealedBalance(providerWith({}), ACCOUNT, resolver([VAULT]))).rejects.toThrow('substate not found')
  })

  it('does not swallow a not-found once a real balance is already known', async () => {
    const a = 'vault_' + 'a'.repeat(64)
    const p = providerWith({ [a]: stealthVault('999595988') })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([a, VAULT]))).rejects.toThrow('substate not found')
  })
})

// ── Display formatting ────────────────────────────────────────────────────────
//
// The public row formats with an exact bigint routine rather than reusing the modal's `fmt2`
// (which divides through Number). These pin the two to the same output, so the public row and the
// private hero can never write the same figure differently — and pin the exactness that motivated
// the separate routine in the first place.

/** Mirrors fmtMicrotariExact in WalletModal.tsx. */
const fmtExact = (µt: bigint): string => {
  const hundredths = (µt + 5_000n) / 10_000n
  const whole = hundredths / 100n
  const cents = hundredths % 100n
  return `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`
}
/** Mirrors fmt2 in WalletModal.tsx — the existing Number-based helper. */
const fmt2 = (µt: bigint) => (Number(µt) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

describe('public-balance formatting', () => {
  it.each([
    0n, 1n, 5_000n, 10_000n, 999_999n, 1_000_000n, 1_500_000n,
    999_595_988n,                       // the live vault balance
    1_000_000_000n,                     // a full faucet payout
    123_456_789_012_345n,
  ])('agrees with fmt2 at %s µtTARI', (v) => {
    expect(fmtExact(v)).toBe(fmt2(v))
  })

  it('formats the live vault balance the way the row will show it', () => {
    expect(fmtExact(999_595_988n)).toBe('999.60')
  })

  it('agrees with fmt2 across the whole u64 range — the Number path costs nothing here', () => {
    // Checked rather than assumed. Number's error only exceeds half a hundredth of a TARI past
    // ~1e20 µtTARI, so at 2dp the two are identical everywhere a real balance can live. This is why
    // the separate helper is a rail-compliance choice, not a correction.
    const u64Max = 18_446_744_073_709_551_615n
    expect(fmtExact(u64Max)).toBe(fmt2(u64Max))
    expect(fmtExact(u64Max)).toBe('18,446,744,073,709.55')
    expect(fmtExact(10n ** 21n)).toBe(fmt2(10n ** 21n))
  })

  it('diverges from fmt2 only at 128-bit scale, far beyond any balance', () => {
    // The one place they part company, recorded so the claim above stays honest and testable.
    const beyond = 2n ** 80n
    expect(fmtExact(beyond)).toBe('1,208,925,819,614,629,174.71')
    expect(fmt2(beyond)).toBe('1,208,925,819,614,629,000.00')
  })

  it('rounds half-up at the hundredth, and never renders a bare integer', () => {
    expect(fmtExact(4_999n)).toBe('0.00')
    expect(fmtExact(5_000n)).toBe('0.01')
    expect(fmtExact(2_000_000n)).toBe('2.00')
  })
})

// ── Ootle 0.47: the read that showed a funded account as 0 ───────────────────
//
// A 0.47 indexer serves `{ state: { up: { substate } } }`. The SDK 0.9 vault walker then found no
// vaults and the vault read found no value, so the wallet showed a confident 0 public. This runs
// the DEFAULT resolver (crypto/substateShape.getAccountVaultIds) end to end on that shape, with the
// test wallet's real figure.
describe('readRevealedBalance — a 0.47 indexer', () => {
  const VAULT_HEX = VAULT.slice('vault_'.length)
  const account = {
    Component: {
      header: { template_address: '0'.repeat(64) },
      body: {
        state: [{
          '@cbor': 'map',
          entries: [[
            { '@cbor': 'tag', tag: 131, value: { '@cbor': 'bytes', hex: '01'.repeat(32) } },
            { '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex: VAULT_HEX } },
          ]],
        }, {}],
      },
    },
  }
  const provider047 = (substates: Record<string, unknown>) => ({
    getSubstate: vi.fn(async (id: string) => {
      if (!(id in substates)) throw new Error(`substate not found: ${id}`)
      return { version: 4, state: { up: { substate: substates[id] } }, verified: true }
    }),
  }) as never

  it('reads the real public balance through the default resolver', async () => {
    const p = provider047({ [ACCOUNT]: account, [VAULT]: stealthVault('995540589') })
    expect(await readRevealedBalance(p, ACCOUNT)).toBe(995_540_589n)
  })

  it('a never-created account is still the zero it is', async () => {
    expect(await readRevealedBalance(provider047({}), ACCOUNT)).toBe(0n)
  })
})

// ── An unreadable TARI vault is "unavailable", never a confident 0 ──────────
//
// Found by the 0.47 end-to-end run: a vault the account names, served in a shape nothing here
// decodes, was skipped exactly like another resource's vault, and the wallet showed 0 public. A
// thrown read is what the UI turns into "Your public balance is unavailable right now"
// (WalletContext.startRevealedRead), so every reading that is not "another resource" must throw.
describe('readRevealedBalance — an undecodable vault is unavailable, not 0', () => {
  const tariVault = (container: unknown) => ({ Vault: { resource_container: container, freeze_flags: 0 } })

  it('throws for a vault body in a shape nothing reads (no `Vault` at all)', async () => {
    const p = providerWith({ [VAULT]: { Sideways: { amount: '5' } } })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([VAULT]))).rejects.toThrow(/could not read/i)
  })

  it('throws for a TARI Stealth vault whose amount does not parse', async () => {
    const p = providerWith({ [VAULT]: stealthVault('12.5') })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([VAULT]))).rejects.toThrow(/could not read/i)
  })

  it('throws for a TARI vault in a container that is not Stealth', async () => {
    const p = providerWith({ [VAULT]: tariVault({ Confidential: { address: TARI_RESOURCE_ADDRESS, revealed_amount: '5' } }) })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([VAULT]))).rejects.toThrow(/could not read/i)
  })

  it('throws for a vault whose resource cannot be told', async () => {
    const p = providerWith({ [VAULT]: tariVault({ Stealth: { revealed_amount: '5' } }) })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([VAULT]))).rejects.toThrow(/could not read/i)
  })

  it('still SKIPS a vault that is genuinely of another resource, in any container', async () => {
    const other = 'vault_' + '3'.repeat(64)
    const p = providerWith({
      [VAULT]: stealthVault('7'),
      [other]: tariVault({ Fungible: { address: OTHER_RESOURCE, amount: '500' } }),
    })
    await expect(readRevealedBalance(p, ACCOUNT, resolver([VAULT, other]))).resolves.toBe(7n)
  })
})
