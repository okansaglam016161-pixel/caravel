//   ProfilePanel — who you are in Caravel: the chat identity, and the Sapient wallet paying for it.
//   Opened from the service rail's @ tile.
//
//   CHAT IDENTITY. The npub (what you give people so they can message you), the backup behind the
//   chat password, and Lock.
//
//   SAPIENT. Caravel holds no wallet of its own: payments go through Sapient, the browser wallet. This
//   shows what the connection is (address, network, view access) and lets you connect or disconnect.
//   The same facts sit in the chat sidebar's wallet pill; this is the one place they sit next to the
//   identity they pay for.
//
//   ── THE PASSWORD GATE IS LOAD-BEARING ────────────────────────────────────────
//
//     main        → the npub, Sapient, and the door to the backup
//     auth        → the chat password. `revealChatBackup(password)` DECRYPTS the chat record with it,
//                   so a wrong password cannot produce a backup — the gate is cryptographic.
//     backup      → the nsec (and the 12 words when there are any), reachable ONLY from that decrypt
//
//   `backup` is assigned in exactly one place, after `revealChatBackup` resolves, and the reveal
//   renders on `step === 'backup' && backup`. Going back drops it. Keep it that way.
//
//   CHANGE PASSWORD re-encrypts the chat record (crypto/chatIdentityStore.changeChatPassword): the
//   current password must open it first, and the keys inside stay the same, so history stays readable
//   and the session carries on. Same rule as creating an identity (newPasswordProblem).

import { useEffect, useState } from 'react'
import { useChat, type ChatBackup } from '../../context/ChatContext'
import { MIN_CHAT_PASSWORD, newPasswordProblem } from '../../crypto/chatIdentityStore'
import { CopyRow, ListCard, NavRow } from './listRows'
import SapientCard from './SapientCard'

const MONO = 'var(--font-mono)'

const eyeOpen = (c: string) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>)
const eyeOff = (c: string) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></svg>)

const CARD: React.CSSProperties = { padding: 32 }

/** A section heading. Every section — and the Lock button after them — starts SECTION_GAP below the last. */
const SECTION_GAP = 24
const SECTION: React.CSSProperties = { marginTop: SECTION_GAP, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted-dim)' }

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

/** The full-width action at the foot of a card. */
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

/** A password input with its show/hide toggle — the shape the backup gate uses. */
function PassField({ label, value, onChange, onEnter, invalid, autoFocus, mt }: {
  label: string; value: string; onChange: (v: string) => void; onEnter?: () => void; invalid?: boolean; autoFocus?: boolean; mt: number
}) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ marginTop: mt }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-body-dim)' }}>{label}</div>
      <div className="cv-field" style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
        border: `1px solid ${invalid ? 'var(--danger-500)' : 'var(--border-strong)'}`,
        borderRadius: 10, padding: '12px 14px',
      }}>
        <input
          type={show ? 'text' : 'password'} value={value} autoFocus={autoFocus}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onEnter?.() }}
          aria-label={label}
          style={{
            flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', padding: 0,
            fontFamily: MONO, fontSize: 13.5, color: 'var(--text-primary)',
          }}
        />
        <span
          role="button" tabIndex={0} aria-label={show ? 'Hide password' : 'Show password'}
          onClick={() => setShow(v => !v)}
          onKeyDown={e => e.key === 'Enter' && setShow(v => !v)}
          style={{ cursor: 'pointer', flexShrink: 0, display: 'flex' }}
        >{show ? eyeOpen('var(--text-faint-dim)') : eyeOff('var(--text-faint-dim)')}</span>
      </div>
    </div>
  )
}

type Step = 'main' | 'auth' | 'backup' | 'changePass'

export default function ProfilePanel({ onClose }: { onClose: () => void }) {
  const { nostrNpub, revealChatBackup, changeChatPassword, lockChat } = useChat()
  const [step, setStep] = useState<Step>('main')
  const [backup, setBackup] = useState<ChatBackup | null>(null)
  const [pass, setPass] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [passError, setPassError] = useState('')
  const [loading, setLoading] = useState(false)
  // Change password: all three fields leave state with the screen, like the backup does.
  const [curPass, setCurPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [newPass2, setNewPass2] = useState('')
  const [changeError, setChangeError] = useState('')
  const [changing, setChanging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The gate: a wrong password throws from the decrypt, so there is nothing to compare or invert.
  async function reveal() {
    if (!pass) return
    setPassError('')
    setLoading(true)
    try {
      setBackup(await revealChatBackup(pass))
      setStep('backup')
    } catch (e) {
      const isWrongPass = (e instanceof DOMException && e.name === 'OperationError') || (e instanceof Error && e.message === 'Wrong password.')
      setPassError(isWrongPass ? 'Incorrect password. Try again.' : `Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  async function submitChange() {
    if (changing || !curPass) return
    const problem = newPasswordProblem(newPass, newPass2)
    if (problem) { setChangeError(problem); return }
    setChangeError('')
    setChanging(true)
    try {
      await changeChatPassword(curPass, newPass)
      backToMain()
      setNotice('Chat password changed.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setChangeError(msg === 'Wrong password.' ? 'Incorrect password.' : msg)
    } finally {
      setChanging(false)
    }
  }

  function backToMain() {
    setCurPass('')
    setNewPass('')
    setNewPass2('')
    setChangeError('')
    setStep('main')
    setPass('')
    setPassError('')
    setBackup(null)   // the backup leaves memory with the screen
    setShowPass(false)
  }

  function handleLock() { lockChat(); onClose() }


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

          {step === 'main' && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                  background: 'var(--accent-wash)', color: 'var(--accent-ink)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 600,
                }}>@</span>
                <span style={{ flex: 1, fontSize: 15.5, fontWeight: 600, color: 'var(--text-primary)' }}>Profile</span>
                <CloseButton onClose={onClose} />
              </div>

              {/* ── Chat identity ── */}
              <div style={SECTION}>Chat</div>
              <ListCard>
                <CopyRow first label="npub" value={nostrNpub} missing="npub unavailable" />
                <NavRow title="Show chat backup" hint="Requires chat password" onOpen={() => { setNotice(null); setStep('auth') }} />
                <NavRow title="Change password" onOpen={() => { setNotice(null); setStep('changePass') }} />
              </ListCard>
              {notice && (
                <div role="status" style={{ fontSize: 12, color: 'var(--positive)', marginTop: 8, paddingLeft: 14 }}>{notice}</div>
              )}

              {/* ── Sapient ── */}
              <div style={SECTION}>Wallet · Sapient</div>
              <SapientCard />

              <PanelButton tone="quiet" mt={SECTION_GAP} onClick={handleLock}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                Lock
              </PanelButton>
            </div>
          )}

          {/* ── CHANGE PASSWORD ── */}
          {step === 'changePass' && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1, fontSize: 21, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Change password</span>
                <CloseButton onClose={onClose} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginTop: 6, lineHeight: 1.5 }}>
                Unlocks Chat on this device. Your messages and backup stay the same.
              </div>

              <PassField label="Current password" value={curPass} autoFocus mt={24}
                onChange={v => { setCurPass(v); setChangeError('') }} invalid={changeError === 'Incorrect password.'} />
              <PassField label="New password" value={newPass} mt={14}
                onChange={v => { setNewPass(v); setChangeError('') }} />
              <PassField label="Confirm new password" value={newPass2} mt={14}
                onChange={v => { setNewPass2(v); setChangeError('') }} onEnter={() => void submitChange()}
                invalid={!!newPass2 && newPass2 !== newPass} />
              <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 8 }}>At least {MIN_CHAT_PASSWORD} characters.</div>
              {changeError && (
                <div role="alert" style={{ fontSize: 12, color: 'var(--danger-300)', marginTop: 10, lineHeight: 1.5 }}>{changeError}</div>
              )}

              <PanelButton tone="primary" mt={24} disabled={!curPass || !newPass || !newPass2 || changing} onClick={() => void submitChange()}>
                {changing && <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#FFFFFF', animation: 'cv-spin 0.8s linear infinite' }} />}
                {changing ? 'Changing…' : 'Change password'}
              </PanelButton>
              <PanelButton tone="quiet" mt={10} onClick={backToMain}>Cancel</PanelButton>
            </div>
          )}

          {/* ── THE GATE ── */}
          {step === 'auth' && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1, fontSize: 21, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Chat backup</span>
                <CloseButton onClose={onClose} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginTop: 6 }}>
                Enter your chat password to reveal your nsec and backup phrase.
              </div>

              <div style={{ marginTop: 28 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-body-dim)' }}>Password</div>
                <div className="cv-field" style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                  border: `1px solid ${passError ? 'var(--danger-500)' : 'var(--border-strong)'}`,
                  borderRadius: 10, padding: '12px 14px',
                }}>
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={pass} autoFocus
                    onChange={e => { setPass(e.target.value); setPassError('') }}
                    onKeyDown={e => { if (e.key === 'Enter' && pass) void reveal() }}
                    placeholder="Your password" aria-label="Password"
                    style={{
                      flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', padding: 0,
                      fontFamily: MONO, fontSize: 13.5, color: 'var(--text-primary)',
                    }}
                  />
                  <span
                    role="button" tabIndex={0} aria-label={showPass ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPass(v => !v)}
                    onKeyDown={e => e.key === 'Enter' && setShowPass(v => !v)}
                    style={{ cursor: 'pointer', flexShrink: 0, display: 'flex' }}
                  >{showPass ? eyeOpen('var(--text-faint-dim)') : eyeOff('var(--text-faint-dim)')}</span>
                </div>
                {passError && (
                  <div style={{ fontSize: 12, color: 'var(--danger-300)', marginTop: 10, lineHeight: 1.5 }}>{passError}</div>
                )}
              </div>

              <PanelButton tone="primary" mt={24} disabled={!pass || loading} onClick={() => void reveal()}>
                {loading && <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#FFFFFF', animation: 'cv-spin 0.8s linear infinite' }} />}
                {loading ? 'Verifying…' : 'Reveal backup'}
              </PanelButton>
              <PanelButton tone="quiet" mt={10} onClick={backToMain}>Cancel</PanelButton>
            </div>
          )}

          {/* ── REVEALED — reachable only from a successful decrypt ── */}
          {step === 'backup' && backup && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1, fontSize: 21, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Chat backup</span>
                <CloseButton onClose={onClose} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginTop: 6 }}>
                Either of these restores your chat identity. Neither restores your wallet.
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted-dim)', marginTop: 20 }}>nsec</div>
              <div style={{
                marginTop: 6, padding: '10px 12px', borderRadius: 8,
                background: 'var(--surface-void)', border: '1px solid var(--border)',
                fontFamily: MONO, fontSize: 11.5, color: 'var(--text-primary)', wordBreak: 'break-all', userSelect: 'all',
              }}>{backup.nsec}</div>

              {backup.phrase && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted-dim)', marginTop: 16 }}>Backup phrase</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 6 }}>
                    {backup.phrase.split(' ').map((w, i) => (
                      <span key={i} style={{
                        padding: '7px 10px', borderRadius: 8,
                        background: 'var(--surface-void)', border: '1px solid var(--border)',
                        fontFamily: MONO, fontSize: 11, color: 'var(--text-primary)', userSelect: 'all',
                      }}>
                        <span style={{ color: 'var(--text-muted-dim)' }}>{i + 1}</span> {w}
                      </span>
                    ))}
                  </div>
                </>
              )}

              <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', lineHeight: 1.55, textAlign: 'center', marginTop: 16, textWrap: 'pretty' }}>
                Anyone with these can read and send your messages. Keep them offline; Caravel cannot recover them for you.
              </div>

              <PanelButton tone="quiet" mt={16} onClick={backToMain}>Hide backup</PanelButton>
            </div>
          )}

        </div>
      </div>
    </>
  )
}
