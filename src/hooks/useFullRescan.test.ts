// The one full rescan: the market first (so a fill is recorded before the cUSD scan asks for the
// payout), then the wallet; a market that cannot be read never stops the wallet scan.

import { describe, expect, it, vi } from 'vitest'

const feeds = vi.hoisted(() => new Map<string, { refresh: () => Promise<void> }>())
vi.mock('./useMarket', () => ({ existingMarketFeed: (a: string) => feeds.get(a) ?? null }))
vi.mock('../context/WalletContext', () => ({ useWallet: () => ({}) }))

const { runFullRescan } = await import('./useFullRescan')

describe('runFullRescan', () => {
  it('reads the market, THEN scans the wallet', async () => {
    const order: string[] = []
    feeds.set('w', { refresh: async () => { order.push('market') } })
    await runFullRescan(async () => { order.push('wallet') }, 'w')
    expect(order).toEqual(['market', 'wallet'])
  })
  it('with no market feed (off the Trade page) it is just the wallet scan', async () => {
    const rescan = vi.fn(async () => {})
    await runFullRescan(rescan, 'nobody')
    expect(rescan).toHaveBeenCalledTimes(1)
  })
  it('a failing wallet scan does not throw out of it', async () => {
    await expect(runFullRescan(async () => { throw new Error('down') }, null)).resolves.toBeUndefined()
  })
})
