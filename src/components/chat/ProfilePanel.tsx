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
import { useSapient } from '../../context/SapientContext'
import { SAPIENT_INSTALL_URL, networkLabel } from '../../sapient/provider'
import { MIN_CHAT_PASSWORD, newPasswordProblem } from '../../crypto/chatIdentityStore'

const MONO = 'var(--font-mono)'

const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
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

/**
 * One row: a fixed-width label, a middle-truncated preview, and a copy control. IT COPIES THE FULL
 * VALUE, ALWAYS — a partially-copied address is an unrecoverable payment. Copy state is per row, so
 * two rows can never both claim "Copied".
 */
function IdRow({ label, value, missing, mt }: { label: string; value: string | null; missing: string; mt: number }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    if (!value) return
    void navigator.clipboard?.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  const shown = value ? (value.length > 30 ? `${value.slice(0, 14)}…${value.slice(-10)}` : value) : missing
  return (
    <div
      onClick={value ? copy : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: mt,
        padding: '12px 14px', borderRadius: 10,
        background: 'var(--surface-void)', border: '1px solid var(--border)',
        cursor: value ? 'pointer' : 'default',
      }}
    >
      <span style={{ width: 54, flexShrink: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-muted-dim)' }}>{label}</span>
      <span style={{
        flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11.5,
        color: value ? 'var(--text-body-dim)' : 'var(--text-faint)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{copied ? 'Copied' : shown}</span>
      {value && (copied ? <CheckIcon /> : <CopyIcon />)}
    </div>
  )
}

/** A plain label/value line, for facts that are not copied. */
function FactRow({ label, children, mt }: { label: string; children: React.ReactNode; mt: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: mt, padding: '0 14px', minHeight: 24 }}>
      <span style={{ width: 54, flexShrink: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-muted-dim)' }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-body-dim)', display: 'flex', alignItems: 'center', gap: 10 }}>{children}</span>
    </div>
  )
}

const CARD: React.CSSProperties = { padding: 32 }

const SECTION: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted-dim)' }

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  fontSize: 12.5, fontWeight: 600, color: 'var(--accent-400)', fontFamily: 'inherit',
}

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

/** What the Sapient connection is, in a few words. */
function sapientStatusText(status: string): string {
  switch (status) {
    case 'detecting': return 'Looking for Sapient…'
    case 'missing': return 'Not installed'
    case 'connecting': return 'Connecting… approve in Sapient'
    case 'connected': return 'Connected'
    case 'locked': return 'Locked'
    default: return 'Not connected'
  }
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
  const sapient = useSapient()
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

  const { status } = sapient
  const sessionLive = status === 'connected' || status === 'locked'

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
              <div style={{ ...SECTION, marginTop: 24 }}>Chat</div>
              <IdRow label="npub" value={nostrNpub} missing="npub unavailable" mt={8} />
              <div
                role="button" tabIndex={0}
                onClick={() => setStep('auth')}
                onKeyDown={e => e.key === 'Enter' && setStep('auth')}
                className="cv-quiet-btn"
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                  padding: '12px 14px', borderRadius: 10,
                  border: '1px solid var(--border)', cursor: 'pointer',
                }}
              >
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Show chat backup</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted-dim)' }}>Requires chat password</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
              <div
                role="button" tabIndex={0}
                onClick={() => { setNotice(null); setStep('changePass') }}
                onKeyDown={e => { if (e.key === 'Enter') { setNotice(null); setStep('changePass') } }}
                className="cv-quiet-btn"
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                  padding: '12px 14px', borderRadius: 10,
                  border: '1px solid var(--border)', cursor: 'pointer',
                }}
              >
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Change password</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
              {notice && (
                <div role="status" style={{ fontSize: 12, color: 'var(--positive)', marginTop: 8, padding: '0 14px' }}>{notice}</div>
              )}

              {/* ── Sapient ── */}
              <div style={{ ...SECTION, marginTop: 24 }}>Wallet · Sapient</div>
              <FactRow label="Status" mt={8}>
                <span>{sapientStatusText(status)}</span>
                {status === 'missing' && (
                  <a href={SAPIENT_INSTALL_URL} target="_blank" rel="noopener noreferrer" title="Sapient runs in Chrome, Brave or Edge" style={{ ...linkBtn, textDecoration: 'none' }}>Install</a>
                )}
                {status === 'disconnected' && <button onClick={() => void sapient.connect()} style={linkBtn}>Connect</button>}
                {status === 'locked' && (sapient.unlocking
                  ? <span style={{ color: 'var(--text-muted-dim)' }}>Unlock in Sapient…</span>
                  : <button onClick={() => void sapient.unlock()} style={linkBtn}>Unlock</button>)}
              </FactRow>
              {status === 'locked' && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 4, padding: '0 14px 0 78px', lineHeight: 1.45 }}>
                  Or click the Sapient icon in your browser toolbar.
                </div>
              )}
              {sessionLive && (
                <>
                  <IdRow label="Address" value={sapient.walletAddress} missing={status === 'locked' ? 'Unlock Sapient to see' : 'Reading account…'} mt={8} />
                  <FactRow label="Network" mt={8}>{networkLabel(sapient.network)}</FactRow>
                  <FactRow label="View" mt={4}>
                    {sapient.viewAccess === 'granted' ? 'Granted'
                      : sapient.viewAccess === 'requesting' ? 'Approve in Sapient…'
                      // Not yet read (a locked wallet on load): unknown is not "Off".
                      : sapient.viewAccess === 'unknown' ? (status === 'locked' ? 'Unlock Sapient to see' : 'Checking…')
                      : <>Off {status === 'connected' && <button onClick={() => void sapient.grantViewAccess()} style={linkBtn}>Grant</button>}</>}
                  </FactRow>
                  <PanelButton tone="quiet" mt={12} onClick={() => void sapient.disconnect()}>Disconnect Sapient</PanelButton>
                </>
              )}

              <PanelButton tone="quiet" mt={24} onClick={handleLock}>
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
