// This wallet's Caravel Trade records as React state — the useCusdClaims pattern for crypto/tradeStore.
//
// Written outside React (by crypto/tradeActions, and by the order watcher on a rescan), so the Activity
// list learns a new trade, or that one of our orders was filled, by subscribing to the store directly.

import { useSyncExternalStore } from 'react'
import { subscribeTrades, tradesSnapshot, type TradeRecord } from '../crypto/tradeStore'

export function useTrades(walletAddress: string | null): TradeRecord[] {
  return useSyncExternalStore(
    subscribeTrades,
    () => tradesSnapshot(walletAddress),
    () => tradesSnapshot(walletAddress),
  )
}
