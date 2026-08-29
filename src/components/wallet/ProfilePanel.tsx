//   ProfilePanel — the wallet's own identity and keys, opened from the service rail's profile row.
//
//   ── WALLET-ONLY, AS OF V3 SERIES 6 ───────────────────────────────────────────
//
//   It used to carry three identities at once: the Tari address, the Nostr npub, and the @names
//   this wallet owns on chain. That made it a drawer rather than a panel — three unrelated systems
//   sharing one sheet because they all answered to the word "profile".
//
//   The npub and the @names are GONE FROM THIS PANEL and will reappear where they belong: the npub
//   in a messaging compartment, @names on the Name page, which already owns registration. Nothing
//   was deleted to do it — `nostrNpub` is still on the wallet context and `ownedOnsNames` is still
//   in crypto/ons, both untouched and both still used elsewhere. This file simply stopped
//   rendering them.
//
//   What is left is what a WALLET panel is for: how to be paid, how to recover the wallet, and how
//   to lock it.
//
//   ── THE PASSWORD GATE IS LOAD-BEARING ────────────────────────────────────────
//
//   Three steps, and the order is a security property rather than a navigation convenience:
//
//     main        → the address, and the door to the phrase
//     phraseAuth  → the password. `getMnemonic(password)` DECRYPTS with it, so a wrong password
//                   cannot produce words — the gate is cryptographic, not a UI check.
//     phraseWords → the 24 words, reachable ONLY by a successful decrypt
//
//   `setStep('phraseWords')` appears exactly once in this file, on the line after `getMnemonic`
//   resolves. `words` starts null and is only ever assigned from that result, and the reveal
//   renders on `step === 'phraseWords' && words`. There is no path from `main` to the phrase that
//   does not go through a successful decrypt, and a reskin must never introduce one.

import { useEffect, useState } from 'react'
import { useWallet } from '../../context/WalletContext'

const MONO = 'var(--font-mono)'

const CopyIcon = ({ c = 'var(--text-muted-dim)' }: { c?: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-400)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
)
const eyeOpen = (c: string) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>)
const eyeOff = (c: string) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></svg>)

/** The card, shared by all three steps — the V3 sheet card, same as Send and Receive. */
const CARD: React.CSSProperties = { padding: 32 }

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose} aria-label="Close" className="cv-icon-btn"
      style={{
        cursor: 'pointer', width: 28, height: 28, borderRadius: 8,
        border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted-dim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
    </button>
  )
}

/** The full-width action at the foot of a card — the same shape the send and move sheets use. */
function PanelButton({ tone, onClick, children, mt, disabled = false }: {
  tone: 'primary' | 'quiet'; onClick?: () => void; children: React.ReactNode; mt: number; disabled?: boolean
}) {
  return (
    <span
      role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onKeyDown={e => { if (!disabled && e.key === 'Enter') onClick?.() }}
      className={tone === 'quiet' && !disabled ? 'cv-quiet-btn' : undefined}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        marginTop: mt, padding: tone === 'primary' ? 13 : 12, borderRadius: 10,
        fontSize: tone === 'primary' ? 14 : 13.5, fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer', userSelect: 'none',
        background: tone === 'primary' ? 'var(--accent-400)' : 'transparent',
        border: tone === 'primary' ? '1px solid transparent' : '1px solid var(--border-strong)',
        color: tone === 'primary' ? '#FFFFFF' : 'var(--text-primary)',
        opacity: disabled ? 0.55 : 1,
      }}
    >{children}</span>
  )
}

type Step = 'main' | 'phraseAuth' | 'phraseWords'

export default function ProfilePanel({ onClose }: { onClose: () => void }) {
  const { getMnemonic, lock, address } = useWallet()
  const [step, setStep] = useState<Step>('main')
  const [phrasePass, setPhrasePass] = useState('')
  const [showPhrasePass, setShowPhrasePass] = useState(false)
  const [phraseError, setPhraseError] = useState('')
  const [phraseLoading, setPhraseLoading] = useState(false)
  const [words, setWords] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── The gate. UNCHANGED from the version this reskinned. ──
  //
  // `getMnemonic` decrypts the stored seed WITH the password, so a wrong one throws rather than
  // returning anything. That is why the check is safe to do here: there is no comparison to get
  // wrong and no boolean to invert — without the right password there are no words to show.
  async function revealPhrase() {
    if (!phrasePass) return
    setPhraseError('')
    setPhraseLoading(true)
    try {
      const mnemonic = await getMnemonic(phrasePass)
      setWords(mnemonic.split(' '))
      setStep('phraseWords')
    } catch (e) {
      const isWrongPass = e instanceof DOMException && e.name === 'OperationError'
      setPhraseError(isWrongPass ? 'Incorrect password. Try again.' : `Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPhraseLoading(false)
    }
  }

  function backToMain() {
    setStep('main')
    setPhrasePass('')
    setPhraseError('')
    // The words leave state with the screen. Going back is not just navigation here — it is the
    // point at which the phrase stops being in memory for this component.
    setWords(null)
    setShowPhrasePass(false)
  }

  function handleLock() { lock(); onClose() }

  function copyAddress() {
    // THE FULL ADDRESS, never the truncated display. A partially-copied Tari address is an
    // unrecoverable payment, so what is drawn and what is copied come from different expressions
    // on purpose — see the row below.
    if (!address) return
    void navigator.clipboard?.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const shownAddress = address
    ? (address.length > 30 ? `${address.slice(0, 14)}…${address.slice(-10)}` : address)
    : 'Resolving your account…'

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(6,12,21,0.72)', backdropFilter: 'blur(3px)', zIndex: 200 }} />

      <div
        role="dialog" aria-modal="true" aria-label="Profile"
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 'min(420px, 94vw)', maxHeight: '88vh', zIndex: 201,
          background: 'var(--surface)', borderRadius: 18, border: '1px solid var(--border)',
          boxShadow: 'var(--e3)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ overflowY: 'auto' }}>

          {/* ═══ 6a · PROFILE ═══ */}
          {step === 'main' && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* A WALLET MARK, not an avatar. The panel is about this wallet's keys now, not
                    about who you are to other people — the identity that had a face left with the
                    npub. */}
                <span style={{
                  width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                  background: 'var(--accent-wash)', color: 'var(--accent-ink)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2.5" y="6" width="19" height="13" rx="2.5" /><path d="M2.5 10h19" /><path d="M15.5 14.5h2" />
                  </svg>
                </span>
                <span style={{ flex: 1, fontSize: 15.5, fontWeight: 600, color: 'var(--text-primary)' }}>Profile</span>
                <CloseButton onClose={onClose} />
              </div>

              {/* The address comes from the same context field the Receive sheet shows, so the two
                  cannot disagree. Null until the account resolves after unlock — said as
                  "resolving", never as an empty row somebody might copy. */}
              <div
                onClick={address ? copyAddress : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginTop: 24,
                  padding: '12px 14px', borderRadius: 10,
                  background: 'var(--surface-void)', border: '1px solid var(--border)',
                  cursor: address ? 'pointer' : 'default',
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted-dim)', flexShrink: 0 }}>Address</span>
                <span style={{
                  flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11.5,
                  color: address ? 'var(--text-body-dim)' : 'var(--text-faint)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{copied ? 'Copied' : shownAddress}</span>
                {address && (copied ? <CheckIcon /> : <CopyIcon />)}
              </div>

              <div
                role="button" tabIndex={0}
                onClick={() => setStep('phraseAuth')}
                onKeyDown={e => e.key === 'Enter' && setStep('phraseAuth')}
                className="cv-quiet-btn"
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                  padding: '12px 14px', borderRadius: 10,
                  border: '1px solid var(--border)', cursor: 'pointer',
                }}
              >
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Show recovery phrase</span>
                {/* The gate, ANNOUNCED. Someone deciding whether to tap this should know it will
                    ask before it shows anything. */}
                <span style={{ fontSize: 11.5, color: 'var(--text-muted-dim)' }}>Requires password</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>

              <PanelButton tone="quiet" mt={20} onClick={handleLock}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                Lock wallet
              </PanelButton>
            </div>
          )}

          {/* ═══ 6b · PASSWORD PROMPT — the gate ═══ */}
          {step === 'phraseAuth' && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1, fontSize: 21, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Recovery phrase</span>
                <CloseButton onClose={onClose} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginTop: 6 }}>
                Enter your password to reveal your 24 words.
              </div>

              <div style={{ marginTop: 28 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-body-dim)' }}>Password</div>
                <div className="cv-field" style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                  border: `1px solid ${phraseError ? 'var(--danger-500)' : 'var(--border-strong)'}`,
                  borderRadius: 10, padding: '12px 14px',
                }}>
                  <input
                    type={showPhrasePass ? 'text' : 'password'}
                    value={phrasePass} autoFocus
                    onChange={e => { setPhrasePass(e.target.value); setPhraseError('') }}
                    onKeyDown={e => { if (e.key === 'Enter' && phrasePass) void revealPhrase() }}
                    placeholder="Your password" aria-label="Password"
                    style={{
                      flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', padding: 0,
                      fontFamily: MONO, fontSize: 13.5, color: 'var(--text-primary)',
                    }}
                  />
                  {/* Kept, though the frame draws a plain field: a mistyped password on a screen
                      that exists to answer "is this really you" costs an extra round trip, and
                      showing your own password to yourself reveals nothing the phrase behind it
                      does not. */}
                  <span
                    role="button" tabIndex={0} aria-label={showPhrasePass ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPhrasePass(v => !v)}
                    onKeyDown={e => e.key === 'Enter' && setShowPhrasePass(v => !v)}
                    style={{ cursor: 'pointer', flexShrink: 0, display: 'flex' }}
                  >{showPhrasePass ? eyeOpen('var(--text-faint-dim)') : eyeOff('var(--text-faint-dim)')}</span>
                </div>
                {phraseError && (
                  <div style={{ fontSize: 12, color: 'var(--danger-300)', marginTop: 10, lineHeight: 1.5 }}>{phraseError}</div>
                )}
              </div>

              <PanelButton
                tone="primary" mt={24}
                disabled={!phrasePass || phraseLoading}
                onClick={() => void revealPhrase()}
              >
                {phraseLoading && <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#FFFFFF', animation: 'cv-spin 0.8s linear infinite' }} />}
                {phraseLoading ? 'Verifying…' : 'Reveal phrase'}
              </PanelButton>
              <PanelButton tone="quiet" mt={10} onClick={backToMain}>Cancel</PanelButton>
            </div>
          )}

          {/* ═══ 6c · REVEALED ═══
              REACHABLE ONLY FROM A SUCCESSFUL DECRYPT. `words` is assigned in exactly one place —
              after `getMnemonic` resolves — and this branch requires both the step AND the words,
              so neither a stray `setStep` nor an empty array can put an empty grid on screen
              pretending to be a phrase. */}
          {step === 'phraseWords' && words && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1, fontSize: 21, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Recovery phrase</span>
                <CloseButton onClose={onClose} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginTop: 6 }}>
                Your 24 words, in order. The only way back in.
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 20 }}>
                {words.map((w, i) => (
                  <span key={i} style={{
                    padding: '7px 10px', borderRadius: 8,
                    background: 'var(--surface-void)', border: '1px solid var(--border)',
                    fontFamily: MONO, fontSize: 11, color: 'var(--text-primary)', userSelect: 'all',
                  }}>
                    <span style={{ color: 'var(--text-muted-dim)' }}>{i + 1}</span> {w}
                  </span>
                ))}
              </div>

              {/* ── THE CUSTODY FACT, KEPT ──
                  The frame's line is "Keep them safe, offline. Never share them with anyone." —
                  calmer than the amber alert this replaced, and right to be. But it dropped the one
                  thing a user may genuinely not know: there is no one to ask. A recovery phrase is
                  not a password that support can reset, and a wallet that says only "keep it safe"
                  lets someone assume a fallback exists. Said flatly, as a fact rather than a
                  warning — which is also why it can sit in the same quiet grey as the rest. */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 16, justifyContent: 'center' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 3 }}>
                  <path d="M12 2l8 3.5v5.2c0 5-3.4 9.6-8 11.3-4.6-1.7-8-6.3-8-11.3V5.5z" />
                </svg>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', lineHeight: 1.55, textAlign: 'center', textWrap: 'pretty' }}>
                  Keep them safe and offline. Never share them. Caravel cannot recover them for you.
                </span>
              </div>

              <PanelButton tone="quiet" mt={16} onClick={backToMain}>Hide phrase</PanelButton>
            </div>
          )}

        </div>
      </div>
    </>
  )
}
