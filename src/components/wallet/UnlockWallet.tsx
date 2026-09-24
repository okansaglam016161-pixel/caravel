//   Unlock — V3 frames 7a idle, 7b unlocking, 7c wrong password.
//
//   UNLOCK LOGIC IS VERBATIM. `unlock(pass)` decrypts with the password, so a wrong one throws
//   rather than returning anything — and the DOMException 'OperationError' that AES-GCM raises on
//   an auth-tag failure is what distinguishes "wrong password" from a real fault. That distinction
//   is the reason a derivation bug can never be reported as a wrong password, and it is unchanged.
//
//   7b IS INLINE, not a separate card. The frame keeps the lockup and the heading and replaces
//   only the field and the button, so the screen does not appear to navigate somewhere while it
//   waits — it is the same card, thinking.
//
//   Restore is delegated to the shared RestoreFlow.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import CreateWallet from './CreateWallet'
import RestoreFlow from './RestoreFlow'
import {
  EntryButton, EntryCard, EntryError, EntryField, EntryLink, EntrySpinner, EntryTitle, Lockup,
  entryShell,
} from './entryUi'

function UnlockScreen({ onRestore, onCreate }: { onRestore: () => void; onCreate: () => void }) {
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
      // Success → context sets `wallet` → AppRoute swaps to the shell → this unmounts.
    } catch (e) {
      // AES-GCM auth failure (wrong password) throws DOMException 'OperationError'. Any other error
      // (e.g. a derivation bug) gets a distinct message so it isn't silently shown as "wrong
      // password" — a user retyping a correct password forever is the failure this prevents.
      const isWrongPassword = e instanceof DOMException && e.name === 'OperationError'
      setError(isWrongPassword ? 'Incorrect password. Try again.' : `Unlock failed: ${e instanceof Error ? e.message : String(e)}`)
      setLoading(false)
    }
  }

  return (
    <EntryCard centred>
      <Lockup />
      <EntryTitle mt={16}>Welcome back</EntryTitle>

      {/* ══ 7b · UNLOCKING ══ */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 32, marginBottom: 8 }}>
          <EntrySpinner size={16} ring={2.5} />
          <span style={{ fontSize: 13.5, color: 'var(--text-body-dim)' }}>Unlocking</span>
        </div>
      ) : (
        <>
          {/* ══ 7a idle · 7c wrong password ══
              The error is the field's border plus one calm line beneath it — no alert box and no
              red card. A mistyped password is the most ordinary thing that happens on this screen. */}
          <div style={{ textAlign: 'left' }}>
            <EntryField
              type="password" value={pass} autoFocus
              onChange={v => { setPass(v); setError('') }}
              onKeyDown={e => { if (e.key === 'Enter' && pass) void submit() }}
              placeholder="Password" ariaLabel="Password"
              invalid={!!error} mt={24}
            />
            {error && <EntryError>{error}</EntryError>}
          </div>
          <EntryButton tone="primary" mt={12} disabled={!pass} onClick={() => void submit()}>Unlock</EntryButton>
          <EntryLink onClick={onRestore} mt={16}>Forgot password? Restore from recovery phrase</EntryLink>
          {/* THE THIRD DOOR. Until now this screen offered only the two ways back into the wallet
              already stored here, so a user who wanted to start fresh had no route at all short of
              clearing site data. Creating REPLACES that wallet — Caravel keeps one — which is why
              the link says "different" rather than "new", and why the flow it opens carries a line
              saying so. */}
          <EntryLink onClick={onCreate} tone="muted" mt={10}>Set up a different wallet</EntryLink>
        </>
      )}
    </EntryCard>
  )
}

export default function UnlockWallet() {
  const [mode, setMode] = useState<'unlock' | 'restore' | 'create'>('unlock')

  // CreateWallet brings its own `entryShell`, so it is rendered OUTSIDE this one rather than
  // inside it — nesting the shell would double its padding and centring.
  if (mode === 'create') return <CreateWallet onBack={() => setMode('unlock')} />

  return (
    <div style={entryShell}>
      {mode === 'unlock'
        ? <UnlockScreen onRestore={() => setMode('restore')} onCreate={() => setMode('create')} />
        : <RestoreFlow onBack={() => setMode('unlock')} />}
    </div>
  )
}
