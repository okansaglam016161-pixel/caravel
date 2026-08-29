//   RestoreFlow — the ONE canonical restore-from-phrase flow, reached from both entry points:
//   Create/Welcome ("I have a recovery phrase") and Unlock ("Forgot password?"). Each caller
//   passes its own onBack.
//
//   V3 frames 9a enter phrase and 9b set password. The two FAILURE screens are ours — the frames
//   do not draw them, and they are the reason this flow is worth anything on a bad day:
//
//     badphrase  `validateMnemonicDetail` separates a wordlist miss (names the word, offers
//                "Fix word #N" and focuses that cell) from a checksum failure (no single culprit,
//                so no word number is invented).
//     ambiguous  A phrase valid in BOTH formats — one in a trillion. Asked rather than guessed,
//                because with funds involved the difference between "cannot happen" and "we picked
//                one for you" is the whole point.
//
//   RESTORE LOGIC IS UNCHANGED: detectScheme, validateMnemonicDetail and restore() are exactly as
//   they were, and the scheme is still established once, here, before any password is set.
//
//   There is NO wrong-password state here: restore() OVERWRITES the wallet file with a fresh
//   encryption, so no existing password is ever checked. Wrong-password lives on Unlock only.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { validateMnemonicDetail, type MnemonicDetail } from '../../crypto/walletCrypto'
import { detectScheme, type DerivationScheme } from '../../crypto/derivation'
import { CryptoBusy } from '../primitives'
import { MONO } from './entryStyles'
import {
  EntryButton, EntryCard, EntryError, EntryField, EntryLink, EntryBlurb, EntryTitle, WordChip,
  WordGrid,
} from './entryUi'

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
      setDetail(null)
      setStep('ambiguous')
      return
    }
    // Invalid. validateMnemonicDetail still gives the best available explanation: the wordlist is
    // shared by both formats, so a word that isn't in it is nameable either way.
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
      // On success the context sets `wallet` → AppRoute swaps to the shell → this unmounts.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      setStep('password')
    }
  }

  // ── Restoring ────────────────────────────────────────────────────────────────
  if (step === 'restoring') {
    return <CryptoBusy title="Restoring your wallet" reassurance="Rebuilding your keys from the phrase. This takes a few seconds." />
  }

  // ── Ambiguous phrase ─────────────────────────────────────────────────────────
  if (step === 'ambiguous') {
    const choose = (s: DerivationScheme) => { setScheme(s); setStep('password') }
    return (
      <EntryCard>
        <EntryTitle big>Which wallet is this?</EntryTitle>
        <EntryBlurb>
          This phrase is valid in both recovery-phrase formats, which is extraordinarily rare. Pick
          the one it came from — choosing wrong opens a different, empty wallet, so if you aren’t
          sure, go back and check your written copy first.
        </EntryBlurb>
        <EntryButton tone="primary" mt={20} onClick={() => choose('cipherseed')}>A Tari wallet, or a newer Caravel wallet</EntryButton>
        <EntryButton tone="quiet" mt={10} onClick={() => choose('bip39')}>An older Caravel wallet</EntryButton>
        <EntryLink onClick={() => { setStep('phrase'); setScheme(null) }} tone="muted" mt={14}>Back to my phrase</EntryLink>
      </EntryCard>
    )
  }

  // ── Bad phrase ───────────────────────────────────────────────────────────────
  if (step === 'badphrase' && detail && !detail.valid) {
    const isWordlist = detail.kind === 'wordlist'
    const bad = isWordlist ? detail.index : 0                 // 1-indexed offending position
    const cells = isWordlist ? [bad - 2, bad - 1, bad].filter(n => n >= 1) : []
    return (
      <EntryCard>
        <EntryTitle big>That phrase isn’t valid</EntryTitle>
        <EntryBlurb>
          {isWordlist
            // NAMES THE WORD. A phrase rejected without saying which word is 24 things to re-check.
            ? <>Word #{detail.index} “{detail.word}” isn’t in the wordlist. Check your written copy.</>
            // NO WORD NUMBER HERE, because there is no culprit to name — every word is in the list
            // and it is the phrase as a whole that fails. Inventing a position would send someone
            // to re-check a word that is probably correct.
            : 'Every word is in the list, but the phrase doesn’t check out. Check the order against your written copy.'}
        </EntryBlurb>
        {isWordlist && (
          <WordGrid mt={20}>
            {cells.map(n => <WordChip key={n} n={n} word={phraseInputs[n - 1]} tone={n === bad ? 'bad' : 'plain'} />)}
          </WordGrid>
        )}
        {isWordlist && (
          <EntryButton tone="primary" mt={20} onClick={() => { setAutoFocusCell(bad - 1); setStep('phrase'); setDetail(null) }}>
            Fix word #{detail.index}
          </EntryButton>
        )}
        <EntryLink onClick={() => { setStep('phrase'); setDetail(null) }} tone="muted" mt={isWordlist ? 12 : 20}>
          Back to my phrase
        </EntryLink>
      </EntryCard>
    )
  }

  // ── 9b · Set a new password ──────────────────────────────────────────────────
  if (step === 'password') {
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
        {/* KEPT. Restore rewrites the wallet file, so any password already set on this device stops
            working the moment this succeeds. Someone restoring onto a device they already use has
            to be told that before they do it, not after. */}
        <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', marginTop: 14, lineHeight: 1.5, textWrap: 'pretty' }}>
          This replaces any password previously set on this device.
        </div>
        {error && <EntryError mt={12}>{error}</EntryError>}
        <EntryButton tone="primary" mt={20} disabled={!canSubmit} onClick={() => void submit()}>Restore wallet</EntryButton>
        <EntryLink onClick={() => { setStep('phrase'); setError('') }} tone="muted" mt={12}>Back to my phrase</EntryLink>
      </EntryCard>
    )
  }

  // ── 9a · Phrase entry ────────────────────────────────────────────────────────
  return (
    <EntryCard wide>
      <EntryTitle big>Restore your wallet</EntryTitle>
      <EntryBlurb>Enter your 24 words in order. Paste works too.</EntryBlurb>
      <WordGrid>
        {phraseInputs.map((word, i) => {
          const active = focusedCell === i
          const empty = word.length === 0
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline', gap: 6,
              padding: '7px 10px', borderRadius: 8, minHeight: 16,
              background: active ? 'var(--surface)' : 'var(--surface-void)',
              // A dashed edge for a cell not yet filled, per the frame — it reads as a blank to be
              // completed rather than as a field that failed.
              border: active ? '1px solid var(--accent-400)'
                : empty ? '1px dashed var(--border-strong)'
                : '1px solid var(--border)',
              boxShadow: active ? '0 0 0 3px rgba(var(--accent-400-rgb),0.18)' : undefined,
            }}>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', flexShrink: 0 }}>{i + 1}</span>
              <input
                value={word}
                autoFocus={autoFocusCell === i}
                onChange={e => setWord(i, e.target.value)}
                onPaste={e => pasteFrom(i, e)}
                onFocus={() => setFocusedCell(i)}
                onBlur={() => setFocusedCell(-1)}
                aria-label={`Word ${i + 1}`}
                style={{
                  background: 'transparent', border: 'none', outline: 'none', padding: 0,
                  fontFamily: MONO, fontSize: 11, color: 'var(--text-primary)', width: '100%', minWidth: 0,
                }}
              />
            </div>
          )
        })}
      </WordGrid>
      {/* ANTI-PHISHING, KEPT. The frame omits it; it is the one line on this screen that protects
          against the attack this screen is the target of. A recovery phrase is only ever typed
          here, and anyone asking for it elsewhere is stealing it. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 16 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
          <path d="M12 2l8 3.5v5.2c0 5-3.4 9.6-8 11.3-4.6-1.7-8-6.3-8-11.3V5.5z" />
        </svg>
        <span style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', lineHeight: 1.5, textWrap: 'pretty' }}>
          Only ever enter your recovery phrase on Caravel. Caravel will never ask for it by email or chat.
        </span>
      </div>
      <EntryButton tone="primary" mt={20} disabled={!allWordsFilled} onClick={checkPhrase}>Continue</EntryButton>
      <EntryLink onClick={onBack} tone="muted" mt={12}>Back</EntryLink>
    </EntryCard>
  )
}
