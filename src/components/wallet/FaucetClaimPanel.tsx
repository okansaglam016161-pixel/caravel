//   "Claim testnet funds" — the M4 (v2) presentation over the SAME logic.
//
//   RESKIN, NOT REWRITE. Every piece of behaviour below is untouched: the phase machine, claim(),
//   the useBalanceSettle verify loop, the 60s cooldown, the 150s deadline, HIGH_BALANCE, the refs,
//   and the account-address capture that only this transaction can perform. What changed is that
//   the eight states now render through v2's FaucetPanel instead of hand-rolled markup, so the
//   card matches the rest of the modal — and the copy no longer explains our machinery.

import { useState, useRef } from 'react'
import { useWallet } from '../../context/WalletContext'
import { claimFaucet, type ClaimResult } from '../../crypto/faucet'
import { saveAccountAddress } from '../../crypto/accountStore'
import { useBalanceSettle } from './useBalanceSettle'
import { FaucetPanel, type FaucetPhase } from './v2/panels'
import { plainError } from './v2/plainError'

type Phase = 'idle' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error'

const HIGH_BALANCE = 100_000_000n // 100 tTARI — "you already have plenty"
const fmt = (µt: bigint) => (Number(µt) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const shortTx = (t: string | null) => (t ? `${t.slice(0, 8)}…${t.slice(-6)}` : '')


export default function FaucetClaimPanel() {
  const { wallet, address, scan, rescan } = useWallet()
  const balance = scan.balance
  const [p, setPhase] = useState<Phase>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(false)
  /** The balance before the claim, so the settle loop can see it rise. `null` = not known. */
  const preBalance = useRef<bigint | null>(null)
  const deadline = useRef<number>(0)
  const lastTx = useRef<string | null>(null)

  const highBalance = balance !== null && balance >= HIGH_BALANCE
  const busy = p === 'claiming' || p === 'verifying'

  // While verifying, watch for the real balance rise; periodically rescan; time out to "lagging".
  // The loop itself now lives in useBalanceSettle, shared with the conceal flow — behaviour here is
  // unchanged, it is only no longer the only copy of it.
  useBalanceSettle({
    active: p === 'verifying',
    balance,
    before: preBalance.current,
    deadlineAt: deadline.current,
    rescan,
    onSettled: (delta: bigint) => {
      setPhase('done')
      setMsg(`Added ${fmt(delta)} TARI. You can now send it, make it public, or register a name.`)
      setCooldown(true)
      // Was a cleanup-returning timeout inside the effect; a plain timer is equivalent here because
      // the cooldown is a one-shot that should survive this component's re-renders either way.
      setTimeout(() => setCooldown(false), 60_000)
    },
    onDeadline: () => {
      setPhase('lagging')
      setMsg(`Claim committed on-chain (tx ${shortTx(lastTx.current)}), but your balance hasn't updated yet. Tap Refresh in a moment.`)
    },
  })

  async function claim() {
    if (!wallet || !address) return
    // NOT `?? 0n`. This is a RISE watch, and zero is below any real balance — so an unknown
    // baseline would satisfy `balance > before` on the very first poll and report "Tokens
    // received" before the faucet's output had landed. That is not theoretical here: a claim is
    // the flow a brand-new wallet runs, and its first scan is often still in flight at this
    // moment. Unknown stays unknown; the loop then waits out the deadline and reports the lag
    // honestly. See useBalanceSettle's `before`.
    preBalance.current = balance
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
    setPhase('verifying')
    setMsg('Claim confirmed on-chain — updating your balance…')
    deadline.current = Date.now() + 150_000 // /utxos indexing can lag ~60-90s after the claim commits
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
