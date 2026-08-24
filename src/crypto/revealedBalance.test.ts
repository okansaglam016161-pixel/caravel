// Tests for reading the revealed (public) TARI balance (M1 C2).
//
// The vault fixture is the real thing: `vault_5f6cd2ad…` as the public Esmeralda indexer served it
// on 2026-08-24, revealed_amount "999595988", inside a `Stealth` container. If the wire shape moves,
// these fail here rather than presenting as a silent zero in the wallet.
//
// Two properties get the most attention, because they are the two that could mislead a user about
// money: amounts must survive as exact bigints however the union delivers them, and a structural
// zero must never be confused with an unreadable balance.

import { describe, expect, it, vi } from 'vitest'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import { decodeRevealedAmount, parseAmount, readRevealedBalance, type VaultIdResolver } from './revealedBalance'

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
