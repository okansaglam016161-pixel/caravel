//   The Sapient wallet pill, at the top of the chat list — and its non-mainnet warning.
//
//   ITS OWN ROW, above the search row, so the new-conversation and new-group buttons keep the space
//   they had. Full width of the list: one line in every state — "Looking for Sapient…", "Install
//   Sapient", "Connect wallet", "Connecting…", or the connected account's short address with its
//   network. The connected pill opens a small menu: the full address (copy), the network, view access
//   (with Grant when it is off) and Disconnect.
//
//   This is CONNECTION ONLY. Chat payments still go through the built-in wallet until the payments
//   step moves them onto Sapient.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useSapient } from '../../context/SapientContext'
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

function MenuRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
      <span style={{ width: 78, flexShrink: 0, fontSize: 12, color: 'var(--text-muted-dim)' }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-body)' }}>{children}</span>
    </div>
  )
}

/** One balance line in the menu. `no-access`: private TARI needs view access to read. */
type BalanceView = { s: 'loading' } | { s: 'ok'; text: string } | { s: 'error' } | { s: 'no-access' }

function BalanceText({ view }: { view: BalanceView }) {
  if (view.s === 'loading') return <span style={{ color: 'var(--text-muted-dim)' }}>…</span>
  if (view.s === 'no-access') return <span style={{ color: 'var(--text-muted-dim)' }}>Grant view access to see</span>
  if (view.s === 'error') return <span style={{ color: 'var(--text-muted-dim)' }}>Couldn’t read</span>
  return <span style={{ fontFamily: MONO, fontSize: 12 }}>{view.text} TARI</span>
}

const shown = (b: RawBalance): BalanceView => ({ s: 'ok', text: formatBalance(b) })

const linkBtn: CSSProperties = {
  padding: 0, border: 'none', background: 'transparent', cursor: 'pointer',
  fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', color: 'var(--accent-ink)',
}

export default function WalletConnectBar() {
  const { status, network, walletAddress, viewAccess, error, provider, connect, disconnect, grantViewAccess, refresh } = useSapient()
  const [menuOpen, setMenuOpen] = useState(false)
  const [privateBalance, setPrivateBalance] = useState<BalanceView>({ s: 'loading' })
  const [publicBalance, setPublicBalance] = useState<BalanceView>({ s: 'loading' })
  const [copied, setCopied] = useState(false)
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

  // A connection that ends closes its menu.
  useEffect(() => { if (status !== 'connected') setMenuOpen(false) }, [status])

  function copyAddress() {
    if (!walletAddress) return
    void navigator.clipboard?.writeText(walletAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

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
    // Connected, but the wallet is locked: nothing can be read or paid until it is unlocked in Sapient.
    // Sapient sends no unlock event — SapientContext checks every few seconds; a click checks now.
    pill = (
      <button onClick={() => void refresh()} className="cv-quiet-btn" title="Unlock Sapient, then click to check again"
        style={{ ...ROW, cursor: 'pointer' }}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0 }}><rect x={5} y={11} width={14} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        <span style={{ flex: 1, textAlign: 'left', fontWeight: 600 }}>Sapient is locked</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted-dim)' }}>Unlock to use</span>
      </button>
    )
  } else if (status === 'connected') {
    pill = (
      <button onClick={() => setMenuOpen(v => !v)} aria-expanded={menuOpen} aria-haspopup="menu" className="cv-quiet-btn"
        title={walletAddress ?? undefined} style={{ ...ROW, cursor: 'pointer' }}>
        <WalletGlyph />
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left', fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {walletAddress ? shortAddress(walletAddress) : 'Reading account…'}
        </span>
        <NetworkChip network={network} />
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: menuOpen ? 'rotate(180deg)' : undefined }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
    )
  } else {
    pill = (
      <button onClick={() => void connect()} className="cv-quiet-btn" style={{ ...ROW, cursor: 'pointer' }}>
        <WalletGlyph /><span style={{ flex: 1, textAlign: 'left', fontWeight: 600 }}>Connect wallet</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted-dim)' }}>Sapient</span>
      </button>
    )
  }

  const showNetworkWarning = (status === 'connected' || status === 'locked' || status === 'disconnected' || status === 'connecting') && network !== null && !isMainnet(network)

  return (
    <div ref={boxRef} style={{ position: 'relative', padding: '14px 12px 0' }}>
      {pill}

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

      {menuOpen && status === 'connected' && (
        <div role="menu" style={{
          position: 'absolute', left: 12, right: 12, top: 52, zIndex: 30,
          padding: '8px 14px 12px', borderRadius: 12, background: 'var(--surface)',
          border: '1px solid var(--border)', boxShadow: 'var(--e3)',
        }}>
          <MenuRow label="Address">
            <span style={{ display: 'block', fontFamily: MONO, fontSize: 11, wordBreak: 'break-all', color: 'var(--text-body-dim)' }}>{walletAddress ?? '…'}</span>
            {walletAddress && <button onClick={copyAddress} style={{ ...linkBtn, marginTop: 4 }}>{copied ? 'Copied' : 'Copy address'}</button>}
          </MenuRow>
          <MenuRow label="Network"><NetworkChip network={network} /></MenuRow>
          <MenuRow label="Private"><BalanceText view={privateBalance} /></MenuRow>
          <MenuRow label="Public"><BalanceText view={publicBalance} /></MenuRow>
          <MenuRow label="View access">
            {viewAccess === 'granted' ? 'Granted'
              : viewAccess === 'requesting' ? 'Approve in Sapient…'
              : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>Off <button onClick={() => void grantViewAccess()} style={linkBtn}>Grant</button></span>}
          </MenuRow>
          <button
            onClick={() => { setMenuOpen(false); void disconnect() }}
            className="cv-quiet-btn"
            style={{ ...ROW, height: 32, marginTop: 8, justifyContent: 'center', cursor: 'pointer', fontWeight: 600 }}
          >Disconnect</button>
        </div>
      )}
    </div>
  )
}
