// Lets the indexer catch up with what this wallet already knows it spent.
//
// ── WHY IT IS A HOOK, AND WHY IT IS THIS ONE ─────────────────────────────────
//
// Exactly useUtxoLedger's argument, and it sits beside it for the same reason: the scan pipeline
// produces the balance, and bookkeeping that no balance depends on must not be able to fail it,
// retry it, or hold it up. Both hooks key on the scan's GENERATION — one write per completed
// refresh, not one per render — and both are idempotent, because two WalletModals can be mounted
// at once (the always-mounted page in the service shell, and the in-chat modal).
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
//
// It never marks anything spent. Locking, promotion and release all happen inside the spend paths
// themselves (crypto/confidentialSend, crypto/reveal), where the submission and the verdict are,
// because a lock has to exist before a verdict arrives and no UI can observe that window. This is
// only the FORGETTING half: once `/utxos` has stopped listing a commitment for long enough to be
// believed, the record of it is no longer earning its keep.
//
// The retention rule itself lives in crypto/spentOutputs, under test, rather than here — a scan
// count and a time floor, because a single listing has been measured dropping live outputs.

import { useEffect } from 'react'
import { reconcileSpentOutputs } from '../crypto/spentOutputs'
import type { ScanState } from '../context/WalletContext'

export function useSpentOutputs(walletAddress: string | null, scan: ScanState): void {
  const { status, incomplete, generation } = scan

  useEffect(() => {
    if (!walletAddress) return
    if (status !== 'done') return
    // A truncated scan is refused inside the store, so the rule has one home and one test. Passed
    // through rather than checked here, exactly as useUtxoLedger does.
    reconcileSpentOutputs(walletAddress, {
      presentIds: scan.excludedPresent.map(e => e.id),
      incomplete,
    })
    // `scan.excludedPresent` is a fresh array every scan; the generation is the reading's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, status, incomplete, generation])
}
