//   "Claim test cUSD" — the cUSD faucet, on the v2 banner. The TARI FaucetClaimPanel's shape, pared
//   down to the cUSD faucet's simpler surface: it has no admin state (no pause, no adjustable
//   amount), so the states are claimed, open, needs-tTARI, and the claim's own in-flight phases.
//
//   WHAT DECIDES VISIBILITY: the cUSD faucet's status for THIS wallet, read from the receipt
//   (crypto/cusdFaucet.readCusdClaimed). A wallet that has claimed never sees it again; one that has
//   not sees "Claim test cUSD" — and, if it holds no tTARI for the fee, the offer explains that
//   first rather than failing at the press.
//
//   The claim itself is crypto/cusdFaucet: fee from the wallet's own tTARI, the whole 10,000 cUSD
//   lands. Journalled (kind 'cusd-faucet', TARI side) before submit; the cUSD amount and output id
//   go to crypto/cusdStore. A committed claim triggers a rescan, and the cUSD scan recovers the new
//   output by id (it lags the listing by a minute), so the Assets row updates without a reload.

import { useEffect, useRef, useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import {
  prepareCusdClaim, readCusdClaimed, CusdClaimRefused, CUSD_CLAIM_UNITS,
  type CusdClaimResult, type PreparedCusdClaim,
} from '../../crypto/cusdFaucet'
import { CUSD_ASSET, formatUnits } from '../../crypto/assets'
import { QuoteChanged } from '../../crypto/quote'
import { createActionLock, guarded } from '../../crypto/actionLock'
import { beginEntry, settleEntry } from '../../crypto/journalStore'
import { recordCusdClaim } from '../../crypto/cusdStore'
import { FaucetBanner } from './v2/panels'
import { plainError } from './v2/plainError'

type Phase = 'idle' | 'claiming' | 'done' | 'error'
type Status = 'open' | 'claimed' | 'unknown' | null

function hexOf(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

const CLAIM_LABEL = `${formatUnits(CUSD_CLAIM_UNITS, CUSD_ASSET.decimals)} ${CUSD_ASSET.ticker}`

// Dismissal is per wallet, like the TARI faucet's (hooks/useTheme try/catch for blocked storage).
const dismissKey = (address: string) => `caravel-cusd-faucet-dismissed-${address}`
function readDismissed(address: string | null): boolean {
  if (!address) return false
  try { return localStorage.getItem(dismissKey(address)) === '1' } catch { return false }
}

export default function CusdFaucetClaimPanel() {
  const { wallet, purposeKeys, address, cusd, rescan } = useWallet()
  const [phase, setPhase] = useState<Phase>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [prepared, setPrepared] = useState<PreparedCusdClaim | null>(null)
  const [pricing, setPricing] = useState<'idle' | 'pricing' | 'failed'>('idle')
  const priceGen = useRef(0)
  const journalIdRef = useRef<string | null>(null)
  const [dismissed, setDismissed] = useState(() => readDismissed(address))
  useEffect(() => { setDismissed(readDismissed(address)) }, [address])

  function dismiss() {
    setDismissed(true)
    if (!address) return
    try { localStorage.setItem(dismissKey(address), '1') } catch { /* blocked storage — won't survive a reload */ }
  }

  // The status, read once per wallet per mount: the receipt for this wallet's faucet key.
  useEffect(() => {
    setStatus(null)
    if (!wallet || !purposeKeys || !address) return
    let live = true
    void (async () => {
      try {
        const claimerPkHex = hexOf(await purposeKeys.faucet.getPublicKey())
        const s = await readCusdClaimed(claimerPkHex)
        if (live) setStatus(s === 'open' ? 'open' : s === 'claimed' ? 'claimed' : 'unknown')
      } catch { if (live) setStatus('unknown') }
    })()
    return () => { live = false }
  }, [wallet, purposeKeys, address])

  // Price while open (dry run; a refusal becomes the wallet's status).
  async function priceClaim() {
    if (!wallet || !purposeKeys || !address) return
    const gen = ++priceGen.current
    setPrepared(null)
    setPricing('pricing')
    try {
      const pc = await prepareCusdClaim(wallet, address, purposeKeys.faucet)
      if (gen !== priceGen.current) return
      setPrepared(pc)
      setPricing('idle')
    } catch (e) {
      if (gen !== priceGen.current) return
      setPricing('failed')
      if (e instanceof CusdClaimRefused) {
        if (e.refusal === 'already-claimed') { setStatus('claimed'); return }
        // needs-tTARI / empty / unsigned: show the refusal in place of the offer.
        setPhase('error'); setMsg(e.message)
      }
    }
  }

  const claimLock = useRef(createActionLock())
  const claim = guarded(claimLock.current, claimNow)

  async function claimNow() {
    if (!wallet || !address || !prepared) return
    const pc = prepared

    setPricing('pricing')
    try {
      await pc.confirm()
    } catch (e) {
      if (e instanceof QuoteChanged) { setPrepared(null); setPricing('idle'); return }
      setPricing('failed'); return
    }
    setPricing('idle')
    setPrepared(null)
    setPhase('claiming')
    setMsg('Requesting test cUSD (self-signed, no daemon)…')

    // Journalled before submit, so a throw still leaves a record. The TARI side: the fee the claim
    // paid, the tTARI change it created, the tTARI coins it spent. The cUSD amount is NOT here.
    const journalId = beginEntry(address, {
      kind: 'cusd-faucet',
      amountMicrotari: null,       // the only TARI that moved is the fee, recorded as feeMicrotari
      feeMicrotari: pc.fee,
      from: 'external',
      to: 'private',
      counterparty: { kind: 'faucet', value: 'caravel-cusd-faucet' },
      note: null,
      source: 'local-journal',
      selfOutputIds: null,         // set to the tTARI change on commit
      spentInputIds: null,         // set to the fee coins on commit
    }).entry.id
    journalIdRef.current = journalId

    let r: CusdClaimResult
    try {
      r = await pc.submit(m => setMsg(m))
    } catch (e) {
      if (e instanceof CusdClaimRefused) {
        settleEntry(address, journalId, { outcome: 'failed' })
        setPhase('error'); setMsg(e.message)
        if (e.refusal === 'already-claimed') setStatus('claimed')
        return
      }
      settleEntry(address, journalId, { outcome: 'pending' })
      setPhase('error'); setMsg((e as Error).message || 'Claim failed.')
      return
    }

    settleEntry(address, journalId, {
      outcome: r.outcome === 'Commit' ? 'committed' : r.outcome === 'Reject' ? 'rejected' : 'timeout',
      txId: r.txId,
      feeMicrotari: r.feeMicrotari ?? pc.fee,
      // TARI ids only — the tTARI change and the fee coins. The cUSD output goes to cusdStore.
      selfOutputIds: r.outcome === 'Commit' ? r.tariChangeOutputIds ?? null : null,
      spentInputIds: r.spentInputIds,
    })

    if (r.outcome === 'Commit') {
      // The cUSD amount and its output id, keyed by the journal entry: the Activity row's figure,
      // and the id the cUSD scan recovers before the listing has it.
      recordCusdClaim(address, {
        journalId,
        txId: r.txId,
        outputId: r.cusdOutputIds?.[0] ?? '',
        units: r.units,
        at: Date.now(),
      })
      setStatus('claimed')
      setPhase('done')
      setMsg(`Added ${CLAIM_LABEL} to your wallet.`)
      rescan()   // the cUSD scan recovers the new output by id — the Assets row updates
      return
    }
    if (r.outcome === 'Reject') {
      setPhase('error')
      setMsg(r.reason ? plainError(r.reason) : 'The network rejected the claim — no cUSD was added.')
      return
    }
    // Timeout: broadcast, not yet confirmed. Honest, not a failure.
    setPhase('done')
    setMsg(`Broadcast. ${CLAIM_LABEL} should arrive shortly — tap Refresh in a moment.`)
    rescan()
  }

  function retry() { setPhase('idle'); setMsg(null); setPrepared(null); setPricing('idle') }

  // Price once the banner is open and not dismissed.
  const wantPrice = status === 'open' && phase === 'idle' && !dismissed && !prepared && pricing === 'idle'
  useEffect(() => {
    if (wantPrice) void priceClaim()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantPrice])
  useEffect(() => { priceGen.current++; setPrepared(null); setPricing('idle') }, [address])

  // ── Presentation ──
  // Hidden entirely once claimed, while the status is unknown, or when this wallet already holds
  // cUSD (nothing to offer). A dismissal quiets the open offer.
  const alreadyHasCusd = cusd.status === 'done' && cusd.units !== null && cusd.units > 0n
  if (!wallet || !address) return null
  if (status === null || status === 'unknown' || status === 'claimed') {
    // Still show a terminal claim result (done/error) even as status flips to claimed.
    if (phase !== 'done' && phase !== 'error') return null
  }

  if (phase === 'done' || phase === 'error') {
    return (
      <FaucetBanner
        text={msg ?? ''}
        action={phase === 'error' ? { label: 'Try again', onClick: retry } : undefined}
      />
    )
  }

  if (status === 'open' && !dismissed && !alreadyHasCusd) {
    return (
      <FaucetBanner
        text={phase === 'claiming' ? (msg ?? 'Claiming test cUSD…') : `Claim ${CLAIM_LABEL} test dollars.`}
        action={phase === 'claiming' ? undefined
          : prepared && pricing === 'idle' ? { label: 'Claim', onClick: () => void claim() }
          : pricing === 'failed' ? { label: 'Try again', onClick: () => void priceClaim() }
          : undefined}
        onDismiss={phase === 'idle' ? dismiss : undefined}
      />
    )
  }

  return null
}

export { CLAIM_LABEL }
