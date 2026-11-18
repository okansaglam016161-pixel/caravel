//   The service spine — the app's permanent left edge: the mark (home), the services, and the @
//   profile tile.
//
//   Built to the V3 design's shell: 64px wide, icon-only, labels as tooltips (`title` +
//   `aria-label`). Chat brings its own sidebar, so the spine stays narrow. It sits on navy in both
//   themes: `data-theme="dark"` makes everything inside resolve the dark ramp.
//
//   Chat is the only service now (the built-in wallet is gone; payments go through Sapient). The
//   spine stays for the way home and the profile, and so a later service appends a row rather than
//   inventing a shell.
//
//   THE MARK IS THE WAY HOME, AND NOTHING ELSE. Locking is the profile panel's Lock button: a logo
//   click means "go home", never "log out". No aria-current on it — it leaves the shell.
//
//   NO BORDER ON THE RIGHT EDGE, per the design: the pane beside it draws its own.

import { useNavigate } from 'react-router-dom'
import { useChat } from '../../context/ChatContext'
import LogoTile from '../primitives/LogoTile'

// ── WHAT EARNS A ROW ─────────────────────────────────────────────────────────
//
// A row is for a destination you open rather than a property of something else, and for one you
// can actually use: a rail row standing in for work not yet built is a door that opens onto a
// description of a door.
//
// ORDER IS RENDER ORDER — the map below walks this array — so a new service appends rather than
// displacing the two anyone already has muscle memory for.
//
// The two tables under it are Record<Service, …>, so adding a member here is a type error until
// both are filled in.
const SERVICES = ['chat'] as const

/** Type-only export: keeps this file a component module, which is what fast refresh wants. */
export type Service = (typeof SERVICES)[number]

/** The tooltip text, and the accessible name. Both, from one string — see the header note. */
const LABEL: Record<Service, string> = { chat: 'Chat' }

const ICON: Record<Service, React.ReactNode> = {
  chat: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.5 8.5 0 1 0-16.9 1.6L3 20l3.8-1.1A8.5 8.5 0 0 0 21 11.5z" />
    </svg>
  ),
}

export default function ServiceNav({ service, onSelect, onProfile }: {
  service: Service
  onSelect: (s: Service) => void
  onProfile: () => void
}) {
  const { nostrNpub } = useChat()
  // The same hook and the same shape as the landing page's own `navigate('/app')` — one router API
  // across the two directions of this door, rather than a <Link> here and a navigate there.
  const navigate = useNavigate()

  return (
    <nav data-theme="dark" style={{
      width: 64, flexShrink: 0, background: 'var(--nav-ground)',
      padding: '14px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    }}>
      {/* The mark, on its accent tile — and the way back to the landing page. LogoTile is a
          <button> here because it is given an onClick; it does the same thing the service rows do
          (a click that changes what is on screen) and gets Enter, Space and the focus ring from the
          element rather than from us.

          The mark inside stays decorative — the accessible name belongs on the control, not on the
          artwork. Announcing it twice is how a screen reader ends up saying "Caravel logo, Caravel
          — home, button". */}
      <LogoTile size={32} onClick={() => navigate('/')} label="Caravel — home" style={{ marginBottom: 10 }} />

      {/* Services */}
      {SERVICES.map(s => {
        const on = s === service
        return (
          <button
            key={s}
            onClick={() => onSelect(s)}
            aria-current={on ? 'page' : undefined}
            title={LABEL[s]}
            aria-label={LABEL[s]}
            className="cv-nav-item"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 38, height: 38, flexShrink: 0, padding: 0,
              borderRadius: 11, border: 'none', cursor: 'pointer',
              background: on ? 'var(--nav-selected)' : 'transparent',
              color: on ? 'var(--text-bright)' : 'var(--text-body-dim)',
            }}
          >
            {ICON[s]}
          </button>
        )
      })}

      <span style={{ flex: 1, minHeight: 24 }} />

      {/* Identity — opens the profile panel (npub, chat backup, Sapient, lock). The npub on hover.

          ON .cv-accent-tile, NOT .cv-nav-item — it carried the latter since the spine was built and
          got no hover from it, because that rule hovers by setting `background` and this tile's
          accent fill is inline, which wins. It looked correct in the markup and did nothing on
          screen. Same fix as the logo above, and the same rule. */}
      <button
        onClick={onProfile}
        title={nostrNpub ?? 'Your profile'}
        aria-label="Your profile"
        className="cv-accent-tile"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 30, height: 30, flexShrink: 0, padding: 0,
          borderRadius: 9, border: 'none', cursor: 'pointer',
          // The brand blue, matching the mark above it and the avatars elsewhere. The design
          // draws this tile quiet (--vault-card behind --accent-300); bright was chosen so the
          // spine's two tiles read as one pair rather than a logo and an afterthought.
          background: 'var(--accent-400)', color: 'var(--ink-on-accent)',
          fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
        }}
      >@</button>
    </nav>
  )
}
