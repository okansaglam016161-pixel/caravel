// Declares what this build of the journal records, and freezes the set of UTXOs that predate it.
//
// ── WHY COVERAGE IS DECLARED BY THE CODE, NOT BY A USER ACTION ───────────────
//
// "Does the journal record @name registrations" is a fact about the build, not about the wallet.
// This build does — stages C and D wired the last two — so it says so once per wallet, on first
// run. The ordering is the guard the whole phase rests on: coverage may only be declared by a
// build that actually captures, and this hook could not exist before the capture did.
//
// ── AND WHY THE BASELINE COMES AFTERWARDS ───────────────────────────────────
//
// Everything already in the owned set at this moment was created by actions nobody was recording,
// so none of it may ever be classified. The baseline freezes exactly that set — and it needs a
// COMPLETE scan, because a baseline missing a UTXO leaves that UTXO permanently eligible for
// classification, which is a false receive waiting to happen. So coverage is declared immediately
// and the baseline is taken from the first complete scan after it.
//
// THE WINDOW BETWEEN THEM IS SAFE. A payment arriving after coverage is declared but before the
// baseline is captured gets swept into the baseline and is never classified. That loses a real
// receive, which is the direction this whole phase errs in on purpose: a missed receive leaves a
// correct balance, a fabricated one destroys trust in the ledger.

import { useEffect } from 'react'
import { OUTPUT_CREATING_ACTIONS } from '../crypto/journal'
import { loadEpoch, recordCoverage } from '../crypto/journalStore'
import { captureBaseline, loadLedger } from '../crypto/utxoLedger'
import type { ScanState } from '../context/WalletContext'

export function useJournalCoverage(walletAddress: string | null, scan: ScanState): void {
  const { status, incomplete, generation } = scan

  // 1 · Declare coverage. Idempotent: recordCoverage unions the set and never moves
  //     `coverageCompleteAt` once stamped, so running on every unlock changes nothing after the
  //     first — and a re-run cannot slide the threshold forward and re-admit UTXOs.
  useEffect(() => {
    if (!walletAddress) return
    const epoch = loadEpoch(walletAddress)
    if (epoch?.coverageCompleteAt !== null && epoch !== null) return
    recordCoverage(walletAddress, OUTPUT_CREATING_ACTIONS)
  }, [walletAddress])

  // 2 · Freeze the pre-coverage set, from the first COMPLETE scan after coverage was declared.
  //     `captureBaseline` is write-once and refuses a truncated scan, so both rules live in the
  //     store under test rather than in this condition.
  useEffect(() => {
    if (!walletAddress) return
    if (status !== 'done' || incomplete) return
    const epoch = loadEpoch(walletAddress)
    if (!epoch || epoch.coverageCompleteAt === null) return
    if (loadLedger(walletAddress).baseline !== null) return
    captureBaseline(walletAddress, { utxoIds: scan.utxos.map(u => u.id), incomplete })
    // `scan.utxos` is a fresh array every scan; the generation is the reading's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, status, incomplete, generation])
}
