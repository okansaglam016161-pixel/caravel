//   "Claim testnet tokens" — presentation transcribed element-for-element from the design file's
//   "Overview · faucet panel" (8 states). All logic (phase, claim, verify-effect, cooldown,
//   deadline, HIGH_BALANCE, refs) is preserved verbatim; only the JSX mirrors the design markup.

import { useState, useRef } from 'react'
import { useWallet } from '../../context/WalletContext'
import { claimFaucet, type ClaimResult } from '../../crypto/faucet'
import { saveAccountAddress } from '../../crypto/accountStore'
import { useBalanceSettle } from './useBalanceSettle'

type Phase = 'idle' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error'

const HIGH_BALANCE = 100_000_000n // 100 tTARI — "you already have plenty"
const fmt = (µt: bigint) => (Number(µt) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const shortTx = (t: string | null) => (t ? `${t.slice(0, 8)}…${t.slice(-6)}` : '')

// Design tokens (hex → var) used across the states.
const CARD = { padding: 18, borderRadius: 14 } as const
const TITLE = { fontSize: 14, fontWeight: 700 } as const
const DESC = { fontSize: 13, color: 'var(--text-muted-dim)', marginBottom: 14, lineHeight: 1.5 } as const
const BTN = { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, borderRadius: 11, fontSize: 14, fontWeight: 700 } as const

export default function FaucetClaimPanel() {
  const { wallet, address, scan, rescan } = useWallet()
  const balance = scan.balance
  const [phase, setPhase] = useState<Phase>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(false)
  const preBalance = useRef<bigint>(0n)
  const deadline = useRef<number>(0)
  const lastTx = useRef<string | null>(null)

  const highBalance = balance !== null && balance >= HIGH_BALANCE
  const busy = phase === 'claiming' || phase === 'verifying'
  const canClaim = !!wallet && !!address && !busy && !cooldown

  // While verifying, watch for the real balance rise; periodically rescan; time out to "lagging".
  // The loop itself now lives in useBalanceSettle, shared with the conceal flow — behaviour here is
  // unchanged, it is only no longer the only copy of it.
  useBalanceSettle({
    active: phase === 'verifying',
    balance,
    before: preBalance.current,
    deadlineAt: deadline.current,
    rescan,
    onRose: (delta) => {
      setPhase('done')
      setMsg(`Added ${fmt(delta)} tTARI. You can now send and register a name.`)
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
    preBalance.current = balance ?? 0n
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

  const spinner = (dur: string) => (
    <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: `cv-spin ${dur} linear infinite` }} />
  )
  // Design "+1,000 TARI" header amount; real claim grants ~1,000 tTARI.
  const grant = '+1,000 TARI'

  // ── DONE (design DONE card: check circle + "…received" + updated + disabled Claimed ✓) ──
  if (phase === 'done') {
    return (
      <div style={{ ...CARD, background: 'rgba(var(--teal-500-rgb),0.05)', border: '1px solid rgba(var(--teal-500-rgb),0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: 'rgba(var(--teal-500-rgb),0.16)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          </span>
          <span style={{ ...TITLE, color: 'var(--text-bright)' }}>Tokens received</span>
        </div>
        <div style={{ ...DESC, color: 'var(--text-teal-label)' }}>{msg ?? 'Your balance has been updated.'}</div>
        <div style={{ ...BTN, background: 'rgba(16,21,31,0.6)', border: '1px solid rgba(var(--border-rgb),0.12)', color: 'var(--text-faint-dim)' }}>Claimed ✓</div>
      </div>
    )
  }

  // ── LAGGING (amber pulse dot + refresh) ──
  if (phase === 'lagging') {
    return (
      <div style={{ ...CARD, background: 'var(--surface-raised)', border: '1px solid rgba(var(--warn-rgb),0.28)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--warn)', animation: 'cv-pulse 1.6s ease-in-out infinite' }} />
          <span style={{ ...TITLE, color: 'var(--text-primary)' }}>Funds sent, not visible yet</span>
        </div>
        <div style={DESC}>The faucet confirmed, but your scan has not picked it up. This can take a minute.</div>
        <div onClick={() => rescan()} style={{ ...BTN, gap: 8, background: 'var(--surface-inset)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', cursor: 'pointer' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>Refresh balance
        </div>
      </div>
    )
  }

  // ── ERROR (red circle-alert) ──
  if (phase === 'error') {
    return (
      <div style={{ ...CARD, background: 'rgba(var(--danger-rgb),0.04)', border: '1px solid rgba(var(--danger-rgb),0.28)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
          <span style={{ ...TITLE, color: 'var(--danger-300)' }}>Faucet unavailable</span>
        </div>
        <div style={DESC}>{msg ?? 'The faucet did not respond. Nothing was claimed.'}</div>
        <div onClick={claim} style={{ ...BTN, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', color: 'var(--danger-300)', cursor: 'pointer' }}>Try again</div>
      </div>
    )
  }

  // ── COOLDOWN (grey, "Claimed ✓" disabled) ──
  if (cooldown) {
    return (
      <div style={{ ...CARD, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ ...TITLE, color: 'var(--text-muted)' }}>Testnet faucet</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-faint-dim)' }}>just claimed</span>
        </div>
        <div style={{ ...DESC, color: 'var(--text-faint)' }}>{msg ?? 'You have already claimed. Try again shortly.'}</div>
        <div style={{ ...BTN, background: 'rgba(16,21,31,0.6)', border: '1px solid rgba(var(--border-rgb),0.12)', color: 'var(--text-disabled)' }}>Claimed ✓</div>
      </div>
    )
  }

  // ── CLAIMING / VERIFYING (teal border, spinner button) ──
  if (busy) {
    return (
      <div style={{ ...CARD, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ ...TITLE, color: 'var(--text-primary)' }}>Testnet faucet</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--teal-300)' }}>{grant}</span>
        </div>
        <div style={DESC}>{phase === 'claiming' ? 'Requesting funds from the faucet.' : 'Waiting for the output to appear on chain.'}</div>
        <div style={{ ...BTN, gap: 9, background: 'var(--surface-inset)', border: '1px solid rgba(var(--teal-500-rgb),0.2)', color: 'var(--teal-300)' }}>
          {spinner(phase === 'claiming' ? '0.8s' : '1.1s')}{phase === 'claiming' ? 'Claiming…' : 'Verifying…'}
        </div>
      </div>
    )
  }

  // ── HIGH BALANCE (grey, "balance X") ──
  if (highBalance) {
    return (
      <div style={{ ...CARD, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ ...TITLE, color: 'var(--text-muted)' }}>Testnet faucet</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-faint-dim)' }}>balance {fmt(balance!)}</span>
        </div>
        <div style={{ ...DESC, color: 'var(--text-faint)' }}>You already have plenty. Leave the rest for other testers.</div>
        <div onClick={canClaim ? claim : undefined} style={{ ...BTN, background: 'rgba(16,21,31,0.6)', border: '1px solid rgba(var(--border-rgb),0.12)', color: 'var(--text-disabled)', cursor: canClaim ? 'pointer' : 'default' }}>Claim funds</div>
      </div>
    )
  }

  // ── IDLE (default) ──
  return (
    <div style={{ ...CARD, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ ...TITLE, color: 'var(--text-primary)' }}>Testnet faucet</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--teal-300)' }}>{grant}</span>
      </div>
      <div style={DESC}>Free Esmeralda funds, signed in your browser. {!wallet && 'Unlock your wallet to claim.'}</div>
      <div onClick={canClaim ? claim : undefined} style={{ ...BTN, background: canClaim ? 'var(--teal-grad)' : 'rgba(16,21,31,0.6)', border: canClaim ? 'none' : '1px solid rgba(var(--border-rgb),0.12)', color: canClaim ? 'var(--ink-on-accent)' : 'var(--text-disabled)', cursor: canClaim ? 'pointer' : 'default' }}>Claim funds</div>
    </div>
  )
}
