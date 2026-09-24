//   "Claim testnet funds" — the M4 (v2) presentation over the SAME logic.
//
//   RESKIN, NOT REWRITE. Every piece of behaviour below is untouched: the phase machine, claim(),
//   the verify loop (now WalletContext's), the 60s cooldown, the 150s deadline, the balance
//   threshold (now v2/faucetPhase's HIGH_BALANCE),
//   and the account-address capture that only this transaction can perform. What changed is that
//   the eight states now render through v2's FaucetPanel instead of hand-rolled markup, so the
//   card matches the rest of the modal — and the copy no longer explains our machinery.

import { useEffect, useState, useRef } from 'react'
import { useWallet } from '../../context/WalletContext'
import { claimFaucet, type ClaimResult } from '../../crypto/faucet'
import { saveAccountAddress } from '../../crypto/accountStore'
import { beginEntry, settleEntry } from '../../crypto/journalStore'
import { settleVerdict, journalOutcomeFor, type SettleStartedBy } from './v2/settleVerdict'
import { FaucetBanner, FaucetPanel } from './v2/panels'
import { faucetPhase, isHidden } from './v2/faucetPhase'
import { plainError } from './v2/plainError'
import { fmt2, formatCooldown } from './v2/format'

type Phase = 'idle' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error'

/** Caravel's own re-claim throttle. Named so the timer and the timeout cannot drift apart. */
const COOLDOWN_MS = 60_000
// Was `Number(µt) / 1_000_000` — the same float-on-an-amount the rail forbids, hiding in a panel
// rather than in crypto, which is why the C9 fix nearly stopped one site short. See fmt2.
const shortTx = (t: string | null) => (t ? `${t.slice(0, 8)}…${t.slice(-6)}` : '')

// ── DISMISSAL IS PER WALLET ───────────────────────────────────────────────────
//
// The faucet is a prompt about THIS wallet's funding, so "I don't need this" is a fact about this
// wallet and the address is the key. A restore onto a different address gets the prompt back,
// because for that wallet the question has not been asked yet.
//
// The try/catch is hooks/useTheme's: private mode and blocked storage throw on both the read and
// the write, and neither is worth surfacing here. A blocked write costs the dismissal its memory —
// the card comes back on the next reload — and nothing else.
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
  const { wallet, address, scan, rescan, settles, beginSettle, acknowledgeSettle } = useWallet()
  const balance = scan.balance
  const [p, setPhase] = useState<Phase>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(false)
  // ── THE COUNTDOWN IS DISPLAY-ONLY ──
  //
  // `cooldown` above is unchanged and still the thing that drives the phase. These two exist
  // purely so 10g can show a number: `cooldownUntil` is when the boolean will flip back, and
  // `nowTick` re-renders once a second while it matters. Nothing here can start, stop or extend a
  // cooldown — it only reads the one already running.
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const lastTx = useRef<string | null>(null)
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

  // ── Reacting to the settle the CONTEXT is running ──────────────────────────
  //
  // A claim used to hold its own copy of the loop, its own baseline ref and its own deadline ref —
  // all inside a panel that is unmounted the moment the wallet modal closes. Claiming and then
  // closing the modal killed the verification outright: the tokens arrived, and the screen that
  // would have said so no longer existed. Same bug as the move flow's, in a third place, which is
  // why the loop now lives in WalletContext for all of them.
  const settle = settles.find(e => e.txId === lastTx.current && e.kind === 'faucet')
  useEffect(() => {
    if (!settle || settle.status === 'settling') return
    const verdict = settleVerdict(startedBy.current, settle.status)
    if (verdict.kind === 'confirmed' && !verdict.lagged) {
      setPhase('done')
      // The delta is measured by the loop, from the two readings it actually compared.
      setMsg(settle.delta === null
        ? 'Tokens received. You can now send them, make them public, or register a name.'
        : `Added ${fmt2(settle.delta)} XTR. You can now send it, make it public, or register a name.`)
      setCooldown(true)
      setCooldownUntil(Date.now() + COOLDOWN_MS)
      setTimeout(() => { setCooldown(false); setCooldownUntil(null) }, COOLDOWN_MS)
    } else if (verdict.kind === 'confirmed') {
      // Lagged, but the claim DID commit — the receipt said so. 'lagging' spins and promises the
      // funds will arrive, which is only sayable on this branch.
      setPhase('lagging')
      setMsg(`Claim committed on-chain (tx ${shortTx(settle.txId)}), but your balance hasn't updated yet. Tap Refresh in a moment.`)
    } else {
      // Nothing observed, twice. This must NOT spin and must NOT promise arrival — but it also
      // must not repeat the old line's claim that no tokens were added, which nobody verified.
      setPhase('error')
      setMsg(`We couldn't confirm this claim (tx ${shortTx(settle.txId)}). If the tokens landed they'll show in your balance — tap Refresh in a moment before claiming again.`)
    }
    // The journal row corrects with the screen. Null on an unknown verdict, so it keeps saying
    // `timeout` rather than gaining an outcome nobody established.
    const outcome = journalOutcomeFor(verdict)
    if (outcome && address && journalIdRef.current) settleEntry(address, journalIdRef.current, { outcome })
    acknowledgeSettle(settle.txId)
  }, [settle, acknowledgeSettle, address])

  async function claim() {
    if (!wallet || !address) return
    setPhase('claiming')
    setMsg('Requesting test tokens (self-signed, no daemon)…')

    // A claim deposits a confidential output into this wallet, and a later scan cannot tell that
    // output apart from a payment somebody else sent — it carries no sender either. Journalled
    // before submission so the attempt survives a throw, and so the output it creates is on record.
    const journalId = beginEntry(address, {
      kind: 'faucet',
      amountMicrotari: null,      // the payout is only known once the claim returns
      feeMicrotari: null,
      from: 'external',
      to: 'private',
      counterparty: { kind: 'faucet', value: 'esmeralda-faucet' },
      note: null,
      source: 'local-journal',
      selfOutputIds: null,
      // A claim CONSUMES NOTHING of ours — it mints from the faucet's vault. `[]` is a positive
      // claim of "no stealth inputs", not a hole.
      spentInputIds: [],
    }).entry.id
    journalIdRef.current = journalId

    // Read BEFORE the claim is made. A rise watch compares against this, and a settle-poll rescan
    // landing between the request and the response would otherwise fold the payout into the
    // baseline — leaving the watch waiting for a rise that had already happened.
    const privateBefore = balance

    let r: ClaimResult
    try {
      r = await claimFaucet(wallet, address, m => setMsg(m))
    } catch (e) {
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
    // The claim is the only transaction Caravel runs that creates an account component, so this is
    // the one place its address can be learned (it is not derivable client-side — see
    // accountAddress.ts). Stored before the outcome check below only in the sense that it is stored
    // as soon as it exists: `accountAddress` is set exclusively on a committed result, and the store
    // ignores an empty value, so a failed claim writes nothing.
    if (r.accountAddress) saveAccountAddress(address, r.accountAddress)
    // ── ONLY A REJECT IS AN ANSWER ────────────────────────────────────────────
    //
    // This branch used to catch Timeout too and say "no tokens added" — a claim nobody had checked,
    // on the path where the tokens usually DO arrive. A Timeout means the poll gave up at ~30s
    // against a 60–90s indexer lag; the balance watch below is what can actually tell.
    if (r.outcome === 'Reject') {
      setPhase('error')
      // THE NETWORK'S REASON, WHEN IT GAVE ONE. The flat line below asserted "no tokens were
      // added", which is true of a plain rejection and NOT of the variant where the fee commits and
      // the body does not — that one costs the claimant a fee for nothing, and saying so is the
      // only way they would ever know. `msg` renders through plainError, which leaves a reason it
      // does not recognise exactly as the network wrote it.
      setMsg(r.reason ?? 'The network rejected the claim — no tokens were added.')
      return
    }
    startedBy.current = r.outcome
    // Verify the balance actually rises before declaring success.
    //
    // NOT `?? 0n` on the baseline. This is a RISE watch, and zero is below any real balance, so an
    // unknown baseline would satisfy the comparison on the very first poll and report "Tokens
    // received" before the faucet's output had landed. That is not theoretical here: a claim is the
    // flow a brand-new wallet runs, and its first scan is often still in flight at this moment.
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

  // One re-render a second while a cooldown is running, and none at any other time.
  useEffect(() => {
    if (!cooldown) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [cooldown])

  // ── PRESENTATION ──
  //
  // The ladder moved to v2/faucetPhase, pure and under test. It used to end `: 'idle'` — an
  // unconditional fall-through — so a balance that was merely UNREAD read as "low" and flashed a
  // claim banner through every refresh. It now has a phase of its own for not knowing.
  const phase = faucetPhase({
    claim: p,
    cooldown,
    balance,
    unlocked: !!wallet && !!address,
  })

  // ── A PROMPT, NOT A FIXTURE ─────────────────────────────────────────────────
  //
  // Two phases are the faucet declining, and a card that renders a decline is a permanent object
  // on the overview saying nothing anyone can act on. `plenty` is the state every funded wallet
  // ends in — the payout is 1000 tTARI against a 100 tTARI threshold, so one claim puts a wallet
  // over it for good — which is exactly the shape V3 does not draw: series 01 gives the faucet a
  // thin prompt with a ✕ on it, not a permanent card. `locked` is the same argument with a
  // different reason: a card explaining why a control it is not showing would not work.
  //
  // The dismissal is honoured unconditionally and can be, because `dismiss` is only reachable from
  // the ✕, the ✕ only renders on the two resting phases, and this card is the only way to start a
  // claim. There is no path on which a claim is in flight and this is true.
  if (isHidden(phase) || dismissed) return null

  const remainingMs = cooldownUntil === null ? undefined : Math.max(0, cooldownUntil - nowTick)

  // ── RESTING IS A NOTICE. A CLAIM IS A CARD. ─────────────────────────────────
  //
  // V3 draws these as two different objects in one place: series 01's thin dashed prompt above the
  // hero while the faucet is just sitting there, and series 10's card once there is something to
  // report. So this component picks between them by phase rather than dressing one as the other.
  //
  // THE ✕ FOLLOWS THE OFFER, NOT THE PROMPT. A banner that is OFFERING something can be declined,
  // which is what the ✕ means — "not for this wallet". A banner counting down to the next claim is
  // REPORTING one that already happened, and the only card that ever replaces it is reporting a
  // transaction, so neither takes a ✕. There is no dismiss control on FaucetPanel at all, which is
  // what makes "an in-flight claim cannot be dismissed" a fact about the component tree rather
  // than a condition somebody has to keep true.
  if (phase === 'idle' || phase === 'cooldown') {
    const counting = remainingMs !== undefined && remainingMs > 0
    return (
      <FaucetBanner
        text={
          phase === 'idle' ? 'Testnet faucet is open.'
          : counting ? `Next claim available in ${formatCooldown(remainingMs)}.`
          : 'Just claimed. You can claim again shortly.'
        }
        action={phase === 'idle' ? { label: 'Claim test funds', onClick: claim } : undefined}
        onDismiss={counting ? undefined : dismiss}
      />
    )
  }

  return (
    <FaucetPanel
      phase={phase}
      // The claim's own message already carries the delta; plainError is a no-op on it, and is
      // applied for the same reason it is everywhere else — a failure here can quote a fee.
      message={msg ? plainError(msg) : undefined}
      onClaim={claim}
      cooldownRemainingMs={remainingMs}
    />
  )
}
