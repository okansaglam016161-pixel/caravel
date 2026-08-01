//   "Register an @name" — presentation transcribed element-for-element from the design file's
//   "Overview · ONS register" (8 states). All logic (status, check, register, canAct, policyErr,
//   busy) preserved verbatim; only the JSX mirrors the design markup (live border colour as you type).

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { validateOnsName, checkOnsAvailable, registerOnsName, toOnsName } from '../../crypto/ons'

type Status = 'idle' | 'checking' | 'available' | 'taken' | 'registering' | 'done' | 'error'

const CARD = { padding: 18, borderRadius: 14, background: 'var(--surface-raised)' } as const
const TITLE = { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 } as const
const DESC = { fontSize: 13, marginBottom: 14, lineHeight: 1.5 } as const
const FIELD = { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 11, background: 'var(--surface-base)', marginBottom: 12 } as const
const AT = { fontFamily: 'var(--font-mono)', fontSize: 15 } as const
const NAMEINPUT: React.CSSProperties = { flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 14 }
const BTN = { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, borderRadius: 11, fontSize: 14, fontWeight: 700 } as const
const DISABLED_BTN = { ...BTN, background: 'rgba(16,21,31,0.6)', border: '1px solid rgba(var(--border-rgb),0.12)', color: 'var(--text-disabled)' } as const

export default function OnsRegisterPanel() {
  const { wallet, address, nostrNpub } = useWallet()
  const [name, setName] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const [txId, setTxId] = useState<string | null>(null)

  const clean = toOnsName(name)
  const policyErr = clean ? validateOnsName(clean) : null
  const canAct = !!wallet && !!address && !!nostrNpub && !!clean && !policyErr
  const busy = status === 'checking' || status === 'registering'

  function reset(next: Status = 'idle') { setStatus(next); setMsg(null); if (next === 'idle') setTxId(null) }

  async function check() {
    if (!clean || policyErr) return
    reset('checking')
    const r = await checkOnsAvailable(clean)
    if (r.error) { setStatus('error'); setMsg(r.error); return }
    setStatus(r.available ? 'available' : 'taken')
    setMsg(r.available ? `@${clean} is available.` : `@${clean} is already registered.`)
  }

  async function register() {
    if (!canAct || !wallet || !address || !nostrNpub) return
    reset('registering')
    setMsg(`Writing @${clean} to the Tari network.`)
    const r = await registerOnsName(wallet, address, clean, nostrNpub)
    if (!r.ok) { setStatus('error'); setMsg(r.error ?? 'Registration failed.'); return }
    setStatus('done')
    setTxId(r.txId ?? null)
    setMsg('People can now find you by name.')
  }

  const spinner = (
    <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.2)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />
  )

  // ── DONE (check circle header + result row @name / npub) ──
  if (status === 'done') {
    return (
      <div style={{ ...CARD, border: '1px solid rgba(var(--teal-500-rgb),0.3)', background: 'rgba(var(--teal-500-rgb),0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: 'rgba(var(--teal-500-rgb),0.16)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-bright)' }}>@{clean} is yours</span>
        </div>
        <div style={{ ...DESC, color: 'var(--text-teal-label)' }}>People can now find you by name.</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderRadius: 11, background: 'rgba(10,14,23,0.6)', border: '1px solid rgba(var(--teal-500-rgb),0.22)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-bright)' }}>@{clean}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-teal-dim)' }}>{txId ? `${txId.slice(0, 6)}…${txId.slice(-4)}` : nostrNpub ? `${nostrNpub.slice(0, 9)}…${nostrNpub.slice(-4)}` : ''}</span>
        </div>
        <div onClick={() => { setName(''); reset('idle') }} style={{ ...BTN, marginTop: 12, background: 'var(--surface-inset)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', cursor: 'pointer' }}>Register another</div>
      </div>
    )
  }

  // ── ERROR (red circle-alert) ──
  if (status === 'error') {
    return (
      <div style={{ ...CARD, border: '1px solid rgba(var(--danger-rgb),0.28)', background: 'rgba(var(--danger-rgb),0.04)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger-300)' }}>Registration failed</span>
        </div>
        <div style={{ ...DESC, color: 'var(--text-muted-dim)' }}>{msg ?? 'The transaction was rejected. No name was registered and no fee was taken.'}</div>
        <div onClick={() => reset('idle')} style={{ ...BTN, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', color: 'var(--danger-300)', cursor: 'pointer' }}>Try again</div>
      </div>
    )
  }

  // ── Live field border + accent per input status (idle/checking/available/taken/invalid/registering) ──
  const isInvalid = !!policyErr
  const isAvail = status === 'available'
  const isTaken = status === 'taken'
  const border = isTaken ? 'rgba(var(--danger-rgb),0.5)'
    : isInvalid ? 'rgba(var(--warn-rgb),0.5)'
    : isAvail ? 'rgba(var(--teal-500-rgb),0.5)'
    : status === 'checking' ? 'rgba(var(--border-rgb),0.24)'
    : status === 'registering' ? 'rgba(var(--border-rgb),0.12)'
    : 'rgba(var(--border-rgb),0.14)'
  const atColor = isTaken ? 'var(--danger-300)' : isInvalid ? 'var(--warn-300)' : isAvail ? 'var(--teal-500)' : status === 'registering' ? 'var(--text-teal-dim)' : status === 'checking' ? 'var(--teal-300)' : 'var(--text-faint-dim)'
  const nameColor = status === 'registering' ? 'var(--text-muted-dim)' : (isAvail ? 'var(--text-bright)' : clean ? 'var(--text-body)' : 'var(--text-faint-dim)')
  const cardBorder = isTaken ? 'rgba(var(--danger-rgb),0.26)' : isInvalid ? 'rgba(var(--warn-rgb),0.28)' : (isAvail || status === 'registering') ? 'rgba(var(--teal-500-rgb),0.24)' : 'rgba(var(--border-rgb),0.14)'
  const descColor = isTaken ? 'var(--danger-300)' : isInvalid ? 'var(--warn-300)' : isAvail ? 'var(--teal-300)' : 'var(--text-muted-dim)'
  const descText = msg ?? (policyErr ? 'Lowercase letters, numbers and underscores. 3 to 20 characters.'
    : status === 'checking' ? 'Checking availability on the Tari network.'
    : status === 'registering' ? `Writing @${clean} to the Tari network.`
    : 'On chain, yours. Resolves to your messaging key.')

  return (
    <div style={{ ...CARD, border: `1px solid ${cardBorder}` }}>
      <div style={TITLE}>Register an @name</div>
      <div style={{ ...DESC, color: descColor }}>{descText}</div>
      <div style={{ ...FIELD, border: `1px solid ${border}`, ...(isAvail ? { boxShadow: '0 0 0 3px rgba(var(--teal-500-rgb),0.08)' } : {}) }}>
        <span style={{ ...AT, color: atColor }}>@</span>
        <input
          value={name}
          onChange={e => { setName(e.target.value); if (status !== 'idle') reset('idle') }}
          placeholder="yourname"
          spellCheck={false}
          disabled={busy}
          style={{ ...NAMEINPUT, color: nameColor }}
        />
        {isAvail && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
        {isTaken && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>}
        {status === 'checking' && spinner}
      </div>

      {status === 'registering'
        ? <div style={{ ...BTN, gap: 9, background: 'var(--surface-inset)', border: '1px solid rgba(var(--teal-500-rgb),0.2)', color: 'var(--teal-300)' }}>
            <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.8s linear infinite' }} />Registering…
          </div>
        : isAvail
          ? <div onClick={register} style={{ ...BTN, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', cursor: 'pointer' }}>Register @{clean}</div>
          : canAct
            ? <div style={{ display: 'flex', gap: 8 }}>
                <div onClick={check} style={{ ...BTN, flex: 1, background: 'var(--surface-inset)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', cursor: 'pointer' }}>Check</div>
                <div onClick={register} style={{ ...BTN, flex: 1, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', cursor: 'pointer' }}>Register</div>
              </div>
            : <div style={DISABLED_BTN}>Register</div>}

      {!nostrNpub && <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-faint-dim)' }}>Unlock your wallet to register a name.</div>}
    </div>
  )
}
