//   RestoreFlow — the ONE canonical restore-from-phrase flow, reached from both entry points:
//   Create/Welcome ("I have a recovery phrase") and Unlock ("Forgot password?"). Each caller
//   passes its own onBack.
//
//   V3 frames 9a enter phrase and 9b set password.
//
//   ── ONE UNIFORM INVALID RESULT, AS A PRIVACY POSTURE ─────────────────────────
//
//   An invalid phrase gets a single word-agnostic line under the grid and nothing else: no word
//   number, no marked cell, no button offering to jump to a cell. A word outside the wordlist, a
//   checksum that does not verify, and a CipherSeed MAC that fails after the password step all
//   say exactly the same thing.
//
//   This flow used to name the offending word. That was standard local BIP-39 behaviour and it
//   leaked nothing exploitable — anyone holding 23 of someone's 24 words narrows the last one
//   offline from a public wordlist, with no help from us. It was removed as a deliberate posture,
//   not as a fix, and the detail was DELETED rather than hidden: nothing in the codebase can return
//   a word position any more. See the note where the explainer used to live, in walletCrypto.ts.
//   The UX argument for pointing at the word is real and was heard — do not reopen it here alone.
//
//   The one failure screen still drawn as a card is `ambiguous`: a phrase valid in BOTH formats,
//   one in a trillion. It is a question rather than an error — asked instead of guessed, because
//   with funds involved the difference between "cannot happen" and "we picked one for you" is the
//   whole point.
//
//   detectScheme IS THE SOLE GATE, and the validation crypto is untouched by all of the above: the
//   same wordlist, the same BIP-39 checksum, the same CipherSeed CRC32 and MAC. Only what is
//   REPORTED changed. Nothing but detectScheme's verdict decides whether restore proceeds, and the
//   scheme is still established once, here, before any password is set.
//
//   There is NO wrong-password state here: restore() OVERWRITES the wallet file with a fresh
//   encryption, so no existing password is ever checked. Wrong-password lives on Unlock only.

import { useState } from 'react'
import { InvalidRecoveryPhraseError } from 'tari-cipherseed'
import { useWallet } from '../../context/WalletContext'
import { detectScheme, type DerivationScheme } from '../../crypto/derivation'
import { CryptoBusy } from '../primitives'
import { MONO } from './entryStyles'
import {
  EntryButton, EntryCard, EntryError, EntryField, EntryLink, EntryBlurb, EntryTitle, WordGrid,
} from './entryUi'

type Step = 'phrase' | 'ambiguous' | 'password' | 'restoring'

/**
 * The one thing an invalid phrase is ever told, wherever it failed — the wordlist, the checksum, or
 * the CipherSeed MAC three steps later. Shared by both call sites below so they cannot drift into
 * two subtly different sentences, which is how a uniform result quietly stops being uniform.
 */
const INVALID_PHRASE = 'That phrase isn’t valid. Check it against your written copy.'

export default function RestoreFlow({ onBack }: { onBack: () => void }) {
  const { restore } = useWallet()
  const [phraseInputs, setPhraseInputs] = useState<string[]>(() => Array(24).fill(''))
  const [focusedCell, setFocusedCell] = useState(-1)
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [step, setStep] = useState<Step>('phrase')
  const [error, setError] = useState('')
  // Which derivation the typed phrase belongs to. Established once, here, before any password is
  // set — and carried through to restore() rather than being re-derived deeper in the stack.
  const [scheme, setScheme] = useState<DerivationScheme | null>(null)

  function setWord(i: number, val: string) {
    setError('')
    setPhraseInputs(prev => prev.map((w, j) => (j === i ? val.trim().toLowerCase() : w)))
  }

  // "Paste works too" — distribute a whitespace-separated phrase across cells from this one on.
  function pasteFrom(i: number, e: React.ClipboardEvent) {
    const parts = e.clipboardData.getData('text').trim().split(/\s+/)
    if (parts.length <= 1) return
    e.preventDefault()
    setError('')
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
      setError('')
      setStep('password')
      return
    }
    if (detected === 'ambiguous') {
      setError('')
      setStep('ambiguous')
      return
    }
    // Invalid — and this is ALL the user is told. A word outside the wordlist and a checksum that
    // does not verify are reported IDENTICALLY, through one shared string, on this same screen.
    // Nothing reachable from here knows which word it was: see the note in walletCrypto.ts.
    setError(INVALID_PHRASE)
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
      // A PHRASE CAN STILL FAIL HERE, and that is not a fault. detectScheme's CipherSeed test is
      // the cheap structural one (version byte + CRC32); the MAC is only verified inside
      // importWalletSeed, which runs here — after a password has been set. That is the one
      // InvalidRecoveryPhraseError reachable from this point, it means "bad phrase", and so it gets
      // the SAME uniform line as every other invalid phrase and goes back to the grid, which is the
      // only place it can be fixed.
      if (e instanceof InvalidRecoveryPhraseError) {
        setError(INVALID_PHRASE)
        setStep('phrase')
        return
      }
      // ANYTHING ELSE IS NOT A BAD PHRASE. A wasm fault or a derivation bug keeps its own message
      // and stays on this step, exactly as Unlock keeps "Incorrect password" away from real faults
      // — a user retyping a correct phrase forever is the failure this distinction prevents.
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
      {/* THE ONE THING AN INVALID PHRASE IS TOLD, and it is told HERE rather than on a card of
          its own: with no word to point at, a separate screen would take the 24 words the user
          now has to re-read against paper off the screen in order to say one sentence. Unlock
          reports a mistyped password in exactly this shape — one calm line, no alert box. */}
      {error && <EntryError mt={12}>{error}</EntryError>}
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
