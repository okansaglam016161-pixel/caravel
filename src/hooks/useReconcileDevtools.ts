// A dev-only window hook for inspecting reconciliation against the real wallet.
//
// Reconciliation is a pure function over data that is otherwise scattered across three stores and
// React state, so there is no way to see what it makes of an actual wallet without assembling that
// input by hand. This assembles it and hands the result to the console.
//
// DEV ONLY, and gated at the top so the whole body is dropped from a production bundle. It exposes
// no capability — every value it reads is already in localStorage or on screen, and it writes
// nothing.

import { useEffect } from 'react'
import { reconcile, type ReconcileResult } from '../crypto/reconcile'
import { loadEpoch, loadJournal } from '../crypto/journalStore'
import { loadLedger } from '../crypto/utxoLedger'
import type { ScanState } from '../context/WalletContext'
import type { CaravelMessage } from '../messaging/types'

declare global {
  interface Window {
    __caravelReconcile?: () => ReconcileResult & { ownedCount: number; leftoverCount: number }
  }
}

export function useReconcileDevtools(
  walletAddress: string | null,
  scan: ScanState,
  messages: readonly CaravelMessage[],
): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!walletAddress) return

    window.__caravelReconcile = () => {
      const result = reconcile({
        owned: scan.utxos,
        journal: loadJournal(walletAddress),
        ledger: loadLedger(walletAddress),
        epoch: loadEpoch(walletAddress),
        // Receives chat has already attributed, so they are not re-reported as unattributed.
        knownReceiveUtxoIds: messages
          .filter(m => m.direction === 'received' && m.payment?.utxoId)
          .map(m => m.payment!.utxoId),
      })
      return {
        ...result,
        ownedCount: scan.utxos.length,
        leftoverCount: result.receives.length + result.suppressed.length,
      }
    }

    return () => { delete window.__caravelReconcile }
  }, [walletAddress, scan, messages])
}
