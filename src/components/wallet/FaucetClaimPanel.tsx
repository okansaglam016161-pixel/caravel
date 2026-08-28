//   "Claim testnet funds" — the M4 (v2) presentation over the SAME logic.
//
//   RESKIN, NOT REWRITE. Every piece of behaviour below is untouched: the phase machine, claim(),
//   the verify loop (now WalletContext's), the 60s cooldown, the 150s deadline, HIGH_BALANCE,
//   and the account-address capture that only this transaction can perform. What changed is that
//   the eight states now render through v2's FaucetPanel instead of hand-rolled markup, so the
//   card matches the rest of the modal — and the copy no longer explains our machinery.

import { useEffect, useState, useRef } from 'react'
import { useWallet } from '../../context/WalletContext'
import { claimFaucet, type ClaimResult } from '../../crypto/faucet'
import { saveAccountAddress } from '../../crypto/accountStore'
import { FaucetPanel, type FaucetPhase } from './v2/panels'
import { plainError } from './v2/plainError'
import { fmt2 } from './v2/format'

type Phase = 'idle' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error'

const HIGH_BALANCE = 100_000_000n // 100 tTARI — "you already have plenty"
// Was `Number(µt) / 1_000_000` — the same float-on-an-amount the rail forbids, hiding in a panel
// rather than in crypto, which is why the C9 fix nearly stopped one site short. See fmt2.
const shortTx = (t: string | null) => (t ? `${t.slice(0, 8)}…${t.slice(-6)}` : '')


export default function FaucetClaimPanel() {
  const { wallet, address, scan, rescan, settles, beginSettle, acknowledgeSettle } = useWallet()
  const balance = scan.balance
  const [p, setPhase] = useState<Phase>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(false)
  const lastTx = useRef<string | null>(null)

  const highBalance = balance !== null && balance >= HIGH_BALANCE
  const busy = p === 'claiming' || p === 'verifying'

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
    if (settle.status === 'settled') {
      setPhase('done')
      // The delta is measured by the loop, from the two readings it actually compared.
      setMsg(settle.delta === null
        ? 'Tokens received. You can now send them, make them public, or register a name.'
        : `Added ${fmt2(settle.delta)} XTR. You can now send it, unshield it, or register a name.`)
      setCooldown(true)
      setTimeout(() => setCooldown(false), 60_000)
    } else {
      setPhase('lagging')
      setMsg(`Claim committed on-chain (tx ${shortTx(settle.txId)}), but your balance hasn't updated yet. Tap Refresh in a moment.`)
    }
    acknowledgeSettle(settle.txId)
  }, [settle, acknowledgeSettle])

  async function claim() {
    if (!wallet || !address) return
    setPhase('claiming')
    setMsg('Requesting test tokens (self-signed, no daemon)…')
    let r: ClaimResult
    try {
      r = await claimFaucet(wallet, address, m => setMsg(m))
    } catch (e) {
      setPhase('error')
      setMsg((e as Error).message || 'Claim failed.')
      return
    }
    lastTx.current = r.txId
    // The claim is the only transaction Caravel runs that creates an account component, so this is
    // the one place its address can be learned (it is not derivable client-side — see
    // accountAddress.ts). Stored before the outcome check below only in the sense that it is stored
    // as soon as it exists: `accountAddress` is set exclusively on a committed result, and the store
    // ignores an empty value, so a failed claim writes nothing.
    if (r.accountAddress) saveAccountAddress(address, r.accountAddress)
    if (r.outcome !== 'Commit') {
      setPhase('error')
      setMsg(`Claim did not land on-chain (${r.outcome}) — no tokens added.`)
      return
    }
    // Committed — verify the balance actually rises before declaring success.
    //
    // NOT `?? 0n` on the baseline. This is a RISE watch, and zero is below any real balance, so an
    // unknown baseline would satisfy the comparison on the very first poll and report "Tokens
    // received" before the faucet's output had landed. That is not theoretical here: a claim is the
    // flow a brand-new wallet runs, and its first scan is often still in flight at this moment.
    setPhase('verifying')
    setMsg('Claim confirmed on-chain — updating your balance…')
    beginSettle({
      txId: r.txId,
      kind: 'faucet',
      // /utxos indexing can lag ~60-90s after the claim commits.
      deadlineAt: Date.now() + 150_000,
      watches: [{ side: 'private', direction: 'rise', before: balance }],
    })
    rescan()
  }

  // ── PRESENTATION ──
  //
  // The phase machine above maps onto v2's FaucetPanel one state at a time. `cooldown` and
  // `highBalance` are separate flags rather than phases in the logic, so they are folded in here
  // in the same precedence order the original markup used.
  const phase: FaucetPhase =
    p === 'done' ? 'done'
    : p === 'lagging' ? 'lagging'
    : p === 'error' ? 'error'
    : cooldown ? 'cooldown'
    : busy ? (p === 'claiming' ? 'claiming' : 'verifying')
    : highBalance ? 'plenty'
    : !wallet || !address ? 'locked'
    : 'idle'

  return (
    <FaucetPanel
      phase={phase}
      balance={balance ?? undefined}
      // The claim's own message already carries the delta; plainError is a no-op on it, and is
      // applied for the same reason it is everywhere else — a failure here can quote a fee.
      message={msg ? plainError(msg) : undefined}
      onClaim={claim}
      onRefresh={rescan}
    />
  )
}
