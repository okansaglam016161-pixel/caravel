//   "Claim testnet tokens" action. Lets a new (empty) self-custodial wallet fund itself from the
//   public esmeralda faucet — self-signed in-browser, no daemon. Never shows success until the
//   balance actually rises (poll tx → Commit, then rescan and confirm the real increase). Light
//   anti-spam guardrails: brief cooldown after a claim, and a soft note when the balance is already
//   high. Testnet-only framing — these tokens have no value.

import { useState, useEffect, useRef } from 'react'
import { useWallet } from '../../context/WalletContext'
import { claimFaucet, type ClaimResult } from '../../crypto/faucet'

type Phase = 'idle' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error'

const HIGH_BALANCE = 100_000_000n // 100 tTARI — "you already have plenty"
const fmt = (µt: bigint) => (Number(µt) / 1_000_000).toFixed(2)
const shortTx = (t: string | null) => (t ? `${t.slice(0, 8)}…${t.slice(-6)}` : '')

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
  useEffect(() => {
    if (phase !== 'verifying') return
    if (balance !== null && balance > preBalance.current) {
      setPhase('done')
      setMsg(`Added ${fmt(balance - preBalance.current)} tTARI. You can now send and register a name.`)
      setCooldown(true)
      const t = setTimeout(() => setCooldown(false), 60_000)
      return () => clearTimeout(t)
    }
    const iv = setInterval(() => {
      if (Date.now() > deadline.current) {
        setPhase('lagging')
        setMsg(`Claim committed on-chain (tx ${shortTx(lastTx.current)}), but your balance hasn't updated yet. Tap Refresh in a moment.`)
      } else {
        rescan()
      }
    }, 8_000)
    return () => clearInterval(iv)
  }, [phase, balance, rescan])

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

  const msgColor = phase === 'error' ? '#FF6B6B' : phase === 'done' ? '#34E5D0' : '#8A97B4'

  return (
    <div style={{ border: '1px solid rgba(120,150,210,0.18)', borderRadius: 12, padding: 16, background: '#10151F' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#F2F5FB' }}>Claim testnet tokens</div>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: '#F5B301', background: 'rgba(245,179,1,0.12)', border: '1px solid rgba(245,179,1,0.35)', borderRadius: 5, padding: '2px 6px' }}>TESTNET</span>
      </div>
      <div style={{ fontSize: 12.5, color: '#8A97B4', lineHeight: 1.5, marginBottom: 12 }}>
        Get free test tTARI so you can send payments and register an ONS name. These are testnet tokens
        with <strong style={{ color: '#B9C4DC' }}>no real value</strong>. Signed in your browser — no daemon needed.
      </div>

      {highBalance && phase === 'idle' && (
        <div style={{ fontSize: 12, color: '#8A97B4', marginBottom: 10, fontFamily: "'IBM Plex Mono', monospace" }}>
          You already have plenty of test tokens ({fmt(balance!)} tTARI).
        </div>
      )}

      {msg && (
        <div style={{ marginBottom: 12, fontSize: 12, color: msgColor, fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.5, wordBreak: 'break-word' }}>
          {msg}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={claim}
          disabled={!canClaim}
          style={{
            padding: '10px 18px', borderRadius: 9, border: 'none',
            background: !canClaim ? 'rgba(120,150,210,0.12)' : highBalance ? 'rgba(45,224,198,0.14)' : 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))',
            color: !canClaim ? '#55617D' : highBalance ? 'var(--acc,#2DE0C6)' : 'var(--accOn,#04120F)',
            fontSize: 13, fontWeight: 700, cursor: canClaim ? 'pointer' : 'default', fontFamily: 'inherit',
          }}
        >
          {phase === 'claiming' ? 'Claiming…' : phase === 'verifying' ? 'Verifying…' : cooldown ? 'Claimed ✓' : 'Claim test tokens'}
        </button>
        {phase === 'lagging' && (
          <button
            onClick={() => rescan()}
            style={{ padding: '10px 16px', borderRadius: 9, border: '1px solid rgba(120,150,210,0.25)', background: 'transparent', color: '#B9C4DC', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Refresh
          </button>
        )}
      </div>

      {!wallet && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: '#55617D' }}>Unlock your wallet to claim.</div>
      )}
    </div>
  )
}
