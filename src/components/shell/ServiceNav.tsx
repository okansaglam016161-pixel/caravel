//   The service spine — the app's permanent left edge.
//
//   Built to the V3 design's locked shell (Caravel Chat V3.dc.html §1, "ICON SPINE + LIST +
//   THREAD"): 64px wide, icon-only, labels dropped to tooltips. It sits on navy in both themes,
//   which is the foundation's rule for nav and the balance hero ("the balance hero and nav live
//   on 900-950").
//
//   ── WHY ICON-ONLY, AND WHY APP-WIDE ──────────────────────────────────────────
//
//   The spine is the shell, not a chat component: Wallet and Name render beside it too, so it
//   narrows for all three or none. Chat is what forced the question — it brings its own 380px
//   sidebar, so a labelled 210px rail put 590px of navy in two abutting columns before the thread
//   started. 64px is the design's answer, and the 146px it gives back go to the content pane on
//   every service.
//
//   THE LABELS BECOME TOOLTIPS, via `title` + `aria-label` on each button — this codebase's
//   pattern for an icon-only control (primitives/ThemeToggle, wallet/v2 HeaderIcon). There is no
//   tooltip component here and a hover flyout would be a new one.
//
//   ── THE BALANCE CARD IS GONE ─────────────────────────────────────────────────
//
//   The rail used to carry a "Total balance" card under the lockup. V3 drops it, and the reason is
//   not just that the design omits it: the wallet page's whole point is now one centred figure at
//   52px, and a second copy of that same number 200px to its left is the screen saying the most
//   important thing twice, in two type sizes, where the smaller one looks like a different fact.
//
//   IT COST SOMETHING REAL TO KEEP. The card had to reproduce the hero's entire honesty ladder —
//   settling shows no figure, unreadable shows a dash, hidden shows dots — because a rail that
//   disagreed with the wallet beside it would be worse than no rail at all. That was a second
//   render path over the same unions, kept in step by hand.
//
//   WHERE IT SHOULD COME BACK, IF IT DOES: on a service OTHER than the wallet, where the balance is
//   genuinely out of sight. Chat is the case that would justify it — and chat's own sidebar already
//   carries a balance pill for exactly that reason. Restoring it here is not the answer; 64px has
//   no room for a figure, which is the design settling the question.
//
//   ── THE ADDRESS LABEL WENT WITH THE WIDTH ────────────────────────────────────
//
//   The identity row used to print an elided address (ten leading characters and five trailing)
//   beside a lock glyph. An icon-only spine has nowhere to put it, so it is now the design's 30px
//   "@" tile and nothing else. THE FULL VALUE IS STILL ON `title`, which is where it always
//   actually was — the elision was aggressive enough that it was never something to check an
//   address against, only a "this is you" marker. The tile says the same thing in less space, and
//   the panel behind it has the real row with the real copy control.
//
//   AN ALWAYS-DARK ISLAND, like the vault hero. The spine carries data-theme="dark" so its contents
//   resolve the dark ramp whatever the page around it is, which is what lets it use ordinary role
//   tokens instead of the white literals it would otherwise need. Same mechanism, same reason: the
//   foundation keeps the nav on navy in both themes.
//
//   NO BORDER ON THE RIGHT EDGE, per the design. The pane beside it draws its own — chat's list
//   pane and the wallet page both do — and a second hairline between two surfaces that already
//   differ by #0C1A2E vs the page ground is a line doing no work.

import { useWallet } from '../../context/WalletContext'

const SERVICES = ['wallet', 'chat', 'name'] as const

/** Type-only export: keeps this file a component module, which is what fast refresh wants. */
export type Service = (typeof SERVICES)[number]

/** The tooltip text, and the accessible name. Both, from one string — see the header note. */
const LABEL: Record<Service, string> = { wallet: 'Wallet', chat: 'Chat', name: 'Name' }

const ICON: Record<Service, React.ReactNode> = {
  wallet: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="6" width="19" height="13" rx="2.5" /><path d="M2.5 10h19" /><path d="M15.5 14.5h2" />
    </svg>
  ),
  chat: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.5 8.5 0 1 0-16.9 1.6L3 20l3.8-1.1A8.5 8.5 0 0 0 21 11.5z" />
    </svg>
  ),
  name: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  ),
}

export default function ServiceNav({ service, onSelect, onProfile }: {
  service: Service
  onSelect: (s: Service) => void
  onProfile: () => void
}) {
  const { address } = useWallet()

  return (
    <nav data-theme="dark" style={{
      width: 64, flexShrink: 0, background: 'var(--nav-ground)',
      padding: '14px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    }}>
      {/* The mark, on its accent tile. Not a control — the spine's rows are the navigation, and a
          fourth clickable thing at the top that goes somewhere else is a trap in 64px. */}
      <span style={{
        width: 32, height: 32, borderRadius: 10, background: 'var(--accent-400)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        marginBottom: 10,
      }}>
        <img src="/logo-light.png" alt="" aria-hidden="true" style={{ height: 17, width: 'auto', display: 'block' }} />
      </span>

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

      {/* Identity — opens the profile panel (address, recovery phrase, lock). The full address on
          hover: the tile shows none of it, and this is the only place in the spine it exists. */}
      <button
        onClick={onProfile}
        title={address ?? 'Your profile'}
        aria-label="Your profile"
        className="cv-nav-item"
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
