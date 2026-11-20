// THE SAPIENT CARD — the connection's facts, drawn the same in the Profile panel and in the wallet
// pill's menu (both through listRows).
//
//   connected / locked   Status (unless the caller hides it while connected), Address (copy),
//                        Network, whatever `extraRows` the caller adds (the menu's balances), View
//                        access (Grant when off), and a quiet Disconnect at the foot. Locked keeps its
//                        Unlock link and the toolbar hint; values it cannot read say "Unlock Sapient to
//                        see" rather than spinning.
//   anything else        ONE row: what is going on, and the way forward (Connect / Install).

import type { ReactNode } from 'react'
import { useSapient } from '../../context/SapientContext'
import { SAPIENT_INSTALL_URL, networkLabel } from '../../sapient/provider'
import { CopyRow, FactRow, ListCard, QuietFootAction } from './listRows'
import { linkBtn } from './listRowStyles'

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

export default function SapientCard({ hideStatusWhenConnected = false, extraRows, onDisconnect, mt }: {
  /** The menu sits under a pill that already says it is connected. */
  hideStatusWhenConnected?: boolean
  /** Rows between Network and View access (the menu's balances). */
  extraRows?: ReactNode
  /** Runs after Sapient is told to disconnect (the menu closes itself). */
  onDisconnect?: () => void
  mt?: number
}) {
  const sapient = useSapient()
  const { status } = sapient
  const sessionLive = status === 'connected' || status === 'locked'

  if (!sessionLive) {
    return (
      <ListCard mt={mt}>
        <FactRow first label="Status">
          <span>{sapientStatusText(status)}</span>
          {status === 'missing' && (
            <a href={SAPIENT_INSTALL_URL} target="_blank" rel="noopener noreferrer" title="Sapient runs in Chrome, Brave or Edge" style={{ ...linkBtn, textDecoration: 'none' }}>Install</a>
          )}
          {status === 'disconnected' && <button onClick={() => sapient.openChooser()} style={linkBtn}>Connect</button>}
        </FactRow>
      </ListCard>
    )
  }

  const onPhone = sapient.transport === 'phone'
  const showStatus = status === 'locked' || !hideStatusWhenConnected
  return (
    <ListCard mt={mt}>
      {showStatus && (
        <FactRow first label="Status"
          note={status === 'locked' ? (onPhone ? 'Unlock Sapient on your phone, then Check.' : 'Or click the Sapient icon in your browser toolbar.') : undefined}>
          <span>{sapientStatusText(status)}</span>
          {status === 'locked' && (sapient.unlocking
            ? <span style={{ color: 'var(--text-muted-dim)' }}>Unlock in Sapient…</span>
            : <button onClick={() => void sapient.unlock()} style={linkBtn}>{onPhone ? 'Check' : 'Unlock'}</button>)}
        </FactRow>
      )}
      <CopyRow first={!showStatus} label="Address" value={sapient.walletAddress}
        missing={status === 'locked' ? (onPhone ? 'Unlock Sapient on your phone to see' : 'Unlock Sapient to see') : 'Reading account…'} />
      <FactRow label="Wallet">{onPhone ? 'Sapient on your phone' : sapient.transport === 'embedded' ? 'Tari Universe' : 'Sapient extension'}</FactRow>
      <FactRow label="Network">{networkLabel(sapient.network)}</FactRow>
      {extraRows}
      <FactRow label="View access">
        {sapient.viewAccess === 'granted' ? 'Granted'
          : sapient.viewAccess === 'requesting' ? 'Approve in Sapient…'
          // Not yet read (a locked wallet on load): unknown is not "Off".
          : sapient.viewAccess === 'unknown' ? (status === 'locked' ? 'Unlock Sapient to see' : 'Checking…')
          : <>Off {status === 'connected' && <button onClick={() => void sapient.grantViewAccess()} style={linkBtn}>Grant</button>}</>}
      </FactRow>
      {/* A quiet text action, not a button: disconnecting is rare and undoable (Connect). */}
      <QuietFootAction onClick={() => { onDisconnect?.(); void sapient.disconnect() }}>Disconnect</QuietFootAction>
    </ListCard>
  )
}
