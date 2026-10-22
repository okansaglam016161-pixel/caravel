// The cUSD claim records as React state — the useJournal pattern for crypto/cusdStore.
//
// Written to localStorage by the cUSD claim path, outside React, so the Activity list learns a new
// claim's amount the same way it learns a journal write: by subscribing to the store directly.

import { useSyncExternalStore } from 'react'
import { cusdClaimsSnapshot, subscribeCusdClaims, type CusdClaimRecord } from '../crypto/cusdStore'

export function useCusdClaims(walletAddress: string | null): CusdClaimRecord[] {
  return useSyncExternalStore(
    subscribeCusdClaims,
    () => cusdClaimsSnapshot(walletAddress),
    () => cusdClaimsSnapshot(walletAddress),
  )
}
