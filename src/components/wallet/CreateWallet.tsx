//   Create-wallet flow — Welcome → Seed reveal → Seed confirm → Set password → creating (busy).
//   Reskinned to the entry-flows design canvas (transcribed element-for-element). Wallet logic is
//   preserved: generateMnemonic, the quiz comparison, and createWallet are unchanged; the flagged
//   touches are per-field quiz validation (gate Continue on all-correct) and the CryptoBusy wait.
//   Restore is delegated to the shared RestoreFlow (debt #8). No progress bar / step label (dropped
//   to match the design). Logo uses the shared primitive's flat variant.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { useTheme } from '../../hooks/useTheme'
import { Logo, CryptoBusy } from '../primitives'
import PasswordField from './PasswordField'
import RestoreFlow from './RestoreFlow'
import { MONO, entryCard, pageShell, primaryBtn, disabledBtn, secondaryBtn, backBtn } from './entryStyles'

// Word positions to quiz in step 3 (1-indexed).
const QUIZ_POSITIONS = [5, 12, 20]

// ── Step 1: Welcome ──────────────────────────────────────────────────────────

function Welcome({ onCreate, onRestore, genError }: { onCreate: () => void; onRestore: () => void; genError?: string }) {
  // See UnlockWallet: the mark swaps with the theme now that the gate does.
  const { theme } = useTheme()
  return (
    <div style={entryCard({ padding: '34px 26px 26px', border: '1px solid rgba(var(--border-rgb),0.16)', textAlign: 'center' })}>
      <div style={{ marginBottom: 18 }}><Logo size={46} onLight={theme === 'light'} /></div>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: 10 }}>Create your Caravel wallet</div>
      <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 24 }}>Your keys are generated here in your browser and never leave this device. We hold nothing.</div>
      {genError && <div style={{ fontSize: 12, color: 'var(--danger-300)', marginBottom: 12 }}>{genError}</div>}
      <button onClick={onCreate} style={{ ...primaryBtn, padding: 14, fontSize: 15, marginBottom: 16 }}>Create wallet</button>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        I already have a wallet. <span onClick={onRestore} style={{ color: 'var(--teal-500)', fontWeight: 600, cursor: 'pointer' }}>Restore from recovery phrase</span>
      </div>
    </div>
  )
}

// ── Step 2: Seed reveal ──────────────────────────────────────────────────────

function SeedReveal({ words, onNext }: { words: string[]; onNext: () => void }) {
  const [confirmed, setConfirmed] = useState(false)
  const copy = () => navigator.clipboard.writeText(words.join(' ')).catch(() => {})

  return (
    <div style={entryCard({ padding: 22, border: '1px solid rgba(var(--warn-rgb),0.28)' })}>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Your recovery phrase</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 14 }}>Write these 24 words down in order, offline.</div>
      <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 11, background: 'rgba(var(--warn-rgb),0.05)', border: '1px solid rgba(var(--warn-rgb),0.28)', marginBottom: 14 }}>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
        <span style={{ fontSize: 12, color: 'var(--warn-300)', lineHeight: 1.5 }}>Anyone with these words owns your wallet. Caravel cannot recover them for you.</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginBottom: 14 }}>
        {words.map((word, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '8px 9px', borderRadius: 8, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.1)', userSelect: 'all' }}>
            <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted-dim)' }}>{String(i + 1).padStart(2, '0')}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-body)' }}>{word}</span>
          </div>
        ))}
      </div>
      <div onClick={copy} style={{ ...secondaryBtn, padding: 11, borderRadius: 11, fontSize: 13, marginBottom: 14 }}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>Copy all 24 words
      </div>
      <div onClick={() => setConfirmed(c => !c)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: `1px solid ${confirmed ? 'rgba(var(--teal-500-rgb),0.3)' : 'rgba(var(--border-rgb),0.14)'}`, marginBottom: 14, cursor: 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 19, height: 19, borderRadius: 6, flexShrink: 0, background: confirmed ? 'var(--teal-500)' : 'transparent', border: confirmed ? 'none' : '1.5px solid rgba(var(--border-rgb),0.3)' }}>
          {confirmed && <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-bright)', fontWeight: 500 }}>I have saved my recovery phrase</span>
      </div>
      <button onClick={onNext} disabled={!confirmed} style={confirmed ? primaryBtn : disabledBtn}>Continue</button>
    </div>
  )
}

// ── Step 3: Seed confirm (per-field validation) ──────────────────────────────

function SeedConfirm({ words, onBack, onNext }: { words: string[]; onBack: () => void; onNext: () => void }) {
  const [inputs, setInputs] = useState<Record<number, string>>({})
  const setInput = (pos: number, val: string) => setInputs(prev => ({ ...prev, [pos]: val.trim().toLowerCase() }))
  const allCorrect = QUIZ_POSITIONS.every(p => (inputs[p] ?? '') === words[p - 1])

  return (
    <div style={entryCard({ padding: 22, border: '1px solid rgba(var(--border-rgb),0.16)' })}>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Confirm your phrase</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 18 }}>Type these three words to prove you saved it.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
        {QUIZ_POSITIONS.map(pos => {
          const val = inputs[pos] ?? ''
          const correct = val === words[pos - 1]
          const wrong = val.length > 0 && !correct
          const border = correct ? 'rgba(var(--teal-500-rgb),0.45)' : wrong ? 'rgba(var(--danger-rgb),0.5)' : 'rgba(var(--border-rgb),0.14)'
          return (
            <div key={pos}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginBottom: 6 }}>WORD #{pos}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: `1px solid ${border}`, boxShadow: correct ? '0 0 0 3px rgba(var(--teal-500-rgb),0.09)' : undefined }}>
                <input
                  value={val}
                  onChange={e => setInput(pos, e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && allCorrect) onNext() }}
                  placeholder={`Type word #${pos}`}
                  style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 14, color: correct ? 'var(--text-bright)' : 'var(--text-body)', padding: 0 }}
                />
                {correct && <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6L9 17l-5-5" /></svg>}
                {wrong && <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.6} strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M6 6l12 12M18 6L6 18" /></svg>}
              </div>
              {wrong && <div style={{ fontSize: 12, color: 'var(--danger-300)', marginTop: 6 }}>That doesn’t match word #{pos}.</div>}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div onClick={onBack} style={backBtn}>Back</div>
        <button onClick={onNext} disabled={!allCorrect} style={allCorrect ? { ...primaryBtn, flex: 1 } : { ...disabledBtn, flex: 1 }}>Continue</button>
      </div>
    </div>
  )
}

// ── Step 4: Set password ─────────────────────────────────────────────────────

function SetPassword({ mnemonic }: { mnemonic: string }) {
  const { createWallet } = useWallet()
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const canSubmit = pass.length >= 8 && pass === confirm && !loading

  async function submit() {
    if (pass.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pass !== confirm) { setError("Passwords don't match."); return }
    setError('')
    setLoading(true)
    try {
      await createWallet(mnemonic, pass)
      // Success → context sets `wallet` → AppRoute swaps to ChatApp → this unmounts.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  if (loading) return <CryptoBusy title="Encrypting your wallet on this device" reassurance="Deriving your keys and locking the phrase behind your password. Both are deliberately slow, so a stolen file is hard to crack." />

  return (
    <div style={entryCard({ padding: 22, border: '1px solid rgba(var(--border-rgb),0.16)' })}>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Set a password</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 18 }}>This unlocks your wallet on this device.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
        <PasswordField value={pass} onChange={v => { setPass(v); setError('') }} />
        <PasswordField value={confirm} onChange={v => { setConfirm(v); setError('') }} onKeyDown={e => { if (e.key === 'Enter' && canSubmit) submit() }} invalid={!!confirm && confirm !== pass} />
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 11, background: 'rgba(var(--warn-rgb),0.05)', border: '1px solid rgba(var(--warn-rgb),0.28)', marginBottom: 16 }}>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
        <span style={{ fontSize: 12, color: 'var(--warn-300)', lineHeight: 1.5 }}>A password unlocks this device only. It does not recover your wallet. Lose both and the wallet is gone permanently.</span>
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--danger-300)', marginBottom: 14 }}>{error}</div>}
      <button onClick={submit} disabled={!canSubmit} style={canSubmit ? primaryBtn : disabledBtn}>Create wallet and continue</button>
    </div>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function CreateWallet() {
  const { createRecoveryPhrase } = useWallet()
  const [mode, setMode] = useState<'create' | 'restore'>('create')
  const [step, setStep] = useState(1)
  const [mnemonic, setMnemonic] = useState<string[]>([])
  // Generating a CipherSeed phrase runs Argon2d, so the words no longer exist synchronously — step 2
  // cannot render until this resolves. Short (tens of ms on a laptop) but not free, and on a slow
  // phone it is long enough that an unacknowledged tap would read as a dead button.
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')

  async function startCreate() {
    setGenError('')
    setGenerating(true)
    try {
      setMnemonic((await createRecoveryPhrase()).split(' '))
      setStep(2)
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Could not create a recovery phrase. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  if (generating) {
    return (
      <div style={pageShell}>
        <CryptoBusy title="Creating your recovery phrase" reassurance="Generating the 24 words that back up your wallet and your messages." />
      </div>
    )
  }

  return (
    <div style={pageShell}>
      {mode === 'restore'
        ? <RestoreFlow onBack={() => { setMode('create'); setStep(1) }} />
        : <>
            {step === 1 && <Welcome onCreate={startCreate} onRestore={() => setMode('restore')} genError={genError} />}
            {step === 2 && <SeedReveal words={mnemonic} onNext={() => setStep(3)} />}
            {step === 3 && <SeedConfirm words={mnemonic} onBack={() => setStep(2)} onNext={() => setStep(4)} />}
            {step === 4 && <SetPassword mnemonic={mnemonic.join(' ')} />}
          </>
      }
    </div>
  )
}
