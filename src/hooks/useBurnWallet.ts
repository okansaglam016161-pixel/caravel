// The Burn page's view of the chain: the verified total and the list of burns.
//
// Loads when the page is first shown and on Refresh; a burn just made is watched until the verified
// total reflects it. Hidden panes stay mounted (see AppShell), so nothing here polls while the page
// is out of sight.

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAccountAddress } from '../crypto/accountStore'
import {
  accountVaultIds, burnFinalizedAt, classifyBurn, currentEpoch, listDeposits, readBurnWallet,
  type BurnClassification, type BurnWalletReading,
} from '../crypto/burnWallet'
import { buildBurnRows, burnSettled, depositsComplete, type BurnRow } from '../components/burn/burnModel'
import { useJournal } from './useJournal'

/** The hero's state. A figure is only ever a VERIFIED one; see crypto/burnWallet. */
export type HeroState =
  | { status: 'loading' }
  | { status: 'verified'; reading: BurnWalletReading }
  /** Nothing verified on the latest read. `last` is the last verified figure, if there was one. */
  | { status: 'updating'; last: BurnWalletReading | null }
  | { status: 'unreachable' }

export type ListState =
  | { status: 'loading' }
  | { status: 'ready'; rows: BurnRow[]; complete: boolean; total: number }
  | { status: 'error' }

/** Rows enriched per refresh — classification and times are a request each, so the list is capped. */
const ROWS_SHOWN = 50
/** After a burn: how often, and for how long, to re-read until the total shows it. */
const WATCH_EVERY_MS = 4_000
const WATCH_FOR_MS = 120_000

export function useBurnWallet(address: string | null, active: boolean) {
  const journal = useJournal(address)
  const [hero, setHero] = useState<HeroState>({ status: 'loading' })
  const [list, setList] = useState<ListState>({ status: 'loading' })
  /**
   * One flag for the WHOLE refresh — the total and the list (both tabs read the same list) — as
   * the wallet's Refresh stays busy until both of its reads settle. The header spins on it.
   */
  const [refreshing, setRefreshing] = useState(false)
  const lastVerified = useRef<BurnWalletReading | null>(null)
  const loadedOnce = useRef(false)
  const running = useRef(false)
  const journalRef = useRef(journal)
  journalRef.current = journal

  /** Re-read the total and the list. Resolves with what this read saw (rows null if the list failed). */
  const refresh = useCallback(async (): Promise<{ reading: BurnWalletReading | null; rows: BurnRow[] | null }> => {
    if (running.current) return { reading: lastVerified.current, rows: null }
    running.current = true
    setRefreshing(true)
    try {

      const read = await readBurnWallet()
      let verifiedTotal: bigint | null = null
      if (read.kind === 'verified') {
        lastVerified.current = read.reading
        verifiedTotal = read.reading.totalDeposited
        setHero({ status: 'verified', reading: read.reading })
      } else if (read.kind === 'unverified') {
        setHero({ status: 'updating', last: lastVerified.current })
      } else {
        setHero({ status: 'unreachable' })
      }

      let rows: BurnRow[] | null = null
      try {
        const deposits = await listDeposits()
        const shown = deposits.slice(0, ROWS_SHOWN)
        const account = address ? loadAccountAddress(address) : null
        const journalled = new Map<string, number>()
        for (const e of journalRef.current) {
          if (e.kind === 'burn' && e.txId) journalled.set(e.txId, e.timestamp)
        }
        const [classes, finalized, ownVaults, epoch] = await Promise.all([
          Promise.all(shown.map(async d => [d.txId, await classifyBurn(d.txId)] as const))
            .then(pairs => new Map<string, BurnClassification>(pairs)),
          Promise.all(shown.filter(d => !journalled.has(d.txId)).map(async d => [d.txId, await burnFinalizedAt(d.txId)] as const))
            .then(pairs => new Map<string, number | null>(pairs)),
          account ? accountVaultIds(account) : Promise.resolve(new Set<string>()),
          currentEpoch(),
        ])
        rows = buildBurnRows(shown, classes, { ownVaults, journalled, finalizedAt: finalized, currentEpoch: epoch, now: Date.now() })
        setList({
          status: 'ready', rows, total: deposits.length,
          complete: depositsComplete(deposits, verifiedTotal ?? lastVerified.current?.totalDeposited ?? null),
        })
      } catch {
        setList(l => (l.status === 'ready' ? l : { status: 'error' }))
      }
      return { reading: read.kind === 'verified' ? read.reading : null, rows }
    } finally {
      running.current = false
      setRefreshing(false)
    }
  }, [address])

  // First load: the first time the page is actually on screen.
  useEffect(() => {
    if (!active || loadedOnce.current) return
    loadedOnce.current = true
    void refresh()
  }, [active, refresh])

  /**
   * A burn of `amount` (transaction `txId`) just committed: keep reading until the verified total
   * includes it AND its row is classified — see burnSettled. Bounded by WATCH_FOR_MS.
   */
  const watchFor = useCallback((baseline: bigint | null, amount: bigint, txId: string) => {
    const deadline = Date.now() + WATCH_FOR_MS
    const tick = async () => {
      const { reading, rows } = await refresh()
      if (burnSettled(reading?.totalDeposited ?? null, baseline, amount, rows, txId)) return
      if (Date.now() < deadline) setTimeout(() => { void tick() }, WATCH_EVERY_MS)
    }
    void tick()
  }, [refresh])

  return { hero, list, refreshing, refresh, watchFor }
}
