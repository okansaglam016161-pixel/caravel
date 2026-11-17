import { describe, expect, it } from 'vitest'
import { APPROVED_ASSETS, TARI_ASSET, approvedAsset, formatUnits } from './assets'
import { RATE_NUM, RATE_DEN } from '../components/wallet/v2/fiat'

describe('the approved-asset allowlist', () => {
  it('is TARI alone, at 6 decimals', () => {
    expect(APPROVED_ASSETS.map(a => a.id)).toEqual(['tari'])
    expect(TARI_ASSET.decimals).toBe(6)
  })

  it('identifies an asset ONLY by its exact resource address', () => {
    expect(approvedAsset(TARI_ASSET.resource)?.id).toBe('tari')
    // Accepts the bare hex form too (the `/utxos` shape).
    expect(approvedAsset(TARI_ASSET.resourceHex)?.id).toBe('tari')
    // A look-alike — same symbol/decimals, different address — is NOT on the list.
    expect(approvedAsset('resource_' + 'f'.repeat(64))).toBeNull()
  })

  it('keeps TARI’s rate pinned to v2/fiat so the two cannot drift', () => {
    // fiat.ts: USD = microtari * RATE_NUM / RATE_DEN. One whole TARI is 10^6 base units.
    const perToken = Number((1_000_000n * RATE_NUM * 1_000_000n) / RATE_DEN) / 1_000_000
    expect(TARI_ASSET.usdPrice).toBeCloseTo(perToken, 10)
  })
})

describe('formatUnits', () => {
  it('renders 10,000 TARI from base units with grouping', () => {
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
