import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { isMnemonicValid } from '../../crypto/walletCrypto'

const btnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 15, borderRadius: 12, width: '100%', border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer',
  background: 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))',
  color: 'var(--accOn,#04120F)',
}

const btnDisabled: React.CSSProperties = {
  ...btnStyle,
  background: 'rgba(120,150,210,0.15)',
  color: '#55617D',
  cursor: 'default',
}

function WarnBox({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: 15, borderRadius: 12, background: 'rgba(255,180,60,0.06)', border: '1px solid rgba(255,180,60,0.3)', marginBottom: 18 }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFB43C" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#FFC978', marginBottom: 5 }}>{title}</div>
        <div style={{ fontSize: 12, lineHeight: 1.5, color: '#C7D0E4' }}>{body}</div>
      </div>
    </div>
  )
}

// ── Restore flow ─────────────────────────────────────────────────────────────

function RestoreFlow({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { restore } = useWallet()
  const [phraseInputs, setPhraseInputs] = useState(() => Array(24).fill(''))
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [step, setStep] = useState<'phrase' | 'password'>('phrase')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function setWord(i: number, val: string) {
    setPhraseInputs(prev => prev.map((w, j) => (j === i ? val.trim().toLowerCase() : w)))
    setError('')
  }

  function nextFromPhrase() {
    const mnemonic = phraseInputs.join(' ')
    if (!phraseInputs.every(w => w.length > 0)) { setError('Please fill in all 24 words.'); return }
    if (!isMnemonicValid(mnemonic)) { setError('Phrase not recognised. Check word order and spelling.'); return }
    setError('')
    setStep('password')
  }

  async function submit() {
    if (pass.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pass !== confirm) { setError("Passwords don't match."); return }
    setError('')
    setLoading(true)
    try {
      await restore(phraseInputs.join(' '), pass)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      setLoading(false)
    }
  }

  const allWordsFilled = phraseInputs.every(w => w.length > 0)
  const canSubmit = pass.length >= 8 && pass === confirm && !loading

  if (step === 'phrase') {
    return (
      <>
        <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', color: '#8A97B4', fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 22 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
          Back
        </button>
        <h3 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: '#F2F5FB' }}>Restore from recovery phrase</h3>
        <p style={{ margin: '0 0 22px', fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>Enter your 24-word recovery phrase in order to restore access to your wallet.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 18 }}>
          {phraseInputs.map((word, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 10px', borderRadius: 9, background: '#10151F', border: `1px solid ${word ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.12)'}`, transition: 'border-color 0.15s' }}>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', flexShrink: 0 }}>{i + 1}</span>
              <input value={word} onChange={e => setWord(i, e.target.value)} placeholder="word" style={{ background: 'none', border: 'none', outline: 'none', fontSize: 12, color: '#E4EAF4', fontFamily: "'IBM Plex Mono', monospace", width: '100%', minWidth: 0 }} />
            </div>
          ))}
        </div>
        <WarnBox
          title="Make sure you're on the right site."
          body="Never enter your recovery phrase anywhere except Caravel. Caravel will never ask for it via chat or email."
        />
        {error && <div style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>{error}</div>}
        <button className="cv-btn-primary" onClick={nextFromPhrase} disabled={!allWordsFilled} style={allWordsFilled ? btnStyle : btnDisabled}>Continue</button>
      </>
    )
  }

  return (
    <>
      <button onClick={() => setStep('phrase')} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', color: '#8A97B4', fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 22 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        Back
      </button>
      <h3 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: '#F2F5FB' }}>Set a new password</h3>
      <p style={{ margin: '0 0 24px', fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>Your phrase is valid. Set a password to unlock this wallet on the device.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15, marginBottom: 14 }}>
        {[
          { label: 'Password', val: pass, setter: setPass },
          { label: 'Confirm password', val: confirm, setter: setConfirm },
        ].map(({ label, val, setter }) => (
          <div key={label}>
            <div style={{ fontSize: 13, color: '#8A97B4', marginBottom: 8 }}>{label}</div>
            <input type="password" value={val} onChange={e => { setter(e.target.value); setError('') }} placeholder="••••••••" style={{ display: 'block', width: '100%', padding: '13px 15px', borderRadius: 11, background: '#10151F', border: `1px solid ${val ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`, outline: 'none', fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: '#E4EAF4', boxSizing: 'border-box' }} />
          </div>
        ))}
      </div>
      {error && <div style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>{error}</div>}
      <button className="cv-btn-primary" onClick={submit} disabled={!canSubmit} style={canSubmit ? btnStyle : btnDisabled}>
        {loading ? 'Restoring wallet…' : 'Restore wallet'}
      </button>
    </>
  )
}

// ── Unlock screen ────────────────────────────────────────────────────────────

function UnlockScreen({ onRestore }: { onRestore: () => void }) {
  const { unlock } = useWallet()
  const [pass, setPass] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!pass) return
    setError('')
    setLoading(true)
    try {
      await unlock(pass)
      // On success, WalletContext updates → AppRoute re-renders into ChatApp automatically
    } catch (e) {
      // AES-GCM auth failure (wrong password) throws DOMException with name 'OperationError'.
      // Any other error (e.g. derivation bug) gets a distinct message so it's not hidden.
      const isWrongPassword = e instanceof DOMException && e.name === 'OperationError'
      setError(isWrongPassword ? 'Incorrect password. Try again.' : `Unlock failed: ${e instanceof Error ? e.message : String(e)}`)
      setLoading(false)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
        <svg viewBox="0 0 44 44" width="48" height="48" aria-hidden="true">
          <defs>
            <linearGradient id="uwSail" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--accL,#5CEAD6)" />
              <stop offset="1" stopColor="var(--accD,#12A594)" />
            </linearGradient>
          </defs>
          <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill="url(#uwSail)" />
          <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="var(--acc,#2DE0C6)" opacity="0.45" />
          <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="var(--acc,#2DE0C6)" />
        </svg>
      </div>
      <h2 style={{ margin: '0 0 10px', fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', color: '#F2F5FB', textAlign: 'center' }}>Welcome back</h2>
      <p style={{ margin: '0 0 28px', fontSize: 15, lineHeight: 1.6, color: '#8A97B4', textAlign: 'center' }}>Enter your password to unlock Caravel on this device.</p>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#8A97B4', marginBottom: 8 }}>Password</div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '13px 15px', borderRadius: 11, background: '#10151F', border: `1px solid ${pass ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`, transition: 'border-color 0.15s' }}>
          <input
            type={showPass ? 'text' : 'password'}
            value={pass}
            onChange={e => { setPass(e.target.value); setError('') }}
            onKeyDown={e => { if (e.key === 'Enter' && pass) submit() }}
            placeholder="Password"
            autoFocus
            style={{ background: 'none', border: 'none', outline: 'none', fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: '#E4EAF4', flex: 1 }}
          />
          <svg onClick={() => setShowPass(v => !v)} width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ cursor: 'pointer', flexShrink: 0 }}>
            {showPass
              ? <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>
              : <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></>
            }
          </svg>
        </div>
      </div>
      {error && <div style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>{error}</div>}
      <button className="cv-btn-primary" onClick={submit} disabled={!pass || loading} style={pass && !loading ? { ...btnStyle, marginBottom: 20 } : { ...btnDisabled, marginBottom: 20 }}>
        {loading ? 'Unlocking…' : 'Unlock'}
      </button>
      <div style={{ textAlign: 'center', fontSize: 14, color: '#8A97B4' }}>
        Forgot password?{' '}
        <span onClick={onRestore} style={{ color: 'var(--acc,#2DE0C6)', fontWeight: 600, cursor: 'pointer' }}>Restore from recovery phrase</span>
      </div>
    </>
  )
}

// ── Root component ───────────────────────────────────────────────────────────

export default function UnlockWallet() {
  const [mode, setMode] = useState<'unlock' | 'restore'>('unlock')

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(900px 460px at 50% 0%, #0C1A1B, #05080E 70%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
      <div style={{ width: '100%', maxWidth: 428, borderRadius: 20, background: '#0C111B', border: '1px solid rgba(120,150,210,0.16)', padding: 30 }}>
        {mode === 'unlock'
          ? <UnlockScreen onRestore={() => setMode('restore')} />
          : <RestoreFlow onBack={() => setMode('unlock')} onDone={() => {}} />
        }
      </div>
    </div>
  )
}
