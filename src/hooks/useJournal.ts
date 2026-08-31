// The activity journal, as React state.
//
// `useSyncExternalStore` rather than a context value, because the journal genuinely IS an external
// store: it is written to localStorage by the send, move and faucet call sites, none of which go
// through React state on the way. Subscribing to it directly is what lets those writes reach the
// Activity list without threading a setter through WalletContext — which would have meant a
// context change for a store the context does not own.

import { useSyncExternalStore } from 'react'
import { journalSnapshot, subscribeJournal } from '../crypto/journalStore'
import type { JournalEntry } from '../crypto/journal'

/**
 * Every journalled action for this wallet, newest first. `[]` while locked.
 *
 * The snapshot is cached in the store and only invalidated by a write, so this returns the same
 * array between writes — which is what keeps useSyncExternalStore from re-rendering forever.
 */
export function useJournal(walletAddress: string | null): JournalEntry[] {
  return useSyncExternalStore(
    subscribeJournal,
    () => journalSnapshot(walletAddress),
    () => journalSnapshot(walletAddress),   // SSR/hydration: same value, no server variant
  )
}
