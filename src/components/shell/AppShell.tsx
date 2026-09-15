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
import BridgePage from '../bridge/BridgePage'
import ChatApp from '../chat/ChatApp'
import ProfilePanel from '../wallet/ProfilePanel'
import WalletPage from '../wallet/WalletPage'
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
  const [service, setService] = useState<Service>('wallet')
  const [profileOpen, setProfileOpen] = useState(false)

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--surface-base)', overflow: 'hidden' }}>
      <ServiceNav service={service} onSelect={setService} onProfile={() => setProfileOpen(true)} />

      {/* Chat brings its own sidebar. The nested rails are much less of a collision now that the
          spine is 64px, but chat's own header still carries a second Caravel lockup ~64px from
          this one — that goes with the conversation-list reskin, not here. */}
      <Pane show={service === 'wallet'}><WalletPage /></Pane>
      {/* No longer pinned dark. Chat's literals now resolve through the v0.3 role tokens, so it
          follows the app theme like every other service — and so does the wallet modal inside it,
          which used to inherit the pin. */}
      <Pane show={service === 'chat'}><ChatApp onOpenWallet={() => setService('wallet')} /></Pane>
      {/* Bridge holds no state worth preserving — it is an image and four paragraphs — so the
          argument above does not apply to it. It stays a Pane anyway: a third code path in a
          three-line component buys nothing, and the teaser's one asset is lazy. */}
      <Pane show={service === 'bridge'}><BridgePage /></Pane>

      {profileOpen && (
        <ProfilePanel onClose={() => setProfileOpen(false)} />
      )}
    </div>
  )
}
