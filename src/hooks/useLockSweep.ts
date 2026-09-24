// Resolves every lock this wallet is still holding, once per completed scan.
//
// ── THE SECOND OF TWO TRIGGERS ───────────────────────────────────────────────
//
// WalletContext sweeps on UNLOCK, which repairs whatever a previous session stranded. This is the
// other half: a timeout that happens mid-session — the common case, since the poll gives up at
// ~30s against a 60-90s listing lag — would otherwise hold its inputs back until the next unlock.
// With this, it resolves within one refresh.
//
// ── WHY IT RESCANS, AND WHY THAT TERMINATES ──────────────────────────────────
//
// Resolving a lock changes what the NEXT scan may count, and the scan that triggered this sweep
// has already finished — so without a rescan the corrected balance would not appear until
// something else happened to ask for one. The loop closes on its own: `lockedTxIds` only returns
// transactions still marked `locked`, so a promoted or released one is not swept again, the next
// sweep resolves nothing, and no further rescan is requested.
//
// ── IT COSTS NOTHING WHEN NOTHING IS WRONG ───────────────────────────────────
//
// `sweepLocks` walks the locked set, which is empty for a wallet that is not mid-spend — no
// requests, no writes, no rescan. That is what makes running it after every scan reasonable.
//
// Same shape as useSpentOutputs and useUtxoLedger: keyed on the scan's GENERATION (one sweep per
// completed refresh, not one per render), and safe to mount twice, because the store's own
// bookkeeping is idempotent.

import { useEffect } from 'react'
import { sweepLocks } from '../crypto/lockSweep'
import type { ScanState } from '../context/WalletContext'

export function useLockSweep(
  walletAddress: string | null,
  scan: ScanState,
  onResolved: () => void,
): void {
  const { status, generation } = scan

  useEffect(() => {
    if (!walletAddress) return
    if (status !== 'done') return

    let cancelled = false
    void sweepLocks(walletAddress)
      .then(result => {
        // Only when something actually changed. A sweep that found nothing, or that could not
        // reach the indexer, must not spin the scan pipeline.
        if (!cancelled && result.resolved > 0) onResolved()
      })
      // A failed sweep is a wrong number for one more refresh, never a broken wallet.
      .catch(() => undefined)

    return () => { cancelled = true }
    // `onResolved` is deliberately absent: it is a useCallback over wallet + address, so listing it
    // would re-run this on every identity-shaped re-render rather than once per reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, status, generation])
}
