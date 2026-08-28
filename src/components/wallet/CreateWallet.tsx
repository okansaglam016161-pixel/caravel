//   Create-wallet flow — Welcome → Seed reveal → Seed confirm → Set password → creating (busy).
//   Reskinned to the entry-flows design canvas (transcribed element-for-element). Wallet logic is
//   preserved: generateMnemonic, the quiz comparison, and createWallet are unchanged; the flagged
//   touches are per-field quiz validation (gate Continue on all-correct) and the CryptoBusy wait.
//   Restore is delegated to the shared RestoreFlow (debt #8). No progress bar / step label (dropped
//   to match the design). Logo uses the shared primitive's flat variant.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { CryptoBusy } from '../primitives'
import PasswordField from './PasswordField'
import RestoreFlow from './RestoreFlow'
import { MONO, entryCard, logoTile, pageShell, primaryBtn, disabledBtn, secondaryBtn, backBtn, wordChip } from './entryStyles'

// Word positions to quiz in step 3 (1-indexed).
const QUIZ_POSITIONS = [5, 12, 20]

// ── Step 1: Welcome ──────────────────────────────────────────────────────────

function Welcome({ onCreate, onRestore, genError }: { onCreate: () => void; onRestore: () => void; genError?: string }) {
  return (
    <div style={entryCard({ padding: '28px 24px', textAlign: 'center' })}>
      {/* The mark on its accent tile, as the design draws it — the light mark on a blue ground, so
          the lockup is identical in both themes and needs no per-theme variant of its own. */}
      <span style={{ ...logoTile, width: 44, height: 44 }}>
        <img src="/logo-light.png" alt="" aria-hidden="true" style={{ height: 23, width: 'auto', display: 'block' }} />
      </span>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', marginTop: 14 }}>Welcome to Caravel</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', marginTop: 4, lineHeight: 1.5, textWrap: 'pretty' }}>
        A private wallet, generated on your device. Your keys never leave it.
      </div>
      {genError && <div style={{ fontSize: 12, color: 'var(--danger-500)', marginTop: 12 }}>{genError}</div>}
      <button onClick={onCreate} style={{ ...primaryBtn, marginTop: 16 }}>Create wallet</button>
      <div onClick={onRestore} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onRestore()}
        style={{ fontSize: 12, color: 'var(--accent-ink)', marginTop: 10, cursor: 'pointer', fontWeight: 500 }}>
        I have a recovery phrase
      </div>
    </div>
  )
}

// ── Step 2: Seed reveal ──────────────────────────────────────────────────────

function SeedReveal({ words, onNext }: { words: string[]; onNext: () => void }) {
  const [confirmed, setConfirmed] = useState(false)
  const copy = () => navigator.clipboard.writeText(words.join(' ')).catch(() => {})

  return (
    <div style={entryCard({ padding: 22 })}>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)' }}>Your recovery phrase</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 3 }}>24 words. The only way back in, held by you.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 12 }}>
        {words.map((word, i) => (
          <span key={i} style={{ ...wordChip, userSelect: 'all' }}>
            <span style={{ color: 'var(--text-muted-dim)' }}>{i + 1}</span>{word}
          </span>
        ))}
      </div>
      {/* The one warning that has to survive any reskin: these words ARE the wallet. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginTop: 12, fontSize: 11.5, color: 'var(--warn)', lineHeight: 1.5 }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 2 }}>
          <path d="M12 9v4M12 17h.01" /><path d="M10.3 3.8L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z" />
        </svg>
        <span>Write it down offline. Anyone with these words owns your wallet, and Caravel cannot recover them.</span>
      </div>
      <div style={{ marginTop: 12 }} />
      <div onClick={copy} style={{ ...secondaryBtn, marginBottom: 12 }}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--accent-400)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>Copy all 24 words
      </div>
      <div onClick={() => setConfirmed(c => !c)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderRadius: 11, background: 'var(--surface-void)', border: `1px solid ${confirmed ? 'var(--accent-400)' : 'var(--border)'}`, marginBottom: 14, cursor: 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 19, height: 19, borderRadius: 6, flexShrink: 0, background: confirmed ? 'var(--accent-400)' : 'transparent', border: confirmed ? 'none' : '1.5px solid var(--border-strong)' }}>
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
    <div style={entryCard({ padding: 22 })}>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>Confirm your phrase</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 18 }}>Type these three words to prove you saved it.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
        {QUIZ_POSITIONS.map(pos => {
          const val = inputs[pos] ?? ''
          const correct = val === words[pos - 1]
          const wrong = val.length > 0 && !correct
          const border = correct ? 'var(--accent-400)' : wrong ? 'var(--danger-500)' : 'var(--border)'
          return (
            <div key={pos}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginBottom: 6 }}>WORD #{pos}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', borderRadius: 11, background: 'var(--surface-void)', border: `1px solid ${border}`, boxShadow: correct ? '0 0 0 3px rgba(var(--accent-400-rgb),0.18)' : undefined }}>
                <input
                  value={val}
                  onChange={e => setInput(pos, e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && allCorrect) onNext() }}
                  placeholder={`Type word #${pos}`}
                  style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 14, color: correct ? 'var(--text-bright)' : 'var(--text-body)', padding: 0 }}
                />
                {correct && <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--accent-400)" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6L9 17l-5-5" /></svg>}
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
    <div style={entryCard({ padding: 22 })}>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>Set a password</div>
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
