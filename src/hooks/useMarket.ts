// The market for the Trade page (T4): the order book, this wallet's orders, recent trades — kept fresh
// while the page is subscribed (crypto/marketFeed), one feed per unlocked wallet.
//
// Returns the feed's snapshot (status + data; see crypto/marketFeed for what each status promises)
// and `refresh`, for a Refresh button and for right after this wallet trades. The feed is created on
// first use and dropped when the wallet locks, so nothing polls for a wallet that is gone.

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useWallet } from '../context/WalletContext'
import { MarketReader } from '../crypto/market'
import { createMarketFeed, type MarketFeed, type MarketSnapshot } from '../crypto/marketFeed'

const feeds = new Map<string, MarketFeed>()
const NO_WALLET: MarketSnapshot = { status: 'loading', data: null, error: null }
const IDLE: MarketFeed = {
  subscribe: () => () => {}, getSnapshot: () => NO_WALLET, refresh: async () => {}, stop: () => {},
}

/** The feed for `address`, created once. Exported for the harness and tests. */
export function marketFeedFor(address: string, tradeRoot: Uint8Array): MarketFeed {
  let feed = feeds.get(address)
  if (!feed) {
    feed = createMarketFeed(new MarketReader({ walletAddress: address, tradeRoot }))
    feeds.set(address, feed)
  }
  return feed
}

/** Stop and forget every feed (the wallet locked). */
export function dropMarketFeeds(): void {
  for (const f of feeds.values()) f.stop()
  feeds.clear()
}

export function useMarket(): MarketSnapshot & { refresh: () => Promise<void> } {
  const { address, purposeKeys } = useWallet()
  const feed = useMemo(
    () => (address && purposeKeys ? marketFeedFor(address, purposeKeys.tradeRoot) : IDLE),
    [address, purposeKeys],
  )
  // A lock clears the identity: stop polling for the wallet that went away.
  useEffect(() => { if (!address) dropMarketFeeds() }, [address])
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot)
  return { ...snapshot, refresh: feed.refresh }
}
