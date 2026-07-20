import { useState, useEffect } from 'react'
import { useWallet } from '../../context/WalletContext'
import DecryptPanel from './DecryptPanel'
import { sendConfidential, tariToMicrotari, MAX_FEE } from '../../crypto/confidentialSend'

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'send' | 'receive' | 'activity'
type SendStep = 'form' | 'review' | 'sending' | 'success' | 'error'
type SettingsStep = 'main' | 'phraseAuth' | 'phraseWords' | 'decrypt'

// ── Shared helpers ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.14em', marginBottom: 10 }}>
      {children}
    </div>
  )
}

function CopyBtn({ text, label = 'Copy', compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1800) }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: compact ? '5px 9px' : '7px 12px', borderRadius: 8,
        border: '1px solid rgba(45,224,198,0.28)',
        background: copied ? 'rgba(45,224,198,0.12)' : 'transparent',
        color: copied ? 'var(--acc,#2DE0C6)' : '#8A97B4',
        fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0,
      }}
    >
      {copied
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
        : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      }
      {copied ? 'Copied!' : label}
    </button>
  )
}

// ── QR placeholder (visual mock — wire qrcode.react when ready) ───────────────

function QrPlaceholder({ size = 192 }: { size?: number }) {
  const c = size / 21   // cell size for 21×21 grid
  function Finder({ ox, oy }: { ox: number; oy: number }) {
    return (
      <>
        <rect x={ox * c} y={oy * c} width={7 * c} height={7 * c} fill="#2DE0C6" rx={c * 0.35} />
        <rect x={(ox + 1) * c} y={(oy + 1) * c} width={5 * c} height={5 * c} fill="#0C111B" rx={c * 0.2} />
        <rect x={(ox + 2) * c} y={(oy + 2) * c} width={3 * c} height={3 * c} fill="#2DE0C6" rx={c * 0.15} />
      </>
    )
  }
  // Deterministic data cells — skip finder zones + timing row/col
  const cells: [number, number][] = []
  for (let r = 0; r < 21; r++) {
    for (let col = 0; col < 21; col++) {
      if (r < 8 && col < 8) continue
      if (r < 8 && col > 12) continue
      if (r > 12 && col < 8) continue
      if (r === 6 || col === 6) continue
      if ((r * 11 + col * 7 + r * col) % 3 === 0) cells.push([col, r])
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', borderRadius: 10 }}>
      <rect width={size} height={size} fill="#0C111B" />
      <Finder ox={0} oy={0} />
      <Finder ox={14} oy={0} />
      <Finder ox={0} oy={14} />
      {cells.map(([x, y], i) => (
        <rect key={i} x={x * c + c * 0.1} y={y * c + c * 0.1} width={c * 0.8} height={c * 0.8} fill="#2DE0C6" opacity="0.6" rx={c * 0.15} />
      ))}
    </svg>
  )
}

// ── Mock activity ─────────────────────────────────────────────────────────────

const ACTIVITY = [
  { id: 1, dir: 'sent' as const,     note: 'Splitting the villa booking', peer: 'JK', time: 'Today 14:32' },
  { id: 2, dir: 'received' as const, note: 'Dinner last night',           peer: 'MR', time: 'Yesterday 19:15' },
  { id: 3, dir: 'sent' as const,     note: 'Thanks for covering me',      peer: 'DN', time: 'Mon 11:00' },
]

function ActivityRow({ item }: { item: typeof ACTIVITY[0] }) {
  const sent = item.dir === 'sent'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid rgba(120,150,210,0.08)' }}>
      <div style={{
        width: 38, height: 38, borderRadius: 11, flexShrink: 0,
        background: sent ? 'rgba(255,107,107,0.08)' : 'rgba(45,224,198,0.08)',
        border: `1px solid ${sent ? 'rgba(255,107,107,0.2)' : 'rgba(45,224,198,0.2)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={sent ? '#FF8F8F' : 'var(--acc,#2DE0C6)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {sent
            ? <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            : <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>
          }
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#E4EAF4', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.note}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#55617D' }}>
          <span>{item.time}</span>
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#383E50', display: 'inline-block' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10 }}>amount hidden</span>
          </div>
        </div>
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end', marginBottom: 3 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D' }}>confirmed</span>
        </div>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 700, color: sent ? '#FF8F8F' : 'var(--acc,#2DE0C6)' }}>
          {sent ? '−' : '+'} ••••
        </span>
      </div>
    </div>
  )
}

// ── Gear icon ─────────────────────────────────────────────────────────────────

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function WalletModal({ onClose }: { onClose: () => void }) {
  const { wallet, address, scan, lock, getMnemonic, rescan } = useWallet()

  const [tab, setTab] = useState<Tab>('overview')
  const [inSettings, setInSettings] = useState(false)
  const [settingsStep, setSettingsStep] = useState<SettingsStep>('main')
  const [balanceHidden, setBalanceHidden] = useState(false)

  // phrase reveal
  const [phrasePass, setPhrasePass] = useState('')
  const [showPhrasePass, setShowPhrasePass] = useState(false)
  const [phraseError, setPhraseError] = useState('')
  const [phraseLoading, setPhraseLoading] = useState(false)
  const [words, setWords] = useState<string[] | null>(null)

  // send form
  const [sendRecipient, setSendRecipient] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [sendNote, setSendNote] = useState('')
  const [sendStep, setSendStep] = useState<SendStep>('form')
  const [sendValidationError, setSendValidationError] = useState('')
  const [sendProgress, setSendProgress] = useState('')
  const [sendTxId, setSendTxId] = useState('')
  const [sendError, setSendError] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { status, balance, progress, totalScanned, utxos, capped } = scan
  const tTARI = balance !== null ? (Number(balance) / 1_000_000).toFixed(6) : null
  const balanceDisplay = balanceHidden
    ? '••••••'
    : status === 'scanning' && tTARI === null ? '···'
    : tTARI ?? (status === 'done' ? '0.000000' : status === 'error' ? '?' : '—')

  const shortAddr = address ? address.slice(0, 20) + '…' + address.slice(-6) : null

  async function revealPhrase() {
    if (!phrasePass) return
    setPhraseError('')
    setPhraseLoading(true)
    try {
      const mnemonic = await getMnemonic(phrasePass)
      setWords(mnemonic.split(' '))
      setSettingsStep('phraseWords')
    } catch (e) {
      const isWrongPass = e instanceof DOMException && e.name === 'OperationError'
      setPhraseError(isWrongPass ? 'Incorrect password. Try again.' : `Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPhraseLoading(false)
    }
  }

  function backToSettingsMain() {
    setSettingsStep('main')
    setPhrasePass('')
    setPhraseError('')
    setWords(null)
    setShowPhrasePass(false)
  }

  function openSettings() { setInSettings(true); setSettingsStep('main') }
  function closeSettings() { setInSettings(false); backToSettingsMain() }

  function handleLock() { lock(); onClose() }

  function validateSendForm(): string | null {
    if (!wallet) return 'Wallet is locked — unlock before sending'
    if (!sendRecipient.startsWith('otl_esm_')) return 'Invalid address — must start with otl_esm_'
    const amountTari = parseFloat(sendAmount)
    if (!isFinite(amountTari) || amountTari <= 0) return 'Amount must be greater than 0'
    const amountMicrotari = tariToMicrotari(amountTari)
    if (balance !== null && amountMicrotari + MAX_FEE > balance) {
      const needed = (Number(amountMicrotari + MAX_FEE) / 1_000_000).toFixed(6)
      return `Insufficient balance — need ${needed} TARI (including ~0.01 TARI fee)`
    }
    return null
  }

  function handleReview() {
    const err = validateSendForm()
    if (err) { setSendValidationError(err); return }
    setSendValidationError('')
    setSendStep('review')
  }

  function resetSend() {
    setSendRecipient('')
    setSendAmount('')
    setSendNote('')
    setSendStep('form')
    setSendValidationError('')
    setSendProgress('')
    setSendTxId('')
    setSendError('')
  }

  async function handleConfirmSend() {
    if (!wallet || !address) return
    setSendStep('sending')
    setSendProgress('Connecting to indexer…')
    setSendTxId('')
    setSendError('')
    try {
      const result = await sendConfidential(wallet, address, {
        recipient: sendRecipient,
        amountMicrotari: tariToMicrotari(parseFloat(sendAmount)),
        memo: sendNote || undefined,
        onProgress: setSendProgress,
      })
      setSendTxId(result.txId)
      if (result.outcome === 'Commit') {
        setSendStep('success')
        rescan()
      } else {
        setSendError(
          result.outcome === 'Reject'
            ? 'Transaction was rejected on-chain.'
            : 'Not confirmed within 30s — it may still settle. Check the hash below.'
        )
        setSendStep('error')
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e))
      setSendStep('error')
    }
  }

  function tabStyle(t: Tab): React.CSSProperties {
    const active = !inSettings && tab === t
    return {
      flex: 1, padding: '11px 4px', background: 'none', border: 'none',
      borderBottom: `2px solid ${active ? 'var(--acc,#2DE0C6)' : 'transparent'}`,
      color: active ? 'var(--acc,#2DE0C6)' : '#55617D',
      fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer', transition: 'all 0.15s',
    }
  }

  const headerTitle = !inSettings ? 'Wallet'
    : settingsStep === 'phraseAuth' ? 'Confirm identity'
    : settingsStep === 'phraseWords' ? 'Recovery phrase'
    : settingsStep === 'decrypt' ? 'Decrypt UTXO'
    : 'Settings'

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,15,0.72)', backdropFilter: 'blur(4px)', zIndex: 200 }}
      />

      {/* Modal card */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: 'min(540px, 94vw)', maxHeight: '88vh',
        background: '#0C111B', borderRadius: 20,
        border: '1px solid rgba(120,150,210,0.2)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(45,224,198,0.06)',
        zIndex: 201, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 22px 14px', borderBottom: '1px solid rgba(120,150,210,0.1)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {inSettings && settingsStep !== 'main' && (
              <button
                onClick={backToSettingsMain}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(120,150,210,0.16)', background: 'none', cursor: 'pointer', marginRight: 2 }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
              </button>
            )}
            <svg viewBox="0 0 44 44" width="24" height="24" aria-hidden="true">
              <defs>
                <linearGradient id="wmGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#5CEAD6" />
                  <stop offset="1" stopColor="#12A594" />
                </linearGradient>
              </defs>
              <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill="url(#wmGrad)" />
              <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="#2DE0C6" opacity="0.45" />
              <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="#2DE0C6" />
            </svg>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#F2F5FB' }}>{headerTitle}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {inSettings ? (
              <button
                onClick={closeSettings}
                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(120,150,210,0.16)', background: 'none', cursor: 'pointer', color: '#8A97B4', fontSize: 12, fontWeight: 500 }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
                Wallet
              </button>
            ) : (
              <button
                onClick={openSettings}
                title="Settings"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, border: '1px solid rgba(120,150,210,0.16)', background: 'none', cursor: 'pointer' }}
              >
                <GearIcon />
              </button>
            )}
            <button
              onClick={onClose}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, border: '1px solid rgba(120,150,210,0.16)', background: 'none', cursor: 'pointer' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* ── Tab bar (hidden in settings) ─────────────────────────────── */}
        {!inSettings && (
          <div style={{ display: 'flex', padding: '0 22px', borderBottom: '1px solid rgba(120,150,210,0.1)', flexShrink: 0 }}>
            {(['overview', 'send', 'receive', 'activity'] as Tab[]).map(t => (
              <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        )}

        {/* ── Scrollable content ────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: settingsStep === 'decrypt' && inSettings ? '0' : '24px 22px 28px' }}>

          {/* ════════════════════════ SETTINGS ══════════════════════════ */}

          {inSettings && settingsStep === 'main' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Recovery phrase */}
              <button
                onClick={() => setSettingsStep('phraseAuth')}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(120,150,210,0.05)', border: '1px solid rgba(120,150,210,0.14)', cursor: 'pointer', textAlign: 'left', width: '100%' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, background: 'rgba(45,224,198,0.08)', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></svg>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#E4EAF4' }}>Show recovery phrase</div>
                  <div style={{ fontSize: 12, color: '#55617D', marginTop: 2 }}>Re-enter your password to reveal your 24 words</div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              </button>

              {/* Decrypt UTXO dev panel */}
              <button
                onClick={() => setSettingsStep('decrypt')}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(120,150,210,0.05)', border: '1px solid rgba(120,150,210,0.14)', cursor: 'pointer', textAlign: 'left', width: '100%' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, background: 'rgba(45,224,198,0.08)', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></svg>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#E4EAF4' }}>Decrypt UTXO <span style={{ fontSize: 11, color: '#55617D', fontWeight: 400 }}>· dev</span></div>
                  <div style={{ fontSize: 12, color: '#55617D', marginTop: 2 }}>Paste a UTXO substate ID to reveal amount + memo</div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              </button>

              {/* Lock */}
              <button
                onClick={handleLock}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(255,107,107,0.04)', border: '1px solid rgba(255,107,107,0.18)', cursor: 'pointer', textAlign: 'left', width: '100%', marginTop: 8 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, background: 'rgba(255,107,107,0.08)', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#FF8F8F' }}>Lock wallet</div>
                  <div style={{ fontSize: 12, color: '#55617D', marginTop: 2 }}>Clear session — you'll need your password to unlock</div>
                </div>
              </button>
            </div>
          )}

          {inSettings && settingsStep === 'phraseAuth' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: 14, borderRadius: 12, background: 'rgba(255,180,60,0.06)', border: '1px solid rgba(255,180,60,0.3)' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#FFB43C" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                <div style={{ fontSize: 13, lineHeight: 1.5, color: '#C7D0E4' }}>
                  Your 24-word recovery phrase is the master key to your wallet. Never share it with anyone.
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: '#8A97B4', marginBottom: 8 }}>Enter your password to continue</div>
                <div style={{ display: 'flex', alignItems: 'center', padding: '13px 15px', borderRadius: 11, background: '#10151F', border: `1px solid ${phrasePass ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`, transition: 'border-color 0.15s' }}>
                  <input
                    type={showPhrasePass ? 'text' : 'password'}
                    value={phrasePass}
                    autoFocus
                    onChange={e => { setPhrasePass(e.target.value); setPhraseError('') }}
                    onKeyDown={e => { if (e.key === 'Enter' && phrasePass) revealPhrase() }}
                    placeholder="Password"
                    style={{ background: 'none', border: 'none', outline: 'none', fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: '#E4EAF4', flex: 1 }}
                  />
                  <svg onClick={() => setShowPhrasePass(v => !v)} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ cursor: 'pointer', flexShrink: 0 }}>
                    {showPhrasePass
                      ? <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>
                      : <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></>
                    }
                  </svg>
                </div>
              </div>
              {phraseError && (
                <div style={{ fontSize: 13, color: '#FF6B6B', padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>
                  {phraseError}
                </div>
              )}
              <button
                onClick={revealPhrase}
                disabled={!phrasePass || phraseLoading}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 15, borderRadius: 12,
                  width: '100%', border: 'none', fontSize: 15, fontWeight: 700,
                  cursor: phrasePass && !phraseLoading ? 'pointer' : 'default',
                  background: phrasePass && !phraseLoading ? 'linear-gradient(180deg, #34E5D0, #12A594)' : 'rgba(120,150,210,0.15)',
                  color: phrasePass && !phraseLoading ? '#04120F' : '#55617D',
                  transition: 'all 0.15s',
                }}
              >
                {phraseLoading ? 'Verifying…' : 'Reveal phrase'}
              </button>
            </div>
          )}

          {inSettings && settingsStep === 'phraseWords' && words && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <p style={{ margin: 0, fontSize: 13, color: '#8A97B4', lineHeight: 1.5 }}>Write these down in order. They are the only way to recover your wallet.</p>
                <CopyBtn text={words.join(' ')} label="Copy all" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7 }}>
                {words.map((word, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 10px', borderRadius: 9, background: '#10151F', border: '1px solid rgba(120,150,210,0.12)', userSelect: 'all' }}>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', flexShrink: 0, minWidth: 16 }}>{i + 1}</span>
                    <span style={{ fontSize: 12, color: '#E4EAF4', fontWeight: 500 }}>{word}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: 14, borderRadius: 12, background: 'rgba(255,180,60,0.06)', border: '1px solid rgba(255,180,60,0.25)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFB43C" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                <span style={{ fontSize: 12, color: '#C7D0E4', lineHeight: 1.5 }}>Never enter these words anywhere except Caravel. Caravel will never ask for them via chat, email, or support.</span>
              </div>
              <button onClick={backToSettingsMain} style={{ padding: '13px 20px', borderRadius: 12, border: '1px solid rgba(120,150,210,0.2)', background: 'none', color: '#8A97B4', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Done
              </button>
            </div>
          )}

          {inSettings && settingsStep === 'decrypt' && <DecryptPanel />}

          {/* ════════════════════════ OVERVIEW ══════════════════════════ */}

          {!inSettings && tab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

              {/* Balance card */}
              <div style={{ padding: '20px 22px', borderRadius: 16, background: 'linear-gradient(140deg, rgba(45,224,198,0.1), rgba(18,165,148,0.03))', border: '1px solid rgba(45,224,198,0.22)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <SectionLabel>CONFIDENTIAL BALANCE</SectionLabel>
                  <button
                    onClick={() => setBalanceHidden(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: '#5E8A82', padding: 0, fontSize: 11, fontWeight: 500 }}
                  >
                    {balanceHidden
                      ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></svg>
                      : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
                    }
                    {balanceHidden ? 'Show' : 'Hide'}
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 36, fontWeight: 700, color: '#EAFBF7', letterSpacing: '0.03em', lineHeight: 1 }}>
                    {balanceDisplay}
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--acc,#2DE0C6)' }}>TARI</span>
                </div>
                {status === 'scanning' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#55617D' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    Scanning… {progress.scanned} UTXOs, {progress.found} found
                  </div>
                )}
                {status === 'done' && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#55617D' }}>
                      {totalScanned} UTXOs scanned · {utxos.length} owned{capped && <span style={{ color: '#FFB43C', marginLeft: 5 }}>(capped)</span>}
                    </span>
                    <button onClick={rescan} style={{ background: 'none', border: 'none', color: 'var(--acc,#2DE0C6)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>Refresh</button>
                  </div>
                )}
                {status === 'error' && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#FF6B6B' }}>Scan failed</span>
                    <button onClick={rescan} style={{ background: 'none', border: 'none', color: 'var(--acc,#2DE0C6)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>Retry</button>
                  </div>
                )}
              </div>

              {/* Address */}
              {shortAddr && (
                <div>
                  <SectionLabel>WALLET ADDRESS</SectionLabel>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)' }}>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#C7D0E4', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortAddr}
                    </span>
                    {address && <CopyBtn text={address} compact />}
                  </div>
                </div>
              )}

              {/* Network badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10, background: 'rgba(120,150,210,0.05)', border: '1px solid rgba(120,150,210,0.1)', alignSelf: 'flex-start' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--acc,#2DE0C6)', display: 'inline-block', flexShrink: 0 }} />
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#8A97B4' }}>Esmeralda testnet</span>
              </div>

              {/* Send / Receive */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <button
                  onClick={() => setTab('send')}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    padding: '14px', borderRadius: 13,
                    background: 'linear-gradient(180deg, #34E5D0, #12A594)',
                    border: 'none', color: '#04120F', fontSize: 15, fontWeight: 700, cursor: 'pointer',
                    boxShadow: '0 0 22px rgba(45,224,198,0.22)',
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
                  Send
                </button>
                <button
                  onClick={() => setTab('receive')}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    padding: '14px', borderRadius: 13,
                    background: 'rgba(45,224,198,0.1)', border: '1px solid rgba(45,224,198,0.35)',
                    color: 'var(--acc,#2DE0C6)', fontSize: 15, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M19 9l-7 7-7-7" /></svg>
                  Receive
                </button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════ SEND ═══════════════════════════ */}

          {!inSettings && tab === 'send' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* ── form ── */}
              {sendStep === 'form' && (
                <>
                  <div>
                    <SectionLabel>RECIPIENT ADDRESS</SectionLabel>
                    <input
                      value={sendRecipient}
                      onChange={e => { setSendRecipient(e.target.value); setSendValidationError('') }}
                      placeholder="otl_esm_…"
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        padding: '13px 15px', borderRadius: 11,
                        background: '#10151F',
                        border: `1px solid ${sendRecipient ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`,
                        fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#E4EAF4',
                        outline: 'none', transition: 'border-color 0.15s',
                      }}
                      spellCheck={false}
                    />
                  </div>

                  <div>
                    <SectionLabel>AMOUNT</SectionLabel>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '11px 15px', borderRadius: 11, background: '#10151F',
                      border: `1px solid ${sendAmount ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`,
                      transition: 'border-color 0.15s',
                    }}>
                      <input
                        type="number" min="0" value={sendAmount}
                        onChange={e => { setSendAmount(e.target.value); setSendValidationError('') }}
                        placeholder="0.000000"
                        style={{ background: 'none', border: 'none', outline: 'none', fontFamily: "'IBM Plex Mono', monospace", fontSize: 20, color: '#E4EAF4', flex: 1, fontWeight: 600 }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--acc,#2DE0C6)', flexShrink: 0 }}>TARI</span>
                    </div>
                  </div>

                  <div>
                    <SectionLabel>PRIVATE NOTE (OPTIONAL)</SectionLabel>
                    <textarea
                      value={sendNote}
                      onChange={e => setSendNote(e.target.value)}
                      placeholder="Only visible to you and the recipient…"
                      rows={3}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        padding: '12px 15px', borderRadius: 11, background: '#10151F',
                        border: `1px solid ${sendNote ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`,
                        fontSize: 13, color: '#E4EAF4', resize: 'vertical', outline: 'none', lineHeight: 1.5,
                        transition: 'border-color 0.15s',
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 14px', borderRadius: 10, background: 'rgba(45,224,198,0.05)', border: '1px solid rgba(45,224,198,0.18)' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <span style={{ fontSize: 12, color: '#6BA69A', lineHeight: 1.5 }}>
                      Amount and note are hidden on-chain. Only you and the recipient can see them.
                    </span>
                  </div>

                  {sendValidationError && (
                    <div style={{ fontSize: 13, color: '#FF6B6B', padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>
                      {sendValidationError}
                    </div>
                  )}

                  <button
                    onClick={handleReview}
                    disabled={!sendRecipient || !sendAmount}
                    style={{
                      padding: '15px', borderRadius: 13, border: 'none',
                      background: sendRecipient && sendAmount ? 'linear-gradient(180deg, #34E5D0, #12A594)' : 'rgba(120,150,210,0.15)',
                      color: sendRecipient && sendAmount ? '#04120F' : '#55617D',
                      fontSize: 15, fontWeight: 700,
                      cursor: sendRecipient && sendAmount ? 'pointer' : 'default',
                      transition: 'all 0.15s',
                    }}
                  >
                    Review
                  </button>
                </>
              )}

              {/* ── review ── */}
              {sendStep === 'review' && (
                <>
                  <div style={{ padding: '18px', borderRadius: 14, background: '#10151F', border: '1px solid rgba(120,150,210,0.16)', display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.14em' }}>REVIEW TRANSACTION</div>
                    {[
                      { label: 'To',     value: sendRecipient.length > 30 ? sendRecipient.slice(0, 22) + '…' + sendRecipient.slice(-6) : sendRecipient },
                      { label: 'Amount', value: `${sendAmount} TARI` },
                      { label: 'Fee',    value: '≤ 0.000010 TARI' },
                      ...(sendNote ? [{ label: 'Note', value: `"${sendNote}"` }] : []),
                    ].map(({ label, value }) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                        <span style={{ fontSize: 13, color: '#55617D', flexShrink: 0 }}>{label}</span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: '#C7D0E4', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      onClick={() => setSendStep('form')}
                      style={{ flex: 1, padding: '13px', borderRadius: 12, border: '1px solid rgba(120,150,210,0.2)', background: 'none', color: '#8A97B4', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Back
                    </button>
                    <button
                      onClick={handleConfirmSend}
                      style={{ flex: 2, padding: '13px', borderRadius: 12, border: 'none', background: 'linear-gradient(180deg, #34E5D0, #12A594)', color: '#04120F', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
                    >
                      Confirm Send
                    </button>
                  </div>
                </>
              )}

              {/* ── sending ── */}
              {sendStep === 'sending' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '28px 0' }}>
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="1.8" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#E4EAF4', marginBottom: 8 }}>Sending…</div>
                    <div style={{ fontSize: 13, color: '#55617D', lineHeight: 1.6 }}>{sendProgress}</div>
                  </div>
                </div>
              )}

              {/* ── success ── */}
              {sendStep === 'success' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '20px 0 8px' }}>
                    <div style={{ width: 52, height: 52, borderRadius: 16, background: 'rgba(45,224,198,0.12)', border: '1px solid rgba(45,224,198,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 17, fontWeight: 700, color: '#E4EAF4', marginBottom: 4 }}>Sent!</div>
                      <div style={{ fontSize: 13, color: '#55617D' }}>Transaction confirmed on-chain</div>
                    </div>
                  </div>

                  {sendTxId && (
                    <div>
                      <SectionLabel>TRANSACTION HASH</SectionLabel>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)' }}>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#C7D0E4', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {sendTxId}
                        </span>
                        <CopyBtn text={sendTxId} compact />
                      </div>
                    </div>
                  )}

                  <button
                    onClick={resetSend}
                    style={{ padding: '13px', borderRadius: 12, border: '1px solid rgba(45,224,198,0.3)', background: 'rgba(45,224,198,0.08)', color: 'var(--acc,#2DE0C6)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
                  >
                    New payment
                  </button>
                </div>
              )}

              {/* ── error ── */}
              {sendStep === 'error' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '16px 0 8px' }}>
                    <div style={{ width: 52, height: 52, borderRadius: 16, background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#FF8F8F' }}>Send failed</div>
                  </div>

                  <div style={{ padding: '13px 14px', borderRadius: 12, background: 'rgba(255,107,107,0.06)', border: '1px solid rgba(255,107,107,0.2)', fontSize: 13, color: '#FF8F8F', lineHeight: 1.6, wordBreak: 'break-word' }}>
                    {sendError}
                  </div>

                  {sendTxId && (
                    <div>
                      <SectionLabel>TRANSACTION HASH</SectionLabel>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)' }}>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#C7D0E4', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {sendTxId}
                        </span>
                        <CopyBtn text={sendTxId} compact />
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      onClick={resetSend}
                      style={{ flex: 1, padding: '13px', borderRadius: 12, border: '1px solid rgba(120,150,210,0.2)', background: 'none', color: '#8A97B4', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Start over
                    </button>
                    <button
                      onClick={() => { setSendStep('review'); setSendError('') }}
                      style={{ flex: 1, padding: '13px', borderRadius: 12, border: 'none', background: 'rgba(120,150,210,0.15)', color: '#C7D0E4', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* ══════════════════════════ RECEIVE ═════════════════════════ */}

          {!inSettings && tab === 'receive' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22, alignItems: 'center' }}>
              <div style={{ fontSize: 13, color: '#8A97B4', textAlign: 'center', maxWidth: 360, lineHeight: 1.6 }}>
                Share your address to receive confidential TARI. Amounts stay hidden on-chain.
              </div>

              <div style={{ padding: 16, borderRadius: 16, background: '#10151F', border: '1px solid rgba(120,150,210,0.18)', display: 'inline-block' }}>
                <QrPlaceholder size={192} />
              </div>

              {address && (
                <div style={{ width: '100%' }}>
                  <SectionLabel>YOUR ADDRESS</SectionLabel>
                  <div style={{ padding: '13px 15px', borderRadius: 12, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#C7D0E4', wordBreak: 'break-all', lineHeight: 1.7 }}>
                      {address}
                    </span>
                    <CopyBtn text={address} label="Copy address" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════ ACTIVITY ════════════════════════ */}

          {!inSettings && tab === 'activity' && (
            <div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {ACTIVITY.map(item => <ActivityRow key={item.id} item={item} />)}
              </div>
              <div style={{ marginTop: 24, padding: '13px 16px', borderRadius: 12, background: 'rgba(120,150,210,0.04)', border: '1px solid rgba(120,150,210,0.1)', textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#55617D', lineHeight: 1.6 }}>
                  Placeholder entries — real activity tracking wired in next step.
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  )
}
