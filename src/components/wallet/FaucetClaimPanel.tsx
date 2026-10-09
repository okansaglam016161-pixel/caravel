//   "Claim testnet funds" — Caravel's own faucet, on the v2 presentation.
//
//   WHAT DECIDES VISIBILITY: the faucet's status for THIS wallet, read from the chain
//   (crypto/faucetStatus) — open, paused, empty, or claimed. Never the balance. A wallet that has
//   claimed never sees the faucet again; one that has not sees the claim when the faucet is open and
//   "check back soon" when it is paused or empty, whatever it holds.
//
//   The claim itself (crypto/faucet) and the settle that verifies it (WalletContext) are unchanged
//   in shape: journal before submission, a rise watch plus the claim's own output as evidence.
//
//   PRICED BEFORE IT IS OFFERED. While the faucet is open the claim is prepared in the background
//   (prepareClaim — a status read and a dry run at the exact fee, nothing submitted). The banner
//   stays the simple "Testnet faucet is open." and Claim submits that priced claim.

import { useEffect, useState, useRef } from 'react'
import { useWallet } from '../../context/WalletContext'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import {
  prepareClaim,
  claimRefusalMessage,
  classifyClaimFailure,
  FaucetClaimRefused,
  type ClaimResult,
  type PreparedClaim,
} from '../../crypto/faucet'
import { readFaucetStatus, type FaucetStatus } from '../../crypto/faucetStatus'
import { QuoteChanged, isFeeShortRejection } from '../../crypto/quote'
import { createActionLock, guarded } from '../../crypto/actionLock'
import { beginEntry, settleEntry } from '../../crypto/journalStore'
import { settleVerdict, journalOutcomeFor, type SettleStartedBy } from './v2/settleVerdict'
import { FaucetBanner, FaucetPanel } from './v2/panels'
import { faucetAddedMessage, faucetPhase, isHidden, type ClaimState } from './v2/faucetPhase'
import { plainError } from './v2/plainError'

const shortTx = (t: string | null) => (t ? `${t.slice(0, 8)}…${t.slice(-6)}` : '')



function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** Every key this wallet may have claimed with: the faucet key, and the owner key of older claims. */
async function claimantKeys(wallet: SecretKeyWallet, faucetKey: SecretKeyWallet): Promise<string[]> {
  return [toHexStr(await faucetKey.getPublicKey()), toHexStr(await wallet.getPublicKey())]
}

// ── DISMISSAL IS PER WALLET ───────────────────────────────────────────────────
//
// The ✕ on the open banner is "not for this wallet", so the address is the key. A dismissed faucet
// stays quiet in every resting state — open, paused or empty — so declining the offer once is not
// followed by notices about an offer that was declined. A claim in flight is never affected: the ✕
// only renders on the open banner, and this card is the only way to start a claim.
//
// The try/catch is hooks/useTheme's: private mode and blocked storage throw on both the read and
// the write. A blocked write costs the dismissal its memory and nothing else.
const dismissKey = (address: string) => `caravel-faucet-dismissed-${address}`

function readDismissed(address: string | null): boolean {
  if (!address) return false
  try {
    return localStorage.getItem(dismissKey(address)) === '1'
  } catch {
    return false
  }
}


export default function FaucetClaimPanel() {
  const { wallet, purposeKeys, address, scan, rescan, settles, beginSettle, acknowledgeSettle } = useWallet()
  const balance = scan.balance
  const [p, setPhase] = useState<ClaimState>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  // False when the faucet itself refused, so the error card does not offer a Retry that can only be
  // refused again.
  const [canRetry, setCanRetry] = useState(true)
  const [status, setStatus] = useState<FaucetStatus | null>(null)
  /**
   * The claim, priced for the banner: what lands, and the fee it pays. Claim submits exactly this.
   * `pricing` is the state of getting it — 'failed' offers a retry rather than a claim on a guess.
   */
  const [prepared, setPrepared] = useState<PreparedClaim | null>(null)
  const [pricing, setPricing] = useState<'idle' | 'pricing' | 'failed'>('idle')
  const priceGen = useRef(0)
  const lastTx = useRef<string | null>(null)
  /** What the claim itself paid in (its output: payout − fee) — the figure "Added" reports. */
  const claimed = useRef<bigint | null>(null)
  // How the watch began, and the row it must correct. Both refs: the effect reads them, nothing
  // renders them. See settleVerdict.ts.
  const startedBy = useRef<SettleStartedBy>('Commit')
  const journalIdRef = useRef<string | null>(null)

  // Read from storage rather than held across it: the address arrives after the first render on a
  // fresh unlock, and it changes under this component when a different wallet is restored.
  const [dismissed, setDismissed] = useState(() => readDismissed(address))
  useEffect(() => { setDismissed(readDismissed(address)) }, [address])

  function dismiss() {
    setDismissed(true)
    if (!address) return
    try { localStorage.setItem(dismissKey(address), '1') } catch { /* blocked storage — the dismissal just won't survive a reload */ }
  }

  // ── THE STATUS, READ ONCE PER WALLET PER MOUNT ─────────────────────────────
  //
  // Three point reads, no transaction. Cleared to null on a wallet change so one wallet's status is
  // never shown against another, and null renders nothing (v2/faucetPhase). A read that fails is
  // `unknown`, which also renders nothing — the faucet does not offer a claim on a guess.
  useEffect(() => {
    setStatus(null)
    if (!wallet || !purposeKeys || !address) return
    let live = true
    void (async () => {
      try {
        const s = await readFaucetStatus(address, await claimantKeys(wallet, purposeKeys.faucet))
        if (live) setStatus(s)
      } catch (e) {
        if (live) setStatus({ kind: 'unknown', reason: (e as Error).message })
      }
    })()
    return () => { live = false }
  }, [wallet, purposeKeys, address])

  // ── Reacting to the settle the CONTEXT is running ──────────────────────────
  //
  // The verify loop lives in WalletContext so closing the modal mid-claim does not kill it.
  const settle = settles.find(e => e.txId === lastTx.current && e.kind === 'faucet')
  useEffect(() => {
    if (!settle || settle.status === 'settling') return
    const verdict = settleVerdict(startedBy.current, settle.status)
    if (verdict.kind === 'confirmed' && !verdict.lagged) {
      setPhase('done')
      // THE CLAIM'S OWN AMOUNT, not the loop's delta: the balance can rise by more than the claim
      // when other money lands in the same window. See faucetAddedMessage.
      setMsg(faucetAddedMessage(claimed.current))
    } else if (verdict.kind === 'confirmed') {
      // Lagged, but the claim DID commit — the receipt said so. 'lagging' spins and promises the
      // funds will arrive, which is only sayable on this branch.
      setPhase('lagging')
      setMsg(`Claim committed on-chain (tx ${shortTx(settle.txId)}), but your balance hasn't updated yet. Tap Refresh in a moment.`)
    } else {
      // Nothing observed, twice. This must NOT spin and must NOT promise arrival — but it also
      // must not claim that no tokens were added, which nobody verified.
      setPhase('error')
      setCanRetry(true)
      setMsg(`We couldn't confirm this claim (tx ${shortTx(settle.txId)}). If the tokens landed they'll show in your balance — tap Refresh in a moment before claiming again.`)
    }
    // The journal row corrects with the screen. Null on an unknown verdict, so it keeps saying
    // `timeout` rather than gaining an outcome nobody established.
    const outcome = journalOutcomeFor(verdict)
    if (outcome && address && journalIdRef.current) settleEntry(address, journalIdRef.current, { outcome })
    acknowledgeSettle(settle.txId)
  }, [settle, acknowledgeSettle, address])

  /**
   * Price the claim for the banner. A dry run — nothing is submitted. A refusal found here (claimed,
   * paused, empty) becomes the wallet's status, exactly as a refused claim would.
   */
  async function priceClaim() {
    if (!wallet || !purposeKeys || !address) return
    const gen = ++priceGen.current
    setPrepared(null)
    setPricing('pricing')
    try {
      const pc = await prepareClaim(wallet, address, purposeKeys.faucet)
      if (gen !== priceGen.current) return
      setPrepared(pc)
      setPricing('idle')
    } catch (e) {
      if (gen !== priceGen.current) return
      setPricing('failed')
      // A refusal is the faucet's answer about THIS wallet: show that instead of a claim. Claimed is
      // final; paused / empty are re-read so the banner states them with the faucet's own figures.
      if (e instanceof FaucetClaimRefused) {
        if (e.refusal === 'already-claimed') { setStatus({ kind: 'claimed' }); return }
        try {
          const s2 = await readFaucetStatus(address, await claimantKeys(wallet, purposeKeys.faucet))
          if (gen === priceGen.current) setStatus(s2)
        } catch { /* keep 'failed' — the banner offers a retry */ }
      }
    }
  }

  // ONE RUN PER PRESS SEQUENCE — crypto/actionLock: taken synchronously, released when it settles.
  const claimLock = useRef(createActionLock())
  const claim = guarded(claimLock.current, claimNow)

  async function claimNow() {
    if (!wallet || !address || !prepared) return
    const pc = prepared

    // ── THE CONFIRM-TIME CHECK, BEFORE ANYTHING IS RECORDED OR SENT ──
    //
    // Quote age, the receipt still absent, and a dry run of this very claim at the quoted fee
    // (crypto/quote). If it no longer holds nothing was sent: price again and let Claim confirm that.
    setPricing('pricing')
    try {
      await pc.confirm()
    } catch (e) {
      // Clearing the quote with pricing idle is what makes the open banner price again (wantPrice).
      if (e instanceof QuoteChanged) { setPrepared(null); setPricing('idle'); return }
      setPricing('failed')
      return
    }
    setPricing('idle')
    setPrepared(null)
    setPhase('claiming')
    setCanRetry(true)
    setMsg('Requesting test tokens (self-signed, no daemon)…')

    // A claim deposits a confidential output into this wallet, and a later scan cannot tell that
    // output apart from a payment somebody else sent — it carries no sender either. Journalled
    // before submission so the attempt survives a throw, and so the output it creates is on record.
    const journalId = beginEntry(address, {
      kind: 'faucet',
      amountMicrotari: null,      // recorded once the claim commits — see the settle below
      feeMicrotari: pc.fee,       // priced before the user pressed Claim; the receipt confirms it
      from: 'external',
      to: 'private',
      counterparty: { kind: 'faucet', value: 'caravel-faucet' },
      note: null,
      source: 'local-journal',
      selfOutputIds: null,
      // A claim CONSUMES NOTHING of ours — the payout comes from the faucet's vault. `[]` is a
      // positive claim of "no stealth inputs", not a hole.
      spentInputIds: [],
    }).entry.id
    journalIdRef.current = journalId

    // Read BEFORE the claim is made. A rise watch compares against this, and a settle-poll rescan
    // landing between the request and the response would otherwise fold the payout into the
    // baseline — leaving the watch waiting for a rise that had already happened.
    const privateBefore = balance

    let r: ClaimResult
    try {
      r = await pc.submit(m => setMsg(m))
    } catch (e) {
      if (e instanceof FaucetClaimRefused) {
        // The faucet answered, and nothing was submitted — so this attempt definitely failed, and
        // the status it reported becomes this wallet's status.
        settleEntry(address, journalId, { outcome: 'failed' })
        setPhase('error')
        setCanRetry(false)
        setMsg(e.message)
        if (e.refusal === 'already-claimed') setStatus({ kind: 'claimed' })
        return
      }
      // Attempted, not failed: a throw is not proof the faucet did nothing.
      settleEntry(address, journalId, { outcome: 'pending' })
      setPhase('error')
      setMsg((e as Error).message || 'Claim failed.')
      return
    }
    settleEntry(address, journalId, {
      outcome: r.outcome === 'Commit' ? 'committed' : r.outcome === 'Reject' ? 'rejected' : 'timeout',
      txId: r.txId,
      // The amount and the output only exist on a committed claim; on any other outcome they stay
      // null rather than being recorded as zero.
      amountMicrotari: r.outcome === 'Commit' ? r.amount : null,
      feeMicrotari: r.feeMicrotari ?? null,
      selfOutputIds: r.outcome === 'Commit' ? r.selfOutputIds ?? null : null,
    })
    lastTx.current = r.txId
    // Only a claim that can still land has an amount to report; a reject never reaches "done".
    claimed.current = r.outcome === 'Reject' ? null : r.amount
    // ── ONLY A REJECT IS AN ANSWER ────────────────────────────────────────────
    //
    // A Timeout means the poll gave up against the indexer's lag; the balance watch below is what
    // can actually tell.
    if (r.outcome === 'Reject' && isFeeShortRejection(r.reason)) {
      // THE FEE ROSE AS IT WAS SENT — a free reject. Back to the banner, which prices again; Claim
      // confirms the new figure. Never resent on our own.
      setPrepared(null); setPricing('idle'); setPhase('idle')
      return
    }
    if (r.outcome === 'Reject') {
      setPhase('error')
      // The faucet's own refusals in plain words; anything else is THE NETWORK'S REASON, rendered
      // through plainError.
      const refusal = r.reason ? classifyClaimFailure(r.reason) : null
      if (refusal) {
        setCanRetry(false)
        setMsg(claimRefusalMessage(refusal))
        if (refusal === 'already-claimed') setStatus({ kind: 'claimed' })
        return
      }
      setMsg(r.reason ?? 'The network rejected the claim — no tokens were added.')
      return
    }
    // A committed claim makes this wallet claimed. The status flips now, so the card that reports
    // this claim is the last thing the faucet ever shows this wallet.
    if (r.outcome === 'Commit') setStatus({ kind: 'claimed' })
    startedBy.current = r.outcome
    // Verify the balance actually rises before declaring success.
    //
    // NOT `?? 0n` on the baseline. This is a RISE watch, and zero is below any real balance, so an
    // unknown baseline would satisfy the comparison on the very first poll and report "Tokens
    // received" before the claim's output had landed.
    setPhase('verifying')
    // Only the Commit path may say "confirmed" — a Timeout has no receipt to say it from.
    setMsg(r.outcome === 'Commit'
      ? 'Claim confirmed on-chain — updating your balance…'
      : 'Broadcast. Waiting to see the tokens arrive…')
    beginSettle({
      txId: r.txId,
      kind: 'faucet',
      // /utxos indexing can lag ~60-90s after the claim commits.
      deadlineAt: Date.now() + 150_000,
      watches: [{ side: 'private', direction: 'rise', before: privateBefore }],
      // THE EVIDENCE, not the direction: the claim's own stealth output. The rise watch stays as
      // the fallback for a claim whose statement could not be read — see PendingSettle.
      expectOutputs: r.selfOutputIds ?? null,
    })
    rescan()
  }

  /** Back from the error card to the open banner, which prices afresh — Claim is the confirm again. */
  function retry() {
    setPhase('idle')
    setMsg(null)
    setPrepared(null)
    setPricing('idle')
  }

  // ── PRESENTATION ──
  const phase = faucetPhase({
    claim: p,
    status: status?.kind ?? null,
    unlocked: !!wallet && !!address,
  })

  // PRICE WHILE OPEN. Runs once per open banner (and again after a retry): `pricing` leaves 'idle'
  // the moment it starts, and a failure stops at 'failed' with a retry rather than looping.
  const wantPrice = phase === 'open' && !dismissed && !prepared && pricing === 'idle'
  useEffect(() => {
    if (wantPrice) void priceClaim()
    // priceClaim reads only refs and setters plus wallet/address, which wantPrice already tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantPrice])

  // A different wallet: whatever was priced was priced for the old one.
  useEffect(() => { priceGen.current++; setPrepared(null); setPricing('idle') }, [address])

  if (isHidden(phase)) return null

  // ── RESTING IS A NOTICE. A CLAIM IS A CARD. ─────────────────────────────────
  //
  // Open, paused and empty are the faucet at rest: the thin dashed prompt. Only the open banner
  // offers anything, so only it carries the ✕ — and a dismissal quiets every resting state.
  if (phase === 'open' || phase === 'paused' || phase === 'empty') {
    if (dismissed) return null
    return (
      <FaucetBanner
        text={
          // THE SIMPLE PROMPT. The claim is still priced underneath (exact fee, no margin) and Claim
          // submits that priced claim; the banner just does not spell the arithmetic out.
          phase === 'open' ? 'Testnet faucet is open.'
          : phase === 'paused' ? 'The faucet is paused right now. Check back soon.'
          : 'The faucet is empty right now. Check back soon.'
        }
        action={phase !== 'open' ? undefined
          // Inert while the quote is being checked, so a second press cannot start a second claim.
          : prepared && pricing === 'idle' ? { label: 'Claim', onClick: () => void claim() }
          : pricing === 'failed' ? { label: 'Try again', onClick: () => void priceClaim() }
          : undefined}
        onDismiss={phase === 'open' ? dismiss : undefined}
      />
    )
  }

  return (
    <FaucetPanel
      phase={phase}
      // The claim's own message already carries the delta; plainError is a no-op on it, and is
      // applied for the same reason it is everywhere else — a failure here can quote a fee.
      message={msg ? plainError(msg) : undefined}
      onClaim={retry}
      canRetry={canRetry}
    />
  )
}
