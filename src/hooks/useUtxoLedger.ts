// Records what each completed scan saw, into the first-seen ledger.
//
// ── WHY IT IS A HOOK AND NOT PART OF THE SCAN ────────────────────────────────
//
// The natural home looks like WalletContext's scan effect, where the result already lands. It is
// deliberately not there: that effect is the balance pipeline, and the ledger is a consumer of it,
// not a participant. Keeping the write out here means the scan cannot be made to fail, retry
// differently, or hold a lock on account of bookkeeping that no balance depends on.
//
// ── IT MAY RUN TWICE, AND THAT IS FINE ───────────────────────────────────────
//
// Two WalletModals can be mounted at once — the always-mounted page inside the service shell, and
// the in-chat modal when it is open — so this can fire twice for the same scan. `recordCompleteScan`
// is first-write-wins, so the second call finds every id already stamped and writes nothing. The
// idempotence is the store's, not this hook's, which is why it is safe to mount wherever the scan
// is already read.
//
// ── GENERATION, NOT UTXO IDENTITY ────────────────────────────────────────────
//
// The effect keys on the scan's generation: one write per completed refresh, rather than one per
// render or one per change to an array that is rebuilt on every scan regardless of content.

import { useEffect } from 'react'
import { recordCompleteScan } from '../crypto/utxoLedger'
import type { ScanState } from '../context/WalletContext'

export function useUtxoLedger(walletAddress: string | null, scan: ScanState): void {
  const { status, incomplete, generation } = scan

  useEffect(() => {
    if (!walletAddress) return
    if (status !== 'done') return
    // A truncated scan is refused inside the store rather than here, so the rule has one home and
    // a test. Passed through so the store can say it skipped, and why.
    recordCompleteScan(walletAddress, {
      utxoIds: scan.utxos.map(u => u.id),
      incomplete,
    })
    // `scan.utxos` is deliberately absent: it is a fresh array every scan, so depending on it would
    // re-run on identity rather than on a new reading. The generation is the reading's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, status, incomplete, generation])
}
