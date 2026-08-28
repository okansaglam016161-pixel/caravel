//   Unlock flow — idle → unlocking (busy) → wrong-password. Reskinned to the entry-flows design
//   canvas (transcribed element-for-element). Unlock logic is preserved verbatim, including the
//   wrong-password distinction (AES-GCM auth failure → DOMException 'OperationError'); the added
//   touch is the CryptoBusy wait. Restore is delegated to the shared RestoreFlow (debt #8).

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { CryptoBusy } from '../primitives'
import PasswordField from './PasswordField'
import RestoreFlow from './RestoreFlow'
import { entryCard, logoTile, pageShell, primaryBtn, disabledBtn } from './entryStyles'

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
    <div style={entryCard({ padding: 22, textAlign: 'center', ...(hasError ? { border: '1px solid var(--danger-500)' } : {}) })}>
      {/* The light mark on its accent tile — one lockup, both themes. */}
      <span style={{ ...logoTile, width: 38, height: 38, borderRadius: 11 }}>
        <img src="/logo-light.png" alt="" aria-hidden="true" style={{ height: 20, width: 'auto', display: 'block' }} />
      </span>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginTop: 10 }}>Welcome back</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 3, marginBottom: 12 }}>Enter your password to unlock this device.</div>
      <div style={{ marginBottom: hasError ? 9 : 10, textAlign: 'left' }}>
        <PasswordField value={pass} onChange={v => { setPass(v); setError('') }} onKeyDown={e => { if (e.key === 'Enter' && pass) submit() }} invalid={hasError} autoFocus />
      </div>
      {hasError && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 10,
          background: 'rgba(var(--danger-rgb),0.12)', color: 'var(--danger-500)',
          fontSize: 12, fontWeight: 500, lineHeight: 1.5, textAlign: 'left',
        }}>{error}</div>
      )}
      <button onClick={submit} disabled={!pass} style={{ ...(pass ? primaryBtn : disabledBtn), marginBottom: 12 }}>Unlock</button>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        Forgot password? <span onClick={onRestore} style={{ color: 'var(--accent-ink)', fontWeight: 600, cursor: 'pointer' }}>Restore from recovery phrase</span>
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
