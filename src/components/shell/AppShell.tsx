//   The signed-in shell: a permanent service rail, and whichever service is selected.
//
//   ── ALL THREE SERVICES STAY MOUNTED ──────────────────────────────────────────
//
//   Switching services toggles VISIBILITY, not mounting, and that is deliberate on three counts:
//
//     1. Chat would lose its work. ChatApp owns the selected conversation, the composer draft, the
//        reply target and the thread scroll position as local state. Unmounting on every switch
//        throws all of it away — a half-typed message vanishing because someone checked their
//        balance is the kind of bug that makes a shell feel worse than the modal it replaced.
//     2. The wallet would lose a half-filled form for the same reason: a typed recipient, a chosen
//        source, an amount pinned by MAX.
//     3. It costs nothing new. ChatApp is already permanently mounted today — it IS what /app
//        renders — so keeping it alive is the status quo, not an addition.
//
//   NOTHING LOAD-BEARING DEPENDS ON THIS. The relay subscription lives in WalletContext and is
//   started by unlock, not by ChatApp; the settle loop and its poll live there too. Both would
//   survive unmounting. Keeping the trees alive is about not discarding the user's work, and the
//   guarantee that a committed transaction keeps settling across a service switch comes from the
//   context sitting above this component, not from anything here.
//
//   `display: none` rather than conditional rendering is what makes that true without a keep-alive
//   abstraction. The hidden subtree keeps its state and its effects, and pays no layout or paint.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { avatarFor } from '../chat/chatDisplay'
import ChatApp from '../chat/ChatApp'
import DarkPin from './DarkPin'
import ProfilePanel from '../wallet/ProfilePanel'
import WalletPage from '../wallet/WalletPage'
import NamePage from './NamePage'
import ServiceNav, { type Service } from './ServiceNav'

/** Hidden panes keep their state and their effects; they just stop taking space. */
function Pane({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: show ? 'flex' : 'none', flex: 1, minWidth: 0, height: '100%' }}>
      {children}
    </div>
  )
}

export default function AppShell() {
  const { nostrPubkeyHex } = useWallet()
  const [service, setService] = useState<Service>('wallet')
  const [profileOpen, setProfileOpen] = useState(false)

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--surface-base)', overflow: 'hidden' }}>
      <ServiceNav service={service} onSelect={setService} onProfile={() => setProfileOpen(true)} />

      {/* Chat brings its own sidebar. Nested rails are accepted for now — chat is wired in as it
          stands and gets its own design pass later; stripping its header now would mean editing
          2,300 lines we are otherwise not touching. */}
      <Pane show={service === 'wallet'}><WalletPage /></Pane>
      {/* Pinned dark until the chat redesign — see DarkPin. */}
      <Pane show={service === 'chat'}>
        <DarkPin style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}><ChatApp /></DarkPin>
      </Pane>
      <Pane show={service === 'name'}><NamePage /></Pane>

      {profileOpen && (
        <ProfilePanel onClose={() => setProfileOpen(false)} avatar={avatarFor(nostrPubkeyHex ?? '')} />
      )}
    </div>
  )
}
