//   RestoreFlow — the ONE canonical restore-from-phrase flow (debt #8), reused from both entry
//   points: Create/Welcome ("I already have a wallet") and Unlock ("Forgot password?"). Each caller
//   passes its own onBack. Structure transcribed from the entry-flows design canvas; the restore
//   logic (validate → set new password → restore) is preserved from the previous inline copies.
//
//   Failure distinction (Flag 1): validateMnemonicDetail separates a wordlist miss (names the word,
//   offers "Fix word #N") from a checksum failure (no single culprit → "Back", no word number).
//   There is NO wrong-password state here: restore() OVERWRITES the wallet file with a fresh
//   encryption, so no existing password is ever checked. Wrong-password lives on Unlock only.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { validateMnemonicDetail, type MnemonicDetail } from '../../crypto/walletCrypto'
import { detectScheme, type DerivationScheme } from '../../crypto/derivation'
import { CryptoBusy } from '../primitives'
import PasswordField from './PasswordField'
import { MONO, entryCard, primaryBtn, disabledBtn, secondaryBtn, backBtn } from './entryStyles'

type Step = 'phrase' | 'badphrase' | 'ambiguous' | 'password' | 'restoring'

export default function RestoreFlow({ onBack }: { onBack: () => void }) {
  const { restore } = useWallet()
  const [phraseInputs, setPhraseInputs] = useState<string[]>(() => Array(24).fill(''))
  const [focusedCell, setFocusedCell] = useState(-1)
  const [autoFocusCell, setAutoFocusCell] = useState(-1)
  const [detail, setDetail] = useState<MnemonicDetail | null>(null)
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [step, setStep] = useState<Step>('phrase')
  const [error, setError] = useState('')
  // Which derivation the typed phrase belongs to. Established once, here, before any password is
  // set — and carried through to restore() rather than being re-derived deeper in the stack.
  const [scheme, setScheme] = useState<DerivationScheme | null>(null)

  function setWord(i: number, val: string) {
    setPhraseInputs(prev => prev.map((w, j) => (j === i ? val.trim().toLowerCase() : w)))
  }

  // "Paste works too" — distribute a whitespace-separated phrase across cells from this one on.
  function pasteFrom(i: number, e: React.ClipboardEvent) {
    const parts = e.clipboardData.getData('text').trim().split(/\s+/)
    if (parts.length <= 1) return
    e.preventDefault()
    setPhraseInputs(prev => {
      const next = [...prev]
      for (let k = 0; k < parts.length && i + k < 24; k++) next[i + k] = parts[k].trim().toLowerCase()
      return next
    })
  }

  const allWordsFilled = phraseInputs.every(w => w.length > 0)
  const canSubmit = pass.length >= 8 && pass === confirm

  // A restored phrase can be either format: Tari's CipherSeed (what Caravel issues now, and what an
  // official Tari wallet exports) or the legacy BIP-39 an older Caravel wallet was created with.
  // Both are 24 words from the same wordlist, so the format is established structurally.
  function checkPhrase() {
    const phrase = phraseInputs.join(' ')
    const detected = detectScheme(phrase)

    if (detected === 'cipherseed' || detected === 'bip39') {
      setScheme(detected)
      setDetail(null)
      setStep('password')
      return
    }
    if (detected === 'ambiguous') {
      // Should never happen (~2^-40). Asked rather than guessed, because with funds involved the
      // difference between "cannot happen" and "we picked one for you" is the whole point.
      setDetail(null)
      setStep('ambiguous')
      return
    }
    // Invalid. validateMnemonicDetail still gives the best available explanation: the wordlist is
    // shared by both formats, so a word that isn't in it is nameable either way. Only the checksum
    // wording had to stop being BIP-39-specific.
    setDetail(validateMnemonicDetail(phrase))
    setStep('badphrase')
  }

  async function submit() {
    if (pass.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pass !== confirm) { setError("Passwords don't match."); return }
    if (!scheme) { setError('Check your recovery phrase again.'); setStep('phrase'); return }
    setError('')
    setStep('restoring')
    try {
      await restore(phraseInputs.join(' '), pass, scheme)
      // On success the context sets `wallet` → AppRoute swaps to ChatApp → this unmounts.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      setStep('password')
    }
  }

  // ── Restoring busy ──────────────────────────────────────────────────────────
  if (step === 'restoring') {
    return <CryptoBusy title="Restoring your wallet" reassurance="Rebuilding your keys from the phrase and encrypting them here. This takes a moment." />
  }

  // ── Ambiguous phrase ──────────────────────────────────────────────────────────
  // Reachable only if a phrase satisfies BOTH formats' integrity checks — a coincidence on the
  // order of one in a trillion. It exists so that outcome is a question with two clear answers
  // rather than an undefined path through fund-critical code.
  if (step === 'ambiguous') {
    const choose = (s: DerivationScheme) => { setScheme(s); setStep('password') }
    return (
      <div style={entryCard({ padding: 22, border: '1px solid rgba(var(--warn-rgb),0.3)' })}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>Which wallet is this?</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 18 }}>
          This phrase is valid in both recovery-phrase formats, which is extraordinarily rare. Pick
          the one it came from — choosing wrong opens a different, empty wallet, so if you aren’t
          sure, go back and check your written copy first.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          <button onClick={() => choose('cipherseed')} style={{ ...primaryBtn, padding: 13 }}>A Tari wallet, or a newer Caravel wallet</button>
          <button onClick={() => choose('bip39')} style={{ ...secondaryBtn, padding: 13, textAlign: 'center' }}>An older Caravel wallet</button>
        </div>
        <div onClick={() => { setStep('phrase'); setScheme(null) }} style={{ ...backBtn, textAlign: 'center' }}>Back</div>
      </div>
    )
  }

  // ── Bad phrase ────────────────────────────────────────────────────────────────
  if (step === 'badphrase' && detail && !detail.valid) {
    const isWordlist = detail.kind === 'wordlist'
    const bad = isWordlist ? detail.index : 0                 // 1-indexed offending position
    const windowEnd = isWordlist ? bad : 0
    const cells = isWordlist ? [windowEnd - 2, windowEnd - 1, windowEnd].filter(n => n >= 1) : []
    return (
      <div style={entryCard({ padding: 22, border: '1px solid rgba(var(--danger-rgb),0.3)' })}>
        <div style={{ display: 'flex', gap: 11, padding: '14px 15px', borderRadius: 12, background: 'rgba(var(--danger-rgb),0.05)', border: '1px solid rgba(var(--danger-rgb),0.3)', marginBottom: 16 }}>
          <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.2} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger-300)', marginBottom: 4 }}>That recovery phrase isn’t valid</div>
            <div style={{ fontSize: 12, color: 'var(--text-body-dim)', lineHeight: 1.5 }}>
              {isWordlist
                ? `Word #${detail.index} “${detail.word}” isn’t in the wordlist. Check your written copy.`
                : 'Every word is in the list, but the phrase doesn’t check out. Check the order and your written copy.'}
            </div>
          </div>
        </div>
        {isWordlist && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginBottom: 16 }}>
            {cells.map(n => {
              const isBad = n === bad
              return (
                <div key={n} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '8px 9px', borderRadius: 8, background: 'var(--surface-void)', border: `1px solid ${isBad ? 'var(--danger-500)' : 'var(--border)'}` }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: isBad ? 'var(--danger-300)' : 'var(--text-muted-dim)' }}>{n}</span>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: isBad ? 'var(--danger-300)' : 'var(--text-body)' }}>{phraseInputs[n - 1]}</span>
                </div>
              )
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <div onClick={() => { setStep('phrase'); setDetail(null) }} style={isWordlist ? backBtn : { ...backBtn, flex: 1 }}>Back</div>
          {isWordlist && (
            <div onClick={() => { setAutoFocusCell(bad - 1); setStep('phrase'); setDetail(null) }} style={{ ...secondaryBtn, flex: 1 }}>Fix word #{detail.index}</div>
          )}
        </div>
      </div>
    )
  }

  // ── Set a new password ──────────────────────────────────────────────────────
  if (step === 'password') {
    return (
      <div style={entryCard({ padding: 22 })}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>Set a new password</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 18 }}>For unlocking the restored wallet on this device.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          <PasswordField value={pass} onChange={v => { setPass(v); setError('') }} />
          <PasswordField value={confirm} onChange={v => { setConfirm(v); setError('') }} onKeyDown={e => { if (e.key === 'Enter' && canSubmit) submit() }} invalid={!!confirm && confirm !== pass} />
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 11, background: 'rgba(var(--warn-rgb),0.05)', border: '1px solid rgba(var(--warn-rgb),0.28)', marginBottom: 16 }}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
          <span style={{ fontSize: 12, color: 'var(--warn-300)', lineHeight: 1.5 }}>This replaces any password previously set on this device.</span>
        </div>
        {error && <div style={{ fontSize: 12, color: 'var(--danger-300)', marginBottom: 14 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <div onClick={() => { setStep('phrase'); setError('') }} style={backBtn}>Back</div>
          <button onClick={submit} disabled={!canSubmit} style={canSubmit ? { ...primaryBtn, flex: 1 } : { ...disabledBtn, flex: 1 }}>Restore wallet</button>
        </div>
      </div>
    )
  }

  // ── Phrase entry ──────────────────────────────────────────────────────────────
  return (
    <div style={entryCard({ padding: 22 })}>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>Enter your recovery phrase</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 16 }}>All 24 words, in order. Paste works too.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginBottom: 16 }}>
        {phraseInputs.map((word, i) => {
          const active = focusedCell === i
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '8px 9px', borderRadius: 8, background: 'var(--surface-void)', minHeight: 17, border: active ? '1px solid var(--accent-400)' : '1px solid var(--border)', boxShadow: active ? '0 0 0 3px rgba(var(--accent-400-rgb),0.18)' : 'none' }}>
              <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted-dim)', flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
              <input
                value={word}
                autoFocus={autoFocusCell === i}
                onChange={e => setWord(i, e.target.value)}
                onPaste={e => pasteFrom(i, e)}
                onFocus={() => setFocusedCell(i)}
                onBlur={() => setFocusedCell(-1)}
                style={{ background: 'transparent', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 12, color: 'var(--text-body)', width: '100%', minWidth: 0, padding: 0 }}
              />
            </div>
          )
        })}
      </div>
      {/* Anti-phishing warning — kept as a deliberate security addition (the static mock omitted it). */}
      <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 11, background: 'rgba(var(--warn-rgb),0.05)', border: '1px solid rgba(var(--warn-rgb),0.28)', marginBottom: 16 }}>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
        <span style={{ fontSize: 12, color: 'var(--warn-300)', lineHeight: 1.5 }}>Only ever enter your recovery phrase on Caravel. Caravel will never ask for it by email or chat.</span>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div onClick={onBack} style={backBtn}>Back</div>
        <button onClick={checkPhrase} disabled={!allWordsFilled} style={allWordsFilled ? { ...primaryBtn, flex: 1 } : { ...disabledBtn, flex: 1 }}>Continue</button>
      </div>
    </div>
  )
}
