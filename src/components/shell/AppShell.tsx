//   The signed-in shell: the service spine, and the selected service beside it.
//
//   Panes toggle VISIBILITY, not mounting (`display: none`): a hidden service keeps its state — the
//   selected conversation, a half-typed message, the scroll position. Chat is the only service now,
//   so this is one pane; the mechanism stays for the next one.

import { useState } from 'react'
import ChatApp from '../chat/ChatApp'
import ProfilePanel from '../chat/ProfilePanel'
import ServiceNav, { type Service } from './ServiceNav'
import { useChat } from '../../context/ChatContext'
import { useUsageStats } from '../../hooks/useUsageStats'

/** Hidden panes keep their state and their effects; they just stop taking space. */
function Pane({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: show ? 'flex' : 'none', flex: 1, minWidth: 0, height: '100%' }}>
      {children}
    </div>
  )
}

export default function AppShell() {
  const [service, setService] = useState<Service>('chat')
  const [profileOpen, setProfileOpen] = useState(false)
  // The anonymous usage count: sends due notes while chat is unlocked (hooks/useUsageStats).
  useUsageStats(useChat().nostrPubkeyHex)

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--surface-base)', overflow: 'hidden' }}>
      <ServiceNav service={service} onSelect={setService} onProfile={() => setProfileOpen(true)} />

      {/* Chat brings its own sidebar beside the spine. */}
      <Pane show={service === 'chat'}><ChatApp /></Pane>

      {profileOpen && (
        <ProfilePanel onClose={() => setProfileOpen(false)} />
      )}
    </div>
  )
}
