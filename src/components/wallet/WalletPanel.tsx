import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <button
      onClick={copy}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '6px 11px', borderRadius: 8, border: '1px solid rgba(45,224,198,0.28)',
        background: copied ? 'rgba(45,224,198,0.12)' : 'transparent',
        color: copied ? 'var(--acc,#2DE0C6)' : '#8A97B4',
        fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0,
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 7l-8 8-4-4" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {copied ? 'Copied!' : label}
    </button>
  )
}

// ── Section heading ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.14em', marginBottom: 10 }}>
      {children}
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

type PanelView = 'main' | 'phraseAuth' | 'phraseWords'

export default function WalletPanel({ onClose }: { onClose: () => void }) {
  const { address, lock, getMnemonic } = useWallet()

  const [view, setView] = useState<PanelView>('main')
  const [phrasePass, setPhrasePass] = useState('')
  const [showPhrasePass, setShowPhrasePass] = useState(false)
  const [phraseError, setPhraseError] = useState('')
  const [phraseLoading, setPhraseLoading] = useState(false)
  const [words, setWords] = useState<string[] | null>(null)
  const [showFullAddr, setShowFullAddr] = useState(false)

  const shortAddr = address
    ? address.slice(0, 18) + '…' + address.slice(-6)
    : null

  async function revealPhrase() {
    if (!phrasePass) return
    setPhraseError('')
    setPhraseLoading(true)
    try {
      const mnemonic = await getMnemonic(phrasePass)
      setWords(mnemonic.split(' '))
      setView('phraseWords')
    } catch (e) {
      const isWrongPass = e instanceof DOMException && e.name === 'OperationError'
      setPhraseError(isWrongPass ? 'Incorrect password. Try again.' : `Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPhraseLoading(false)
    }
  }

  function handleLock() {
    lock()
    onClose()
  }

  function backToMain() {
    setView('main')
    setPhrasePass('')
    setPhraseError('')
    setWords(null)
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,15,0.55)', backdropFilter: 'blur(3px)', zIndex: 200 }}
      />

      {/* Drawer */}
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 420,
        background: '#0C111B', borderLeft: '1px solid rgba(120,150,210,0.18)',
        zIndex: 201, display: 'flex', flexDirection: 'column', overflowY: 'auto',
      }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 18px', borderBottom: '1px solid rgba(120,150,210,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {view !== 'main' && (
              <button
                onClick={backToMain}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(120,150,210,0.16)', background: 'none', cursor: 'pointer', marginRight: 4 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 5l-7 7 7 7" />
                </svg>
              </button>
            )}
            <svg viewBox="0 0 44 44" width="26" height="26" aria-hidden="true">
              <defs>
                <linearGradient id="wpSail" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="var(--accL,#5CEAD6)" />
                  <stop offset="1" stopColor="var(--accD,#12A594)" />
                </linearGradient>
              </defs>
              <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill="url(#wpSail)" />
              <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="var(--acc,#2DE0C6)" opacity="0.45" />
              <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="var(--acc,#2DE0C6)" />
            </svg>
            <span style={{ fontSize: 17, fontWeight: 700, color: '#F2F5FB' }}>
              {view === 'phraseAuth' ? 'Confirm identity' : view === 'phraseWords' ? 'Recovery phrase' : 'Wallet'}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, border: '1px solid rgba(120,150,210,0.16)', background: 'none', cursor: 'pointer' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── Main view ────────────────────────────────────────────────────── */}
        {view === 'main' && (
          <div style={{ padding: '24px 24px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* Balance */}
            <div>
              <SectionLabel>BALANCE</SectionLabel>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '18px 20px', borderRadius: 14, background: 'linear-gradient(140deg, rgba(45,224,198,0.08), rgba(18,165,148,0.03))', border: '1px solid rgba(45,224,198,0.2)' }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 30, fontWeight: 600, color: '#EAFBF7', letterSpacing: '0.04em' }}>—</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--acc,#2DE0C6)' }}>TARI</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: '#55617D', lineHeight: 1.5 }}>
                Balance requires querying the Esmeralda indexer substate for this account. See notes below.
              </div>
            </div>

            {/* Address */}
            <div>
              <SectionLabel>WALLET ADDRESS</SectionLabel>
              <div style={{ padding: '14px 16px', borderRadius: 12, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)' }}>
                {/* Truncated row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: showFullAddr ? 12 : 0 }}>
                  <span
                    style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: '#C7D0E4', wordBreak: 'break-all', flex: 1 }}
                    title={address ?? ''}
                  >
                    {showFullAddr ? address : shortAddr}
                  </span>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {address && <CopyBtn text={address} />}
                  </div>
                </div>
                {/* Toggle */}
                <button
                  onClick={() => setShowFullAddr(v => !v)}
                  style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--acc,#2DE0C6)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}
                >
                  {showFullAddr ? 'Show less' : 'View full address'}
                </button>
              </div>
            </div>

            {/* Network */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: 'rgba(120,150,210,0.05)', border: '1px solid rgba(120,150,210,0.1)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--acc,#2DE0C6)', flexShrink: 0, display: 'inline-block' }} />
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: '#8A97B4' }}>Esmeralda testnet</span>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={() => setView('phraseAuth')}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(120,150,210,0.05)', border: '1px solid rgba(120,150,210,0.14)', cursor: 'pointer', textAlign: 'left', width: '100%' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, background: 'rgba(45,224,198,0.08)', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#E4EAF4' }}>Show recovery phrase</div>
                  <div style={{ fontSize: 12, color: '#55617D', marginTop: 2 }}>Re-enter your password to reveal your 24 words</div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>

              <button
                onClick={handleLock}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(255,107,107,0.04)', border: '1px solid rgba(255,107,107,0.18)', cursor: 'pointer', textAlign: 'left', width: '100%' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, background: 'rgba(255,107,107,0.08)', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#FF8F8F' }}>Lock wallet</div>
                  <div style={{ fontSize: 12, color: '#55617D', marginTop: 2 }}>Clear session — you'll need your password to unlock</div>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* ── Phrase auth view ──────────────────────────────────────────────── */}
        {view === 'phraseAuth' && (
          <div style={{ padding: '28px 24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: 15, borderRadius: 12, background: 'rgba(255,180,60,0.06)', border: '1px solid rgba(255,180,60,0.3)' }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#FFB43C" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" />
              </svg>
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
                width: '100%', border: 'none', fontSize: 15, fontWeight: 700, cursor: phrasePass && !phraseLoading ? 'pointer' : 'default',
                background: phrasePass && !phraseLoading ? 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))' : 'rgba(120,150,210,0.15)',
                color: phrasePass && !phraseLoading ? 'var(--accOn,#04120F)' : '#55617D',
                transition: 'all 0.15s',
              }}
            >
              {phraseLoading ? 'Verifying…' : 'Reveal phrase'}
            </button>
          </div>
        )}

        {/* ── Phrase words view ─────────────────────────────────────────────── */}
        {view === 'phraseWords' && words && (
          <div style={{ padding: '24px 24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <p style={{ margin: 0, fontSize: 14, color: '#8A97B4', lineHeight: 1.5 }}>Write these words down in order. They are the only way to recover your wallet.</p>
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFB43C" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" />
              </svg>
              <span style={{ fontSize: 12, color: '#C7D0E4', lineHeight: 1.5 }}>Never enter these words anywhere except Caravel. Caravel will never ask for them via chat, email, or support.</span>
            </div>

            <button onClick={backToMain} style={{ padding: '13px 20px', borderRadius: 12, border: '1px solid rgba(120,150,210,0.2)', background: 'none', color: '#8A97B4', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Done
            </button>
          </div>
        )}
      </div>
    </>
  )
}
