//   The service rail — the app's permanent left edge.
//
//   Built to the wallet design's nav: the lockup, one row per service, and the identity footer. It
//   sits on navy in both themes, which is the foundation's rule for nav and the balance hero ("the
//   balance hero and nav live on 900-950").
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
//   genuinely out of sight. Chat is the case that would justify it. Restoring it unconditionally is
//   what this pass removed.
//
//   AN ALWAYS-DARK ISLAND, like the vault hero. The rail carries data-theme="dark" so its contents
//   resolve the dark ramp whatever the page around it is, which is what lets it use ordinary role
//   tokens instead of the white literals it would otherwise need. Same mechanism, same reason: the
//   foundation keeps the nav on navy in both themes.

import { useWallet } from '../../context/WalletContext'

const SERVICES = ['wallet', 'chat', 'name'] as const

/** Type-only export: keeps this file a component module, which is what fast refresh wants. */
export type Service = (typeof SERVICES)[number]

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

/** npub1abcd…wxyz. The footer identity until a registered @name is wired in (stage 7). */
function shortNpub(npub: string): string {
  return npub.length > 20 ? `${npub.slice(0, 10)}…${npub.slice(-4)}` : npub
}

export default function ServiceNav({ service, onSelect, onProfile }: {
  service: Service
  onSelect: (s: Service) => void
  onProfile: () => void
}) {
  const { nostrNpub } = useWallet()

  return (
    <nav data-theme="dark" style={{
      width: 210, flexShrink: 0, background: 'var(--nav-ground)', borderRight: '1px solid var(--border)',
      padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      {/* Lockup */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px 22px' }}>
        <span style={{
          width: 30, height: 30, borderRadius: 9, background: 'var(--accent-400)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <img src="/logo-light.png" alt="" aria-hidden="true" style={{ height: 16, width: 'auto', display: 'block' }} />
        </span>
        <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-bright)' }}>Caravel</span>
      </div>

      {/* Services */}
      {SERVICES.map(s => {
        const on = s === service
        return (
          <button
            key={s}
            onClick={() => onSelect(s)}
            aria-current={on ? 'page' : undefined}
            className="cv-nav-item"
            style={{
              display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px',
              borderRadius: 'var(--r-md)', border: 'none', width: '100%', textAlign: 'left',
              fontFamily: 'inherit', fontSize: 14, cursor: 'pointer',
              background: on ? 'var(--nav-selected)' : 'transparent',
              color: on ? 'var(--text-bright)' : 'var(--text-body-dim)',
              fontWeight: on ? 600 : 500,
            }}
          >
            {ICON[s]}<span>{LABEL[s]}</span>
          </button>
        )
      })}

      <div style={{ flex: 1, minHeight: 24 }} />

      {/* Identity — opens the profile panel (npub, recovery phrase, lock). */}
      <button
        onClick={onProfile}
        className="cv-nav-item"
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
          borderTop: '1px solid var(--border)', borderLeft: 'none', borderRight: 'none', borderBottom: 'none',
          borderRadius: 0, background: 'transparent', width: '100%', textAlign: 'left',
          fontFamily: 'inherit', cursor: 'pointer',
        }}
      >
        <span style={{
          width: 26, height: 26, borderRadius: 8, background: 'var(--vault-card)', color: 'var(--accent-300)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, flexShrink: 0,
        }}>@</span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{nostrNpub ? shortNpub(nostrNpub) : 'Your profile'}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--vault-label)" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      </button>
    </nav>
  )
}
