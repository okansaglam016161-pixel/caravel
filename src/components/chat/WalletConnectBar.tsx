//   The Sapient wallet pill, at the top of the chat list — and its non-mainnet warning.
//
//   ITS OWN ROW, above the search row, so the new-conversation and new-group buttons keep the space
//   they had. Full width of the list: one line in every state — "Looking for Sapient…", "Install
//   Sapient", "Connect wallet", "Connecting…", or the connected account's short address with its
//   network. The connected pill opens a small menu — the Profile panel's Sapient card (SapientCard,
//   same rows): Address (shortened, copy), Network, Private and Public balances, View access (Grant
//   when off), and a quiet Disconnect.
//
//   Payments themselves (send, claim) live in ChatApp, sapient/payments and hooks/usePaymentClaimer.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useSapient } from '../../context/SapientContext'
import SapientCard from './SapientCard'
import { FactRow } from './listRows'
import {
  SAPIENT_INSTALL_URL, formatBalance, getPrivateTariBalance, getPublicTariBalance, isMainnet, networkLabel, shortAddress,
  type RawBalance,
} from '../../sapient/provider'

const MONO = 'var(--font-mono)'

const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, width: '100%', boxSizing: 'border-box',
  height: 34, padding: '0 12px', borderRadius: 10,
  border: '1px solid var(--border)', background: 'var(--surface)',
  fontSize: 13, fontFamily: 'inherit', color: 'var(--text-primary)', textDecoration: 'none',
}

const WalletGlyph = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--text-muted-dim)' }}>
    <rect x="2.5" y="6" width="19" height="13" rx="2.5" /><path d="M2.5 10h19" /><path d="M15.5 14.5h2" />
  </svg>
)

function NetworkChip({ network }: { network: string | null }) {
  const main = isMainnet(network)
  return (
    <span style={{
      flexShrink: 0, padding: '2px 7px', borderRadius: 999, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
      textTransform: 'uppercase',
      background: main ? 'var(--accent-wash)' : 'var(--card-warn)',
      color: main ? 'var(--accent-ink)' : 'var(--warn)',
    }}>{networkLabel(network)}</span>
  )
}

/** One balance line in the menu. `no-access`: private TARI needs view access to read. */
type BalanceView = { s: 'loading' } | { s: 'ok'; text: string } | { s: 'error' } | { s: 'no-access' }

function BalanceText({ view, locked }: { view: BalanceView; locked: boolean }) {
  // Locked: nothing can be read, and the last figure may be stale — say so instead.
  if (locked) return <span style={{ color: 'var(--text-muted-dim)' }}>Unlock Sapient to see</span>
  if (view.s === 'loading') return <span style={{ color: 'var(--text-muted-dim)' }}>…</span>
  if (view.s === 'no-access') return <span style={{ color: 'var(--text-muted-dim)' }}>Grant view access to see</span>
  if (view.s === 'error') return <span style={{ color: 'var(--text-muted-dim)' }}>Couldn’t read</span>
  return <span style={{ fontFamily: MONO, fontSize: 12 }}>{view.text} TARI</span>
}

const shown = (b: RawBalance): BalanceView => ({ s: 'ok', text: formatBalance(b) })

export default function WalletConnectBar() {
  const { status, network, walletAddress, viewAccess, error, provider, openChooser, unlock, unlocking, transport } = useSapient()
  const onPhone = transport === 'phone'
  const [menuOpen, setMenuOpen] = useState(false)
  const [privateBalance, setPrivateBalance] = useState<BalanceView>({ s: 'loading' })
  const [publicBalance, setPublicBalance] = useState<BalanceView>({ s: 'loading' })
  const boxRef = useRef<HTMLDivElement>(null)

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  // BALANCES, READ FRESH EVERY TIME THE MENU OPENS — and again if view access is granted while it is
  // open. Never on the pill. Private TARI needs view access; public does not. A read that lands after
  // the menu closed (or the inputs changed) is dropped.
  useEffect(() => {
    if (!menuOpen || status !== 'connected' || !provider) return
    let live = true
    setPublicBalance({ s: 'loading' })
    getPublicTariBalance(provider)
      .then(b => { if (live) setPublicBalance(shown(b)) })
      .catch(() => { if (live) setPublicBalance({ s: 'error' }) })
    if (viewAccess === 'granted') {
      setPrivateBalance({ s: 'loading' })
      getPrivateTariBalance(provider)
        .then(b => { if (live) setPrivateBalance(shown(b)) })
        .catch(() => { if (live) setPrivateBalance({ s: 'error' }) })
    } else {
      setPrivateBalance({ s: 'no-access' })
    }
    return () => { live = false }
  }, [menuOpen, status, provider, viewAccess])

  // An open menu STAYS open through a lock or a disconnect and shows it — the same card the Profile
  // panel draws (SapientCard): Unlock + the toolbar hint, or a single Connect / Install row.

  let pill: ReactNode
  if (status === 'detecting') {
    pill = <div style={{ ...ROW, color: 'var(--text-muted-dim)' }}><WalletGlyph />Looking for Sapient…</div>
  } else if (status === 'missing') {
    pill = (
      <a href={SAPIENT_INSTALL_URL} target="_blank" rel="noopener noreferrer" className="cv-quiet-btn"
        title="Sapient runs in Chrome, Brave or Edge" style={{ ...ROW, cursor: 'pointer' }}>
        <WalletGlyph /><span style={{ flex: 1, fontWeight: 600 }}>Install Sapient</span>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M7 17L17 7M9 7h8v8" /></svg>
      </a>
    )
  } else if (status === 'connecting') {
    pill = (
      <div style={{ ...ROW, color: 'var(--text-muted-dim)' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--accent-400)', animation: 'cv-spin 0.8s linear infinite', flexShrink: 0 }} />
        Connecting… approve in Sapient
      </div>
    )
  } else if (status === 'locked') {
    // Connected, but the wallet is locked: nothing can be read or paid until it is unlocked. A click
    // opens Sapient's unlock window (SapientContext.unlock); its unlock is noticed within seconds.
    pill = (
      <button onClick={() => void unlock()} disabled={unlocking} className="cv-quiet-btn"
        title={onPhone ? 'Unlock Sapient on your phone, then click to check again.' : 'Opens Sapient to unlock. Or click the Sapient icon in your browser toolbar.'}
        style={{ ...ROW, cursor: unlocking ? 'default' : 'pointer' }}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0 }}><rect x={5} y={11} width={14} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        <span style={{ flex: 1, textAlign: 'left', fontWeight: 600 }}>{unlocking ? 'Unlock in Sapient…' : 'Sapient is locked'}</span>
        {!unlocking && <span style={{ fontSize: 11, color: 'var(--text-muted-dim)' }}>Unlock to use</span>}
      </button>
    )
  } else if (status === 'connected') {
    pill = (
      <button onClick={() => setMenuOpen(v => !v)} aria-expanded={menuOpen} aria-haspopup="menu" className="cv-quiet-btn"
        title={walletAddress ?? undefined} style={{ ...ROW, cursor: 'pointer' }}>
        <WalletGlyph />
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left', fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {walletAddress ? shortAddress(walletAddress) : 'Reading account…'}
          {onPhone && <span style={{ marginLeft: 8, fontFamily: 'inherit', fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted-dim)' }}>phone</span>}
        </span>
        <NetworkChip network={network} />
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: menuOpen ? 'rotate(180deg)' : undefined }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
    )
  } else {
    pill = (
      <button onClick={() => openChooser()} className="cv-quiet-btn" style={{ ...ROW, cursor: 'pointer' }}>
        <WalletGlyph /><span style={{ flex: 1, textAlign: 'left', fontWeight: 600 }}>Connect wallet</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted-dim)' }}>Sapient</span>
      </button>
    )
  }

  const showNetworkWarning = (status === 'connected' || status === 'locked' || status === 'disconnected' || status === 'connecting') && network !== null && !isMainnet(network)

  return (
    <div ref={boxRef} style={{ position: 'relative', padding: '14px 12px 0' }}>
      {pill}

      {status === 'locked' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 6, lineHeight: 1.45 }}>
          {unlocking
            ? 'Unlock, then approve the connection (and view access) in Sapient’s window.'
            : onPhone ? 'Unlock Sapient on your phone, then click above to check again.' : 'Or unlock from the Sapient icon in your browser toolbar.'}
        </div>
      )}

      {status === 'disconnected' && error && (
        <div role="alert" style={{ fontSize: 11.5, color: 'var(--danger-500)', marginTop: 6, lineHeight: 1.45 }}>{error}</div>
      )}

      {showNetworkWarning && (
        <div role="alert" style={{
          marginTop: 8, padding: '8px 11px', borderRadius: 10, background: 'var(--card-warn)',
          fontSize: 12, lineHeight: 1.45, color: 'var(--warn)', textWrap: 'pretty',
        }}>
          Sapient is on {networkLabel(network)}. Caravel uses mainnet — switch network in Sapient.
        </div>
      )}

      {menuOpen && (
        <div role="menu" style={{ position: 'absolute', left: 12, right: 12, top: 52, zIndex: 30, borderRadius: 10, boxShadow: 'var(--e3)' }}>
          <SapientCard mt={0} hideStatusWhenConnected onDisconnect={() => setMenuOpen(false)} extraRows={<>
            <FactRow label="Private"><BalanceText view={privateBalance} locked={status === 'locked'} /></FactRow>
            <FactRow label="Public"><BalanceText view={publicBalance} locked={status === 'locked'} /></FactRow>
          </>} />
        </div>
      )}
    </div>
  )
}
