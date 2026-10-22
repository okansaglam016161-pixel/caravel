import { describe, expect, it } from 'vitest'
import {
  APPROVED_ASSETS, CUSD_ASSET, TARI_ASSET, approvedAsset, formatUnits, formatUsd, CUSD_RESOURCE_ADDRESS,
} from './assets'
import { RATE_NUM, RATE_DEN } from '../components/wallet/v2/fiat'

describe('the approved-asset allowlist', () => {
  it('is TARI and cUSD, both 6 decimals', () => {
    expect(APPROVED_ASSETS.map(a => a.id)).toEqual(['tari', 'cusd'])
    expect(TARI_ASSET.decimals).toBe(6)
    expect(CUSD_ASSET.decimals).toBe(6)
  })

  it('identifies an asset ONLY by its exact resource address', () => {
    expect(approvedAsset(CUSD_RESOURCE_ADDRESS)?.id).toBe('cusd')
    // Accepts the bare hex form too (the `/utxos` shape).
    expect(approvedAsset(CUSD_RESOURCE_ADDRESS.replace('resource_', ''))?.id).toBe('cusd')
    // A look-alike — same symbol/decimals, different address — is NOT on the list.
    expect(approvedAsset('resource_' + 'f'.repeat(64))).toBeNull()
  })

  it('makes cUSD display-only and TARI fully actionable', () => {
    expect(CUSD_ASSET.actions).toEqual({ send: false, burn: false, chat: false })
    expect(TARI_ASSET.actions.send).toBe(true)
  })

  it('cUSD is a testnet dollar at exactly $1', () => {
    expect(CUSD_ASSET.usdPrice).toBe(1)
    expect(CUSD_ASSET.name).toBe('Caravel Test Dollar')
  })

  it('keeps TARI’s rate pinned to v2/fiat so the two cannot drift', () => {
    // fiat.ts: USD = microtari * RATE_NUM / RATE_DEN. One whole TARI is 10^6 base units.
    const perToken = Number((1_000_000n * RATE_NUM * 1_000_000n) / RATE_DEN) / 1_000_000
    expect(TARI_ASSET.usdPrice).toBeCloseTo(perToken, 10)
  })
})

describe('formatUnits', () => {
  it('renders 10,000 cUSD from base units with grouping', () => {
    expect(formatUnits(10_000_000_000n, 6)).toBe('10,000')
  })
  it('keeps significant decimals and trims trailing zeros', () => {
    expect(formatUnits(1_500_000n, 6)).toBe('1.5')
    expect(formatUnits(1n, 6)).toBe('0.000001')
    expect(formatUnits(0n, 6)).toBe('0')
  })
  it('groups large whole parts', () => {
    expect(formatUnits(1_234_567_000_000n, 6)).toBe('1,234,567')
  })
})

describe('formatUsd', () => {
  it('is exact for cUSD at $1 — 10,000 cUSD is $10,000.00, never a float short', () => {
    expect(formatUsd(10_000_000_000n, CUSD_ASSET)).toBe('$10,000.00')
  })
  it('rounds to the cent', () => {
    expect(formatUsd(1_505_000n, CUSD_ASSET)).toBe('$1.50') // 1.505 → floor to cent
    expect(formatUsd(0n, CUSD_ASSET)).toBe('$0.00')
  })
})
