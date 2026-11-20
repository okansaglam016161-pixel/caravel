// "Connect a wallet": the Sapient extension in this browser, or Sapient for Android on a phone
// (WalletConnect: a QR code to scan, then approval on the phone). Opened by every Connect button
// through SapientContext.openChooser, which skips it when there is no choice to make (only the
// extension, or inside Tari Universe). Mounted once, in the signed-in shell.

import { useEffect } from 'react'
import { useSapient } from '../../context/SapientContext'
import { SAPIENT_INSTALL_URL } from '../../sapient/provider'
import { ListCard, NavRow } from './listRows'

export default function ConnectChooser() {
  const { chooserOpen, closeChooser, connect, options } = useSapient()

  useEffect(() => {
    if (!chooserOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeChooser() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chooserOpen, closeChooser])

  if (!chooserOpen) return null
  return (
    <>
      <div onClick={closeChooser} style={{ position: 'fixed', inset: 0, background: 'rgba(6,12,21,0.72)', backdropFilter: 'blur(3px)', zIndex: 200 }} />
      <div role="dialog" aria-modal="true" aria-label="Connect a wallet" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: 'min(400px, 94vw)', zIndex: 201, padding: 28, boxSizing: 'border-box',
        background: 'var(--surface)', borderRadius: 18, border: '1px solid var(--border)', boxShadow: 'var(--e3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1, fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>Connect a wallet</span>
          <button onClick={closeChooser} aria-label="Close" className="cv-icon-btn" style={{
            cursor: 'pointer', width: 28, height: 28, borderRadius: 8, padding: 0, flexShrink: 0,
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginTop: 6, lineHeight: 1.5 }}>
          Payments go through Sapient, the Tari wallet. Caravel never holds your funds or keys.
        </div>
        <ListCard mt={18}>
          {options.extension
            ? <NavRow first title="Sapient extension" hint="In this browser" onOpen={() => void connect('extension')} />
            : <NavRow first title="Sapient extension" hint="Not installed: get it" onOpen={() => { window.open(SAPIENT_INSTALL_URL, '_blank', 'noopener,noreferrer') }} />}
          {options.phone && (
            <NavRow title="Sapient for Android" hint="Scan a QR code with your phone" onOpen={() => void connect('phone')} />
          )}
        </ListCard>
        {options.phone && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 12, lineHeight: 1.5 }}>
            Phone connections go through the WalletConnect relay, which sees your IP address and timing, not your messages.
          </div>
        )}
      </div>
    </>
  )
}
