// THE ONE FULL RESCAN: the wallet's own refresh (TARI private + public, and cUSD — the same rescan()
// the Wallet tab's refresh runs) PLUS a fresh read of the market (the order book's new, filled and
// cancelled orders, My orders, Recent trades). The Trade page's refresh, its "Try again" / "Retry",
// the refresh after a trade, and the cUSD faucet claim all call THIS — one function, not copies.
//
// ORDER: the market is read first, then the wallet. The market read marks this wallet's orders that
// somebody filled (from the engine's fill events, even while the order's new state is not served
// verified yet), and the cUSD scan then asks for that order's payout by id — so a maker's payout shows
// after ONE press rather than two. A market that cannot be reached does not stop the wallet scan.
//
// NOTHING HERE RUNS ON ITS OWN. A wallet scan happens when somebody asks for one (or a transaction of
// theirs settles); the only automatic read is the market feed's 20 s order-book poll.

import { useCallback, useState } from 'react'
import { useWallet } from '../context/WalletContext'
import { existingMarketFeed } from './useMarket'

/** Read the market (when this wallet has a feed), then run the full wallet scan. Never throws. */
export async function runFullRescan(rescan: () => Promise<void>, address: string | null): Promise<void> {
  const feed = address ? existingMarketFeed(address) : null
  if (feed) await feed.refresh()   // the feed records its own failure (unreachable); never throws
  await rescan().catch(() => undefined)
}

/** The full rescan, and whether one is running (for the spinning refresh / "Updating…"). */
export function useFullRescan(): { run: () => Promise<void>; busy: boolean } {
  const { rescan, address } = useWallet()
  const [busy, setBusy] = useState(false)
  const run = useCallback(async () => {
    setBusy(true)
    try { await runFullRescan(rescan, address) } finally { setBusy(false) }
  }, [rescan, address])
  return { run, busy }
}
