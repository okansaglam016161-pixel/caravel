//   The chat identity gate — what /app shows until Chat is unlocked.
//
//   Chat has its own identity now (crypto/chatIdentity), with its own password. The wallet is NOT a
//   prerequisite: it sets itself up (or unlocks) from its own tab, inside the app.
//
//     no identity on this device → Welcome → Create (phrase → confirm → password) or Import
//     identity on this device    → Unlock, with Import ("Forgot password?") and a fresh start
//
//   Built from the same entry primitives as the wallet's gate (wallet/entryUi), so the two read as one
//   app. The 12-word phrase is labelled as a CHAT backup everywhere it appears, and a 24-word wallet
//   phrase is refused at import with a pointer to the Wallet tab — two phrases is the cost of keeping
//   the identities independent, and the screens must not let one be mistaken for the other.

import { useEffect, useState } from 'react'
import { useChat, type ImportCheck } from '../../../context/ChatContext'
import { createChatPhrase } from '../../../crypto/chatIdentity'
import { CryptoBusy } from '../../primitives'
import { MONO } from '../../wallet/entryStyles'
import {
  CustodyLine, EntryBlurb, EntryButton, EntryCard, EntryError, EntryField, EntryLink, EntrySpinner,
  EntryTitle, Lockup, WordChip, WordGrid, entryShell,
} from '../../wallet/entryUi'

/** Positions quizzed after the phrase is shown, 1-indexed — one from each third of the 12. */
const QUIZ_POSITIONS = [3, 7, 11]

const MIN_PASSWORD = 8

// ── Welcome ──────────────────────────────────────────────────────────────────

function Welcome({ replaces, onCreate, onImport, onBack }: {
  replaces: boolean; onCreate: () => void; onImport: () => void; onBack?: () => void
}) {
  return (
    <EntryCard centred>
      <Lockup />
      <EntryTitle mt={16}>{replaces ? 'Set up a different identity' : 'Your Caravel identity'}</EntryTitle>
      <EntryBlurb mt={8}>Private messaging, with a key generated on your device.</EntryBlurb>
      {replaces && (
        <EntryBlurb mt={14}>
          This replaces the chat identity saved on this device. Make sure you have its backup phrase or
          nsec: it is the only way back to it.
        </EntryBlurb>
      )}
      <EntryButton tone="primary" mt={24} onClick={onCreate}>Create a new identity</EntryButton>
      <EntryLink onClick={onImport}>I have a backup</EntryLink>
      {onBack && <EntryLink onClick={onBack} tone="muted" mt={12}>Back</EntryLink>}
    </EntryCard>
  )
}

// ── Create: phrase, confirm ──────────────────────────────────────────────────

function PhraseReveal({ words, onNext }: { words: string[]; onNext: () => void }) {
  return (
    <EntryCard wide>
      <EntryTitle big>Your chat backup phrase</EntryTitle>
      <EntryBlurb>12 words, in order. They restore your chat identity — not your wallet.</EntryBlurb>
      <WordGrid>
        {words.map((word, i) => <WordChip key={i} n={i + 1} word={word} selectable />)}
      </WordGrid>
      <CustodyLine />
      <EntryButton tone="primary" mt={16} onClick={onNext}>I’ve saved them</EntryButton>
    </EntryCard>
  )
}

function PhraseConfirm({ words, onBack, onNext }: { words: string[]; onBack: () => void; onNext: () => void }) {
  const [inputs, setInputs] = useState<Record<number, string>>({})
  const allCorrect = QUIZ_POSITIONS.every(p => (inputs[p] ?? '') === words[p - 1])
  return (
    <EntryCard>
      <EntryTitle big>Confirm your phrase</EntryTitle>
      <EntryBlurb>Type these three words to prove you saved it.</EntryBlurb>
      {QUIZ_POSITIONS.map((pos, idx) => {
        const val = inputs[pos] ?? ''
        const wrong = val.length > 0 && val !== words[pos - 1]
        return (
          <div key={pos}>
            <EntryField
              label={`Word #${pos}`} value={val} mt={idx === 0 ? 20 : 14} autoFocus={idx === 0}
              onChange={v => setInputs(prev => ({ ...prev, [pos]: v.trim().toLowerCase() }))}
              onKeyDown={e => { if (e.key === 'Enter' && allCorrect) onNext() }}
              placeholder={`Type word #${pos}`} invalid={wrong}
            />
            {wrong && <EntryError mt={6}>That doesn’t match word #{pos}.</EntryError>}
          </div>
        )
      })}
      <EntryButton tone="primary" mt={24} disabled={!allCorrect} onClick={onNext}>Continue</EntryButton>
      {!allCorrect && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', textAlign: 'center', marginTop: 8 }}>
          Enabled when all three words match.
        </div>
      )}
      <EntryLink onClick={onBack} tone="muted" mt={12}>Back to my phrase</EntryLink>
    </EntryCard>
  )
}

// ── Set password (create and import share it) ───────────────────────────────

function SetPassword({ busyTitle, onSubmit, onBack }: {
  busyTitle: string
  onSubmit: (password: string) => Promise<void>
  onBack?: () => void
}) {
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const canSubmit = pass.length >= MIN_PASSWORD && pass === confirm && !loading

  async function submit() {
    if (pass.length < MIN_PASSWORD) { setError(`Password must be at least ${MIN_PASSWORD} characters.`); return }
    if (pass !== confirm) { setError("Passwords don't match."); return }
    setError('')
    setLoading(true)
    try {
      await onSubmit(pass)
      // Success → chatUnlocked → AppRoute swaps to the shell → this unmounts.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  if (loading) return <CryptoBusy title={busyTitle} reassurance="Encrypting your chat identity on this device. This takes a few seconds." />

  return (
    <EntryCard>
      <EntryTitle big>Set a chat password</EntryTitle>
      <EntryBlurb>Unlocks Chat on this device.</EntryBlurb>
      <EntryField label="Password" type="password" value={pass} mt={20} autoFocus
        onChange={v => { setPass(v); setError('') }} placeholder="Password" />
      <EntryField label="Confirm password" type="password" value={confirm} mt={14}
        onChange={v => { setConfirm(v); setError('') }}
        onKeyDown={e => { if (e.key === 'Enter' && canSubmit) void submit() }}
        placeholder="Repeat password" invalid={!!confirm && confirm !== pass} />
      <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', marginTop: 14, lineHeight: 1.5, textWrap: 'pretty' }}>
        This is separate from your wallet password. It unlocks Chat on this device; it does not recover
        your identity — only your backup phrase or nsec can do that.
      </div>
      {error && <EntryError mt={12}>{error}</EntryError>}
      <EntryButton tone="primary" mt={20} disabled={!canSubmit} onClick={() => void submit()}>Continue</EntryButton>
      {onBack && <EntryLink onClick={onBack} tone="muted" mt={12}>Back</EntryLink>}
    </EntryCard>
  )
}

// ── Import ───────────────────────────────────────────────────────────────────

function importMessage(check: ImportCheck): string | null {
  switch (check.kind) {
    case 'empty': return null
    case 'wallet-phrase': return 'That’s a wallet recovery phrase. Restore it from the Wallet tab instead.'
    case 'invalid':
      return check.reason === 'bad-nsec' ? 'That nsec isn’t valid.'
        : check.reason === 'bad-phrase' ? 'That isn’t a valid 12-word backup phrase.'
        : 'Enter your 12-word backup phrase, or an nsec.'
    default: return null
  }
}

function ImportBackup({ replaces, onBack }: { replaces: boolean; onBack: () => void }) {
  const { checkImport, importChatIdentity } = useChat()
  const [raw, setRaw] = useState('')
  const [check, setCheck] = useState<ImportCheck>({ kind: 'empty' })
  const [removeOld, setRemoveOld] = useState(false)
  const [step, setStep] = useState<'enter' | 'password'>('enter')

  // Re-checked as the person types. Stale answers are dropped by the token.
  useEffect(() => {
    let live = true
    setRemoveOld(false)
    void checkImport(raw).then(c => { if (live) setCheck(c) }).catch(() => { if (live) setCheck({ kind: 'invalid', reason: 'unrecognised' }) })
    return () => { live = false }
  }, [raw, checkImport])

  const ok = check.kind === 'phrase' || check.kind === 'nsec'
  const stale = ok && check.staleHistory
  const canContinue = ok && (!stale || removeOld)
  const message = importMessage(check)

  if (step === 'password') {
    return (
      <SetPassword
        busyTitle="Restoring your chat identity"
        onBack={() => setStep('enter')}
        onSubmit={pass => importChatIdentity(raw, pass, { removeOldHistory: removeOld })}
      />
    )
  }

  return (
    <EntryCard>
      <EntryTitle big>Import your backup</EntryTitle>
      <EntryBlurb>Your 12-word chat backup phrase, or an nsec.</EntryBlurb>
      {replaces && (
        <EntryBlurb mt={10}>This replaces the chat identity saved on this device.</EntryBlurb>
      )}
      <EntryField
        label="Backup" value={raw} mt={20} autoFocus
        onChange={setRaw}
        onKeyDown={e => { if (e.key === 'Enter' && canContinue) setStep('password') }}
        placeholder="12 words, or nsec1…" invalid={!!message}
      />
      {message && <EntryError>{message}</EntryError>}

      {ok && (
        <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, background: 'var(--accent-wash)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-ink)' }}>This restores</div>
          <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--text-body-dim)', marginTop: 3, wordBreak: 'break-all' }}>{check.npub}</div>
        </div>
      )}

      {/* A NEW STORAGE KEY CANNOT OPEN THE OLD ONE'S HISTORY. Left in place, the stores would refuse
          every new write (they never overwrite what they cannot read) — so it goes, but only when the
          person says so. */}
      {stale && (
        <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-strong)' }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>
            Old chat history on this device can’t be unlocked. Remove it and continue?
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12.5, color: 'var(--text-body-dim)', cursor: 'pointer' }}>
            <input type="checkbox" checked={removeOld} onChange={e => setRemoveOld(e.target.checked)} />
            Remove the old history from this device
          </label>
        </div>
      )}

      <EntryButton tone="primary" mt={20} disabled={!canContinue} onClick={() => setStep('password')}>Continue</EntryButton>
      <EntryLink onClick={onBack} tone="muted" mt={12}>Back</EntryLink>
    </EntryCard>
  )
}

// ── Unlock ───────────────────────────────────────────────────────────────────

function Unlock({ onImport, onCreate }: { onImport: () => void; onCreate: () => void }) {
  const { unlockChat } = useChat()
  const [pass, setPass] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!pass) return
    setError('')
    setLoading(true)
    try {
      await unlockChat(pass)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg === 'Wrong password.' ? 'Incorrect password. Try again.' : `Unlock failed: ${msg}`)
      setLoading(false)
    }
  }

  return (
    <EntryCard centred>
      <Lockup />
      <EntryTitle mt={16}>Welcome back</EntryTitle>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 32, marginBottom: 8 }}>
          <EntrySpinner size={16} ring={2.5} />
          <span style={{ fontSize: 13.5, color: 'var(--text-body-dim)' }}>Unlocking</span>
        </div>
      ) : (
        <>
          <div style={{ textAlign: 'left' }}>
            <EntryField
              type="password" value={pass} autoFocus
              onChange={v => { setPass(v); setError('') }}
              onKeyDown={e => { if (e.key === 'Enter' && pass) void submit() }}
              placeholder="Chat password" ariaLabel="Chat password"
              invalid={!!error} mt={24}
            />
            {error && <EntryError>{error}</EntryError>}
          </div>
          <EntryButton tone="primary" mt={12} disabled={!pass} onClick={() => void submit()}>Unlock chat</EntryButton>
          <EntryLink onClick={onImport} mt={16}>Forgot password? Import your backup</EntryLink>
          <EntryLink onClick={onCreate} tone="muted" mt={10}>Set up a different identity</EntryLink>
        </>
      )}
    </EntryCard>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────

type Mode = 'start' | 'reveal' | 'confirm' | 'password' | 'import'

export default function ChatIdentityGate() {
  const { chatExists, createChatIdentity } = useChat()
  const [mode, setMode] = useState<Mode>('start')
  const [words, setWords] = useState<string[]>([])
  // On a device that already has an identity, "start" is Unlock; Welcome is reached from its
  // "different identity" link, and says it replaces the one stored here.
  const [welcome, setWelcome] = useState(!chatExists)

  function startCreate() {
    setWords(createChatPhrase().split(' '))
    setMode('reveal')
  }

  function backToStart() { setMode('start'); setWords([]) }

  return (
    <div style={entryShell}>
      {mode === 'start' && (welcome
        ? <Welcome
            replaces={chatExists}
            onCreate={startCreate}
            onImport={() => setMode('import')}
            onBack={chatExists ? () => setWelcome(false) : undefined}
          />
        : <Unlock onImport={() => setMode('import')} onCreate={() => setWelcome(true)} />)}
      {mode === 'reveal' && <PhraseReveal words={words} onNext={() => setMode('confirm')} />}
      {mode === 'confirm' && <PhraseConfirm words={words} onBack={() => setMode('reveal')} onNext={() => setMode('password')} />}
      {mode === 'password' && (
        <SetPassword
          busyTitle="Creating your chat identity"
          onBack={() => setMode('confirm')}
          onSubmit={pass => createChatIdentity(words.join(' '), pass)}
        />
      )}
      {mode === 'import' && <ImportBackup replaces={chatExists} onBack={backToStart} />}
    </div>
  )
}
