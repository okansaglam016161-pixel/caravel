//   Create wallet — V3 frames 8a welcome, 8b seed reveal, 8c confirm phrase, 8d set password,
//   8e creating.
//
//   WALLET LOGIC IS UNCHANGED: `createRecoveryPhrase`, the confirm-quiz comparison, and
//   `createWallet` are all exactly as they were. Restore is delegated to the shared RestoreFlow.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { CryptoBusy } from '../primitives'
import RestoreFlow from './RestoreFlow'
import { MONO } from './entryStyles'
import {
  CustodyLine, EntryButton, EntryCard, EntryError, EntryField, EntryLink, EntryBlurb, EntryTitle,
  Lockup, WordChip, WordGrid, entryShell,
} from './entryUi'

/**
 * The positions quizzed in step 3, 1-indexed.
 *
 * FIXED, NOT RANDOMISED, and deliberately left that way by this reskin — changing which words are
 * asked for is a change to what the check is worth, not to how it looks, and it does not belong in
 * a presentation pass. Worth knowing what the check therefore is: it confirms the phrase was
 * WRITTEN DOWN and can be read back, not that it was memorised. There is no attempt limit and Back
 * returns to the words, both on purpose — the goal is a user who has a copy, not one who is locked
 * out of their own wallet by a typo.
 */
const QUIZ_POSITIONS = [5, 12, 20]

// ── 8a · Welcome ─────────────────────────────────────────────────────────────

function Welcome({ onCreate, onRestore, genError }: { onCreate: () => void; onRestore: () => void; genError?: string }) {
  return (
    <EntryCard centred>
      <Lockup />
      <EntryTitle mt={16}>Welcome to Caravel</EntryTitle>
      <EntryBlurb mt={8}>A private wallet, generated on your device.</EntryBlurb>
      {genError && <EntryError mt={12}>{genError}</EntryError>}
      <EntryButton tone="primary" mt={24} onClick={onCreate}>Create wallet</EntryButton>
      <EntryLink onClick={onRestore}>I have a recovery phrase</EntryLink>
    </EntryCard>
  )
}

// ── 8b · Seed reveal ─────────────────────────────────────────────────────────

/**
 * NO COPY BUTTON, and that is the point rather than an omission.
 *
 * This screen used to offer "Copy all 24 words". Writing a seed phrase to the system clipboard
 * puts the whole wallet somewhere any other application on the machine can read, and it is exactly
 * the habit the line below the grid is asking the user not to form. The words are `user-select:
 * all`, so anyone who genuinely wants to select and copy still can — it just is not the path the
 * screen recommends.
 */
function SeedReveal({ words, onNext }: { words: string[]; onNext: () => void }) {
  return (
    <EntryCard wide>
      <EntryTitle big>Your recovery phrase</EntryTitle>
      <EntryBlurb>24 words, in order. The only way back in.</EntryBlurb>
      <WordGrid>
        {words.map((word, i) => <WordChip key={i} n={i + 1} word={word} selectable />)}
      </WordGrid>
      <CustodyLine />
      <EntryButton tone="primary" mt={16} onClick={onNext}>I’ve saved them</EntryButton>
    </EntryCard>
  )
}

// ── 8c · Confirm phrase ──────────────────────────────────────────────────────

/**
 * THE REAL CHECK, AND IT IS TYPING.
 *
 * Three free-text inputs at the fixed positions above, compared by exact string equality against
 * the generated phrase after a trim and a lowercase. NOT multiple choice — a picker would turn a
 * recall test into a one-in-three guess, three times, which is a 1-in-27 pass for someone who
 * wrote nothing down.
 *
 * `allCorrect` gates Continue and nothing else opens it. The validation below is character-for-
 * character what it was before this reskin; only the boxes around it changed.
 */
function SeedConfirm({ words, onBack, onNext }: { words: string[]; onBack: () => void; onNext: () => void }) {
  const [inputs, setInputs] = useState<Record<number, string>>({})
  const setInput = (pos: number, val: string) => setInputs(prev => ({ ...prev, [pos]: val.trim().toLowerCase() }))
  const allCorrect = QUIZ_POSITIONS.every(p => (inputs[p] ?? '') === words[p - 1])

  return (
    <EntryCard>
      <EntryTitle big>Confirm your phrase</EntryTitle>
      <EntryBlurb>Type these three words to prove you saved it.</EntryBlurb>

      {QUIZ_POSITIONS.map((pos, idx) => {
        const val = inputs[pos] ?? ''
        const correct = val === words[pos - 1]
        // Wrong only once something has been typed — an empty field is not a failed one.
        const wrong = val.length > 0 && !correct
        return (
          <div key={pos} style={{ marginTop: idx === 0 ? 20 : 14 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: 'var(--text-muted-dim)' }}>WORD #{pos}</div>
            <div
              className={correct || wrong ? undefined : 'cv-field'}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, marginTop: 7,
                borderRadius: 10, padding: '11px 14px',
                border: `1px solid ${correct ? 'var(--accent-400)' : wrong ? 'var(--danger-500)' : 'var(--border-strong)'}`,
                boxShadow: correct ? '0 0 0 3px rgba(var(--accent-400-rgb),0.18)' : undefined,
              }}
            >
              <input
                value={val}
                onChange={e => setInput(pos, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && allCorrect) onNext() }}
                placeholder={`Type word #${pos}`}
                aria-label={`Word ${pos}`}
                autoFocus={idx === 0}
                style={{
                  flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', padding: 0,
                  fontFamily: MONO, fontSize: 13.5, color: 'var(--text-primary)',
                }}
              />
              {correct && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-400)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6L9 17l-5-5" /></svg>
              )}
              {wrong && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="2.4" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M18 6L6 18M6 6l12 12" /></svg>
              )}
            </div>
            {wrong && <div style={{ fontSize: 12, color: 'var(--danger-500)', marginTop: 6 }}>That doesn’t match word #{pos}.</div>}
          </div>
        )
      })}

      <EntryButton tone="primary" mt={24} disabled={!allCorrect} onClick={onNext}>Continue</EntryButton>
      {/* A disabled control that cannot say why is the thing this app has refused to ship since M4.
          Here it is disabled for most of the time the screen is on show, so it says so. */}
      {!allCorrect && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', textAlign: 'center', marginTop: 8 }}>
          Enabled when all three words match.
        </div>
      )}
      <EntryLink onClick={onBack} tone="muted" mt={12}>Back to my phrase</EntryLink>
    </EntryCard>
  )
}

// ── 8d · Set password ────────────────────────────────────────────────────────

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
      // Success → context sets `wallet` → AppRoute swaps to the shell → this unmounts.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  // ── 8e · Creating ──
  if (loading) return <CryptoBusy title="Creating your wallet" reassurance="Encrypting your phrase on this device. This takes a few seconds." />

  return (
    <EntryCard>
      <EntryTitle big>Set a password</EntryTitle>
      <EntryBlurb>Locks Caravel on this device.</EntryBlurb>
      <EntryField
        label="Password" type="password" value={pass} mt={20}
        onChange={v => { setPass(v); setError('') }} placeholder="Password"
      />
      <EntryField
        label="Confirm password" type="password" value={confirm} mt={14}
        onChange={v => { setConfirm(v); setError('') }}
        onKeyDown={e => { if (e.key === 'Enter' && canSubmit) void submit() }}
        placeholder="Repeat password" invalid={!!confirm && confirm !== pass}
      />
      {/* WHAT A PASSWORD IS NOT. Kept from the previous screen and deliberately: someone who has
          just written down 24 words can reasonably assume the password is a second way in. It is
          not — it unlocks this device, and the phrase is the only recovery there is. */}
      <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', marginTop: 14, lineHeight: 1.5, textWrap: 'pretty' }}>
        This unlocks Caravel on this device. It does not recover your wallet — only your recovery
        phrase can do that.
      </div>
      {error && <EntryError mt={12}>{error}</EntryError>}
      <EntryButton tone="primary" mt={20} disabled={!canSubmit} onClick={() => void submit()}>Continue</EntryButton>
    </EntryCard>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function CreateWallet() {
  const { createRecoveryPhrase } = useWallet()
  const [mode, setMode] = useState<'create' | 'restore'>('create')
  const [step, setStep] = useState(1)
  const [mnemonic, setMnemonic] = useState<string[]>([])
  // Generating a CipherSeed phrase runs Argon2d, so the words do not exist synchronously — step 2
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
      <div style={entryShell}>
        <CryptoBusy title="Creating your recovery phrase" reassurance="Generating the 24 words that back up your wallet." />
      </div>
    )
  }

  return (
    <div style={entryShell}>
      {mode === 'restore'
        ? <RestoreFlow onBack={() => { setMode('create'); setStep(1) }} />
        : <>
            {step === 1 && <Welcome onCreate={() => void startCreate()} onRestore={() => setMode('restore')} genError={genError} />}
            {step === 2 && <SeedReveal words={mnemonic} onNext={() => setStep(3)} />}
            {step === 3 && <SeedConfirm words={mnemonic} onBack={() => setStep(2)} onNext={() => setStep(4)} />}
            {step === 4 && <SetPassword mnemonic={mnemonic.join(' ')} />}
          </>
      }
    </div>
  )
}
