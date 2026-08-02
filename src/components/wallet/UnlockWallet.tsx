//   Unlock flow — idle → unlocking (busy) → wrong-password. Reskinned to the entry-flows design
//   canvas (transcribed element-for-element). Unlock logic is preserved verbatim, including the
//   wrong-password distinction (AES-GCM auth failure → DOMException 'OperationError'); the added
//   touch is the CryptoBusy wait. Restore is delegated to the shared RestoreFlow (debt #8).

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { Logo, CryptoBusy } from '../primitives'
import PasswordField from './PasswordField'
import RestoreFlow from './RestoreFlow'
import { entryCard, pageShell, primaryBtn, disabledBtn } from './entryStyles'

function UnlockScreen({ onRestore }: { onRestore: () => void }) {
  const { unlock } = useWallet()
  const [pass, setPass] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!pass) return
    setError('')
    setLoading(true)
    try {
      await unlock(pass)
      // Success → context sets `wallet` → AppRoute swaps to ChatApp → this unmounts.
    } catch (e) {
      // AES-GCM auth failure (wrong password) throws DOMException 'OperationError'. Any other error
      // (e.g. a derivation bug) gets a distinct message so it isn't silently shown as "wrong password".
      const isWrongPassword = e instanceof DOMException && e.name === 'OperationError'
      setError(isWrongPassword ? 'Incorrect password. Try again.' : `Unlock failed: ${e instanceof Error ? e.message : String(e)}`)
      setLoading(false)
    }
  }

  if (loading) return <CryptoBusy title="Unlocking your wallet" reassurance="Deriving your key from the password. This takes a few seconds by design." />

  const hasError = !!error
  return (
    <div style={entryCard({ padding: '34px 26px 26px', border: `1px solid ${hasError ? 'rgba(var(--danger-rgb),0.3)' : 'rgba(var(--border-rgb),0.16)'}`, textAlign: 'center' })}>
      <div style={{ marginBottom: 16 }}><Logo size={40} flat /></div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: 8 }}>Welcome back</div>
      <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 22 }}>Enter your password to unlock this device.</div>
      <div style={{ marginBottom: hasError ? 9 : 14, textAlign: 'left' }}>
        <PasswordField value={pass} onChange={v => { setPass(v); setError('') }} onKeyDown={e => { if (e.key === 'Enter' && pass) submit() }} invalid={hasError} autoFocus />
      </div>
      {hasError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--danger-300)', marginBottom: 16, textAlign: 'left' }}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.2} strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
          {error}
        </div>
      )}
      <button onClick={submit} disabled={!pass} style={{ ...(pass ? primaryBtn : disabledBtn), padding: 13, fontSize: 15, marginBottom: 16 }}>Unlock</button>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        Forgot password? <span onClick={onRestore} style={{ color: 'var(--teal-500)', fontWeight: 600, cursor: 'pointer' }}>Restore from recovery phrase</span>
      </div>
    </div>
  )
}

export default function UnlockWallet() {
  const [mode, setMode] = useState<'unlock' | 'restore'>('unlock')

  return (
    <div style={pageShell}>
      {mode === 'unlock'
        ? <UnlockScreen onRestore={() => setMode('restore')} />
        : <RestoreFlow onBack={() => setMode('unlock')} />}
    </div>
  )
}
