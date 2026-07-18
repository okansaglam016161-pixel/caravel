import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { isMnemonicValid } from '../../crypto/walletCrypto'

// Word positions to quiz in step 3 (1-indexed, shown to user as-is)
const QUIZ_POSITIONS = [5, 12, 20]

// ── Shared sub-components ────────────────────────────────────────────────────

function ProgressBar({ step }: { step: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
      {[1, 2, 3, 4].map(n => (
        <div key={n} style={{
          flex: 1, height: 3, borderRadius: 2, transition: 'background 0.2s',
          background: n <= step ? 'var(--acc,#2DE0C6)' : 'rgba(120,150,210,0.18)',
        }} />
      ))}
    </div>
  )
}

function StepLabel({ step }: { step: number }) {
  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', letterSpacing: '0.14em', marginBottom: 22 }}>
      STEP {step} OF 4
    </div>
  )
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

// ── Step 1: Welcome ──────────────────────────────────────────────────────────

function Step1({ onCreateClick, onRestoreClick }: { onCreateClick: () => void; onRestoreClick: () => void }) {
  return (
    <>
      <ProgressBar step={1} />
      <StepLabel step={1} />
      <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true" style={{ marginBottom: 22 }}>
        <defs>
          <linearGradient id="cwSail" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accL,#5CEAD6)" />
            <stop offset="1" stopColor="var(--accD,#12A594)" />
          </linearGradient>
        </defs>
        <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill="url(#cwSail)" />
        <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="var(--acc,#2DE0C6)" opacity="0.45" />
        <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="var(--acc,#2DE0C6)" />
      </svg>
      <h3 style={{ margin: '0 0 12px', fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', color: '#F2F5FB' }}>Create your Caravel wallet</h3>
      <p style={{ margin: '0 0 24px', fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>A self custodial wallet, generated right here in your browser. Your keys are created on this device and never leave it.</p>
      <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: 15, borderRadius: 12, background: 'rgba(45,224,198,0.05)', border: '1px solid rgba(45,224,198,0.18)', marginBottom: 26 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
          <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span style={{ fontSize: 13, lineHeight: 1.5, color: '#C7E4DD' }}>Nothing is sent to a server. Caravel never sees your keys or your recovery phrase.</span>
      </div>
      <button className="cv-btn-primary" onClick={onCreateClick} style={btnStyle}>Create wallet</button>
      <div style={{ textAlign: 'center', marginTop: 18, fontSize: 14, color: '#8A97B4' }}>
        Already have a wallet?{' '}
        <span onClick={onRestoreClick} style={{ color: 'var(--acc,#2DE0C6)', fontWeight: 600, cursor: 'pointer' }}>Restore from recovery phrase</span>
      </div>
    </>
  )
}

// ── Step 2: Show recovery phrase ─────────────────────────────────────────────

function Step2({ words, onNext }: { words: string[]; onNext: () => void }) {
  const [confirmed, setConfirmed] = useState(false)

  function copyPhrase() {
    navigator.clipboard.writeText(words.join(' ')).catch(() => {})
  }

  return (
    <>
      <ProgressBar step={2} />
      <StepLabel step={2} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h3 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: '#F2F5FB' }}>Your recovery phrase</h3>
        <span onClick={copyPhrase} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 9, border: '1px solid rgba(45,224,198,0.28)', color: 'var(--acc,#2DE0C6)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 18 }}>
        {words.map((word, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 11px', borderRadius: 9, background: '#10151F', border: '1px solid rgba(120,150,210,0.12)', userSelect: 'all' }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', flexShrink: 0 }}>{i + 1}</span>
            <span style={{ fontSize: 13, color: '#E4EAF4', fontWeight: 500 }}>{word}</span>
          </div>
        ))}
      </div>
      <WarnBox
        title="Write these 24 words down, in order."
        body="This is the ONLY way to recover your wallet. Caravel cannot recover it for you, not the phrase, not the password."
      />
      <label onClick={() => setConfirmed(c => !c)} style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 20, cursor: 'pointer' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, borderRadius: 6, flexShrink: 0, transition: 'all 0.15s',
          background: confirmed ? 'var(--acc,#2DE0C6)' : 'transparent',
          border: confirmed ? 'none' : '1.5px solid rgba(120,150,210,0.3)',
        }}>
          {confirmed && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accOn,#04120F)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 7l-8 8-4-4" />
            </svg>
          )}
        </span>
        <span style={{ fontSize: 14, color: '#E4EAF4' }}>I&apos;ve saved my recovery phrase</span>
      </label>
      <button
        className="cv-btn-primary"
        onClick={onNext}
        disabled={!confirmed}
        style={confirmed ? btnStyle : btnDisabled}
      >
        Continue
      </button>
    </>
  )
}

// ── Step 3: Confirm phrase ───────────────────────────────────────────────────

function Step3({ words, onNext }: { words: string[]; onNext: () => void }) {
  const [inputs, setInputs] = useState<Record<number, string>>({})
  const [error, setError] = useState('')

  function setInput(pos: number, val: string) {
    setInputs(prev => ({ ...prev, [pos]: val.trim().toLowerCase() }))
    setError('')
  }

  function verify() {
    for (const pos of QUIZ_POSITIONS) {
      if ((inputs[pos] ?? '') !== words[pos - 1]) {
        setError(`Word #${pos} doesn't match. Check your phrase and try again.`)
        return
      }
    }
    onNext()
  }

  const allFilled = QUIZ_POSITIONS.every(p => (inputs[p] ?? '').length > 0)

  return (
    <>
      <ProgressBar step={3} />
      <StepLabel step={3} />
      <h3 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: '#F2F5FB' }}>Confirm your phrase</h3>
      <p style={{ margin: '0 0 26px', fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>Enter the following words from your recovery phrase to confirm you saved it correctly.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: error ? 14 : 28 }}>
        {QUIZ_POSITIONS.map(pos => {
          const val = inputs[pos] ?? ''
          const filled = val.length > 0
          return (
            <div key={pos}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: filled ? 'var(--acc,#2DE0C6)' : '#8A97B4', marginBottom: 8 }}>WORD #{pos}</div>
              <input
                value={val}
                onChange={e => setInput(pos, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && allFilled) verify() }}
                placeholder="enter word"
                style={{
                  display: 'block', width: '100%', padding: '13px 15px', borderRadius: 11,
                  background: '#10151F', outline: 'none', boxSizing: 'border-box',
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 15,
                  color: filled ? '#E4EAF4' : '#55617D',
                  border: `1px solid ${filled ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`,
                  transition: 'border-color 0.15s',
                }}
              />
            </div>
          )
        })}
      </div>
      {error && (
        <div style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 16, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>
          {error}
        </div>
      )}
      <button className="cv-btn-primary" onClick={verify} disabled={!allFilled} style={allFilled ? btnStyle : btnDisabled}>Continue</button>
    </>
  )
}

// ── Step 4: Set password ─────────────────────────────────────────────────────

function Step4({ mnemonic, onDone }: { mnemonic: string; onDone: () => void }) {
  const { createWallet } = useWallet()
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (pass.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pass !== confirm) { setError('Passwords don\'t match.'); return }
    setError('')
    setLoading(true)
    try {
      await createWallet(mnemonic, pass)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  const canSubmit = pass.length >= 8 && pass === confirm && !loading

  return (
    <>
      <ProgressBar step={4} />
      <StepLabel step={4} />
      <h3 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: '#F2F5FB' }}>Set a password</h3>
      <p style={{ margin: '0 0 24px', fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>Set a password to unlock your wallet on this device.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15, marginBottom: 20 }}>
        {([
          { label: 'Password', val: pass, setter: setPass, show: showPass, toggleShow: () => setShowPass(v => !v) },
          { label: 'Confirm password', val: confirm, setter: setConfirm, show: showConfirm, toggleShow: () => setShowConfirm(v => !v) },
        ] as const).map(({ label, val, setter, show, toggleShow }) => (
          <div key={label}>
            <div style={{ fontSize: 13, color: '#8A97B4', marginBottom: 8 }}>{label}</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderRadius: 11, background: '#10151F', border: `1px solid ${val ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`, transition: 'border-color 0.15s' }}>
              <input
                type={show ? 'text' : 'password'}
                value={val}
                onChange={e => { setter(e.target.value); setError('') }}
                onKeyDown={e => { if (e.key === 'Enter' && canSubmit) submit() }}
                placeholder="••••••••"
                style={{ background: 'none', border: 'none', outline: 'none', fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: '#E4EAF4', flex: 1, letterSpacing: show ? '0' : '0.15em' }}
              />
              <svg onClick={toggleShow} width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ cursor: 'pointer', flexShrink: 0 }}>
                {show
                  ? <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>
                  : <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></>
                }
              </svg>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <div style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>
          {error}
        </div>
      )}
      <WarnBox
        title="This password only unlocks the wallet on this device."
        body="If you forget it, restore using your recovery phrase. Caravel cannot reset it for you."
      />
      <button className="cv-btn-primary" onClick={submit} disabled={!canSubmit} style={canSubmit ? btnStyle : btnDisabled}>
        {loading ? 'Creating wallet…' : 'Create wallet'}
      </button>
    </>
  )
}

// ── Restore flow (inline) ────────────────────────────────────────────────────

function RestoreFlow({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { restore } = useWallet()
  const [phraseInputs, setPhraseInputs] = useState(() => Array(24).fill(''))
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPass, setShowPass] = useState(false)
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
    const { isMnemonicValid: validate } = { isMnemonicValid }
    if (!validate(mnemonic)) { setError('Phrase not recognised. Check word order and spelling.'); return }
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
              <input
                value={word}
                onChange={e => setWord(i, e.target.value)}
                placeholder="word"
                style={{ background: 'none', border: 'none', outline: 'none', fontSize: 12, color: '#E4EAF4', fontFamily: "'IBM Plex Mono', monospace", width: '100%', minWidth: 0 }}
              />
            </div>
          ))}
        </div>
        <WarnBox
          title="Make sure you're on the right site."
          body="Never enter your recovery phrase anywhere except Caravel. Caravel will never ask for it via chat or email."
        />
        {error && (
          <div style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>
            {error}
          </div>
        )}
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15, marginBottom: 20 }}>
        {([
          { label: 'Password', val: pass, setter: setPass, show: showPass, toggleShow: () => setShowPass(v => !v) },
          { label: 'Confirm password', val: confirm, setter: setConfirm, show: showPass, toggleShow: () => setShowPass(v => !v) },
        ] as const).map(({ label, val, setter, show, toggleShow }) => (
          <div key={label}>
            <div style={{ fontSize: 13, color: '#8A97B4', marginBottom: 8 }}>{label}</div>
            <div style={{ display: 'flex', alignItems: 'center', padding: '13px 15px', borderRadius: 11, background: '#10151F', border: `1px solid ${val ? 'rgba(45,224,198,0.35)' : 'rgba(120,150,210,0.16)'}`, transition: 'border-color 0.15s' }}>
              <input type={show ? 'text' : 'password'} value={val} onChange={e => { setter(e.target.value); setError('') }} placeholder="••••••••" style={{ background: 'none', border: 'none', outline: 'none', fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: '#E4EAF4', flex: 1 }} />
              <svg onClick={toggleShow} width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ cursor: 'pointer', flexShrink: 0 }}>
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
              </svg>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <div style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>
          {error}
        </div>
      )}
      <button className="cv-btn-primary" onClick={submit} disabled={!canSubmit} style={canSubmit ? btnStyle : btnDisabled}>
        {loading ? 'Restoring wallet…' : 'Restore wallet'}
      </button>
    </>
  )
}

// ── Root component ───────────────────────────────────────────────────────────

type Mode = 'create' | 'restore'

export default function CreateWallet() {
  const { generateMnemonic } = useWallet()
  const [mode, setMode] = useState<Mode>('create')
  const [step, setStep] = useState(1)
  const [mnemonic, setMnemonic] = useState<string[]>([])

  function startCreate() {
    const phrase = generateMnemonic()
    setMnemonic(phrase.split(' '))
    setStep(2)
  }

  if (mode === 'restore') {
    return (
      <div style={{ minHeight: '100vh', background: 'radial-gradient(900px 460px at 50% 0%, #0C1A1B, #05080E 70%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
        <div style={{ width: '100%', maxWidth: 428, borderRadius: 20, background: '#0C111B', border: '1px solid rgba(120,150,210,0.16)', padding: 30 }}>
          <RestoreFlow onBack={() => { setMode('create'); setStep(1) }} onDone={() => {}} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(900px 460px at 50% 0%, #0C1A1B, #05080E 70%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
      <div style={{ width: '100%', maxWidth: 428, borderRadius: 20, background: '#0C111B', border: '1px solid rgba(120,150,210,0.16)', padding: 30 }}>
        {step === 1 && <Step1 onCreateClick={startCreate} onRestoreClick={() => setMode('restore')} />}
        {step === 2 && <Step2 words={mnemonic} onNext={() => setStep(3)} />}
        {step === 3 && <Step3 words={mnemonic} onNext={() => setStep(4)} />}
        {step === 4 && <Step4 mnemonic={mnemonic.join(' ')} onDone={() => {}} />}
      </div>
    </div>
  )
}
