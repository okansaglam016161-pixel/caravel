//   Optional "Register ONS name" action (post-setup). Lets a funded Caravel user claim an @name
//   that resolves to their Nostr pubkey, so others can find them by name in compose-new. Costs a
//   small fee and needs a funded wallet. Availability is a courtesy preview — the contract is the
//   final authority (a name free at preview can be taken by the time you submit).

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { validateOnsName, checkOnsAvailable, registerOnsName, toOnsName } from '../../crypto/ons'

type Status = 'idle' | 'checking' | 'available' | 'taken' | 'registering' | 'done' | 'error'

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
    setMsg(r.available ? `"@${clean}" looks available.` : `"@${clean}" is already taken.`)
  }

  async function register() {
    if (!canAct || !wallet || !address || !nostrNpub) return
    reset('registering')
    setMsg('Signing and submitting (this costs a small fee)…')
    const r = await registerOnsName(wallet, address, clean, nostrNpub)
    if (!r.ok) { setStatus('error'); setMsg(r.error ?? 'Registration failed.'); return }
    setStatus('done')
    setTxId(r.txId ?? null)
    setMsg(`Registered! You're now findable as @${clean}. Fee: ${r.fee ?? '?'} µtTARI.`)
  }

  const msgColor =
    status === 'error' || status === 'taken' ? '#FF6B6B'
    : status === 'available' || status === 'done' ? '#34E5D0'
    : '#8A97B4'

  return (
    <div style={{ border: '1px solid rgba(120,150,210,0.18)', borderRadius: 12, padding: 16, background: '#10151F' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#F2F5FB', marginBottom: 4 }}>Register an ONS name</div>
      <div style={{ fontSize: 12.5, color: '#8A97B4', lineHeight: 1.5, marginBottom: 12 }}>
        Let people find you by <strong style={{ color: '#B9C4DC' }}>@name</strong> instead of your key. Optional —
        it costs a small on-chain fee and needs a funded wallet. Uniqueness is enforced on-chain.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0B0F17', border: `1px solid ${policyErr ? 'rgba(255,107,107,0.5)' : 'rgba(120,150,210,0.25)'}`, borderRadius: 9, padding: '9px 11px' }}>
        <span style={{ color: '#55617D', fontFamily: "'IBM Plex Mono', monospace", fontSize: 14 }}>@</span>
        <input
          value={name}
          onChange={e => { setName(e.target.value); if (status !== 'idle') reset('idle') }}
          placeholder="yourname"
          spellCheck={false}
          disabled={status === 'registering' || status === 'done'}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#E4EAF4', fontFamily: "'IBM Plex Mono', monospace", fontSize: 14 }}
        />
      </div>

      {(policyErr || msg) && (
        <div style={{ marginTop: 9, fontSize: 12, color: policyErr ? '#FF6B6B' : msgColor, fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.5, wordBreak: 'break-word' }}>
          {policyErr ?? msg}
          {txId && (
            <div style={{ marginTop: 4, color: '#55617D' }}>tx {txId.slice(0, 10)}…{txId.slice(-6)}</div>
          )}
        </div>
      )}

      {status !== 'done' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
          <button
            onClick={check}
            disabled={!clean || !!policyErr || busy}
            style={btn(!clean || !!policyErr || busy, false)}
          >
            {status === 'checking' ? 'Checking…' : 'Check availability'}
          </button>
          <button
            onClick={register}
            disabled={!canAct || busy}
            style={btn(!canAct || busy, true)}
          >
            {status === 'registering' ? 'Registering…' : 'Register'}
          </button>
        </div>
      )}

      {status === 'done' && (
        <button onClick={() => { setName(''); reset('idle') }} style={{ ...btn(false, false), marginTop: 13 }}>
          Register another
        </button>
      )}

      {!nostrNpub && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: '#55617D' }}>Unlock your wallet to register a name.</div>
      )}
    </div>
  )
}

function btn(disabled: boolean, primary: boolean): React.CSSProperties {
  return {
    padding: '9px 16px', borderRadius: 9, border: primary ? 'none' : '1px solid rgba(120,150,210,0.25)',
    background: disabled ? 'rgba(120,150,210,0.12)' : primary ? 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))' : 'transparent',
    color: disabled ? '#55617D' : primary ? 'var(--accOn,#04120F)' : '#B9C4DC',
    fontSize: 12.5, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
  }
}
