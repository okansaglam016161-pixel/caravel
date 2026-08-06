//   ProfilePanel — account / identity actions, opened from the chat sidebar's profile button.
//   Same modal chrome as WalletModal (dimmed backdrop, Esc to close). Three sections:
//     1. Copy your npub — the user's own npub (truncated, mono) via the CopyBtn chip primitive.
//     2. Show recovery phrase — RELOCATED verbatim from WalletModal Settings: password gate
//        (getMnemonic) → 24-word reveal. The password gate is preserved intact (security).
//     3. Lock wallet — RELOCATED verbatim: lock() then close.
//   No logic change vs. the old wallet-Settings versions; only the location moved.

import { useEffect, useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { ownedOnsNames, type NameRecord } from '../../crypto/ons'
import CopyBtn from '../primitives/CopyBtn'

const MONO = 'var(--font-mono)'

const eyeOpen = (c: string) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>)
const eyeOff = (c: string) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></svg>)
const copyIcon = (c = 'var(--teal-500)') => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>)

// Truncate the bech32 npub for display; the full value is what CopyBtn copies.
function truncNpub(npub: string): string {
  return npub.length > 24 ? `${npub.slice(0, 12)}…${npub.slice(-8)}` : npub
}

type Step = 'main' | 'phraseAuth' | 'phraseWords'
type NamesState =
  | { kind: 'loading' }
  | { kind: 'list'; names: NameRecord[] }
  | { kind: 'empty' }
  | { kind: 'error'; msg: string }

export default function ProfilePanel({ onClose, avatar }: { onClose: () => void; avatar: { grad: string; color: string } }) {
  const { nostrNpub, getMnemonic, lock, wallet } = useWallet()
  const [step, setStep] = useState<Step>('main')
  const [phrasePass, setPhrasePass] = useState('')
  const [showPhrasePass, setShowPhrasePass] = useState(false)
  const [phraseError, setPhraseError] = useState('')
  const [phraseLoading, setPhraseLoading] = useState(false)
  const [words, setWords] = useState<string[] | null>(null)
  const [names, setNames] = useState<NamesState>({ kind: 'loading' })
  const [namesNonce, setNamesNonce] = useState(0)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The @names this wallet owns — reverse-looked-up on-chain (see ownedOnsNames). Re-runs on retry.
  useEffect(() => {
    if (!wallet) return
    let cancelled = false
    setNames({ kind: 'loading' })
    ownedOnsNames(wallet).then(r => {
      if (cancelled) return
      if (!r.ok) setNames({ kind: 'error', msg: r.error ?? 'Could not load your names — try again.' })
      else setNames(r.names && r.names.length > 0 ? { kind: 'list', names: r.names } : { kind: 'empty' })
    })
    return () => { cancelled = true }
  }, [wallet, namesNonce])

  // ── Relocated verbatim from WalletModal Settings ──
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
    setWords(null)
    setShowPhrasePass(false)
  }

  function handleLock() { lock(); onClose() }

  const headerTitle = step === 'phraseAuth' ? 'Confirm identity' : step === 'phraseWords' ? 'Recovery phrase' : 'Profile'

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,14,0.78)', backdropFilter: 'blur(3px)', zIndex: 200 }} />

      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(420px, 94vw)', maxHeight: '88vh', background: 'var(--surface)', borderRadius: 20, border: '1px solid rgba(var(--border-rgb),0.2)', boxShadow: '0 30px 90px rgba(0,0,0,0.65)', zIndex: 201, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {step !== 'main' && (
              <span onClick={backToMain} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(var(--border-rgb),0.16)', cursor: 'pointer' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
              </span>
            )}
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{headerTitle}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {step === 'main' && <span style={{ padding: '3px 7px', borderRadius: 6, border: '1px solid rgba(var(--border-rgb),0.18)', fontFamily: MONO, fontSize: 10, color: 'var(--text-faint-dim)' }}>Esc</span>}
            <span onClick={onClose} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(var(--border-rgb),0.16)', cursor: 'pointer' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </span>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>

          {/* ═══ MAIN ═══ */}
          {step === 'main' && (
            <>
              {/* 1 · Copy your npub */}
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-faint-dim)', marginBottom: 12 }}>YOUR NPUB</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 12 }}>
                <div style={{ width: 48, height: 48, borderRadius: 14, background: avatar.grad, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={avatar.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', lineHeight: 1.5 }}>Your public address on Caravel. Share it so others can start a conversation with you.</div>
              </div>
              {nostrNpub
                ? <CopyBtn value={nostrNpub} label={truncNpub(nostrNpub)} mono />
                : <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-faint)' }}>npub unavailable</span>}

              <div style={{ height: 1, background: 'rgba(var(--border-rgb),0.1)', margin: '18px 0 12px' }} />

              {/* 1b · @names you own (on-chain reverse lookup) */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-faint-dim)' }}>YOUR @NAMES</span>
                {names.kind === 'error' && <span onClick={() => setNamesNonce(n => n + 1)} style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-teal-dim)', cursor: 'pointer' }}>Retry</span>}
              </div>
              {names.kind === 'loading' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--text-faint)' }}>
                  <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.25)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />
                  Looking up your names…
                </div>
              )}
              {names.kind === 'empty' && (
                <div style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.5 }}>You haven't registered any @names yet.</div>
              )}
              {names.kind === 'error' && (
                <div style={{ fontSize: 13, color: 'var(--danger-300)', lineHeight: 1.5 }}>{names.msg}</div>
              )}
              {names.kind === 'list' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {names.names.map(n => <CopyBtn key={n.name} value={`@${n.name}`} label={`@${n.name}`} mono />)}
                </div>
              )}

              <div style={{ height: 1, background: 'rgba(var(--border-rgb),0.1)', margin: '18px 0 6px' }} />

              {/* 2 · Show recovery phrase (relocated) */}
              <div onClick={() => setStep('phraseAuth')} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '15px 14px', borderRadius: 12, borderBottom: '1px solid rgba(var(--border-rgb),0.07)', cursor: 'pointer' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2L20 3M17 3h3v3" /></svg>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-body)' }}>Show recovery phrase</div>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>Requires your password</div>
                </div>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint-dim)" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>
              </div>

              {/* 3 · Lock wallet (relocated) */}
              <div onClick={handleLock} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '15px 14px', borderRadius: 12, cursor: 'pointer' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--danger-300)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--danger-300)' }}>Lock wallet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>You will need your password to unlock</div>
                </div>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint-dim)" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>
              </div>
            </>
          )}

          {/* ═══ PASSWORD GATE (preserved) ═══ */}
          {step === 'phraseAuth' && (
            <div style={{ padding: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Confirm your password</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', lineHeight: 1.5, marginBottom: 16 }}>Your 24 words will be shown on screen. Make sure nobody is watching.</div>
              <div style={{ display: 'flex', alignItems: 'center', padding: '13px 15px', borderRadius: 11, background: 'var(--surface-raised)', border: `1px solid ${phraseError ? 'rgba(var(--danger-rgb),0.45)' : 'rgba(var(--border-rgb),0.14)'}`, marginBottom: 10 }}>
                <input type={showPhrasePass ? 'text' : 'password'} value={phrasePass} autoFocus onChange={e => { setPhrasePass(e.target.value); setPhraseError('') }} onKeyDown={e => { if (e.key === 'Enter' && phrasePass) revealPhrase() }} placeholder="Password" style={{ background: 'none', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 15, color: 'var(--text-muted)', letterSpacing: '0.1em', flex: 1 }} />
                <span onClick={() => setShowPhrasePass(v => !v)} style={{ cursor: 'pointer', flexShrink: 0 }}>{showPhrasePass ? eyeOpen('var(--text-faint-dim)') : eyeOff('var(--text-faint-dim)')}</span>
              </div>
              {phraseError && <div style={{ fontSize: 12, color: 'var(--danger-300)', marginBottom: 16 }}>{phraseError}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: phraseError ? 0 : 16 }}>
                <div onClick={backToMain} style={{ flex: '0 0 110px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, border: '1px solid rgba(var(--border-rgb),0.2)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Cancel</div>
                <div onClick={revealPhrase} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 13, borderRadius: 12, background: phrasePass && !phraseLoading ? 'var(--teal-grad)' : 'rgba(16,21,31,0.6)', border: phrasePass && !phraseLoading ? 'none' : '1px solid rgba(var(--border-rgb),0.12)', color: phrasePass && !phraseLoading ? 'var(--ink-on-accent)' : 'var(--text-disabled)', fontSize: 14, fontWeight: 700, cursor: phrasePass && !phraseLoading ? 'pointer' : 'default' }}>
                  {phraseLoading && <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.25)', borderTopColor: 'var(--text-faint-dim)', animation: 'cv-spin 0.8s linear infinite' }} />}
                  {phraseLoading ? 'Verifying…' : 'Reveal phrase'}
                </div>
              </div>
            </div>
          )}

          {/* ═══ 24-WORD REVEAL ═══ */}
          {step === 'phraseWords' && words && (
            <div style={{ padding: 2 }}>
              <div style={{ display: 'flex', gap: 9, padding: '11px 13px', borderRadius: 11, background: 'rgba(var(--warn-rgb),0.05)', border: '1px solid rgba(var(--warn-rgb),0.25)', fontSize: 12, color: 'var(--warn-300)', lineHeight: 1.5, marginBottom: 16 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
                Anyone with these words owns your wallet. Caravel cannot recover them for you.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginBottom: 16 }}>
                {words.map((w, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '8px 9px', borderRadius: 8, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.1)', userSelect: 'all' }}>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted-dim)' }}>{i + 1}</span>
                    <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-body)' }}>{w}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div onClick={() => navigator.clipboard.writeText(words.join(' ')).catch(() => {})} style={{ flex: '0 0 110px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: 13, borderRadius: 12, border: '1px solid rgba(var(--border-rgb),0.2)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>{copyIcon('var(--text-muted)')}Copy</div>
                <div onClick={backToMain} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Hide</div>
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  )
}
