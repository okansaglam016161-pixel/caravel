import { useState } from 'react'
import { Link } from 'react-router-dom'
import Logo from '../Logo'
import { useWallet } from '../../context/WalletContext'
import WalletPanel from '../wallet/WalletPanel'

const conversations = [
  {
    initials: 'MR',
    name: 'Mara Reyes',
    time: '14:32',
    preview: null, // payment preview
    active: true,
    avatarGrad: 'linear-gradient(135deg, #1E6E63, var(--accD,#12A594))',
    initialsColor: '#EAFBF7',
    online: true,
  },
  {
    initials: 'JK',
    name: 'Jonah Kessler',
    time: '13:08',
    preview: "Received. I'll send the docs over tonight.",
    active: false,
    avatarGrad: 'linear-gradient(135deg, #2A3550, #3C4E78)',
    initialsColor: '#C7D0E4',
    online: false,
  },
  {
    initials: 'SV',
    name: 'Sable Ventures',
    time: 'Mon',
    preview: 'Great, the terms look good to us.',
    active: false,
    avatarGrad: 'linear-gradient(135deg, #4A2F55, #6E3C78)',
    initialsColor: '#E4C7EC',
    online: false,
  },
  {
    initials: 'DN',
    name: 'Devon Nyx',
    time: 'Sun',
    preview: 'See you there. Have a great trip!',
    active: false,
    avatarGrad: 'linear-gradient(135deg, #244A44, #2E6B5C)',
    initialsColor: '#C7ECE2',
    online: false,
  },
]

export default function ChatApp() {
  const { address, scan } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)
  const [balanceHidden, setBalanceHidden] = useState(false)

  // Truncate address for display: otl_esm_1abc…xyz
  const shortAddr = address
    ? address.slice(0, 12) + '…' + address.slice(-4)
    : null

  return (
    <>
    <div style={{ height: '100vh', display: 'flex', background: '#0A0E17' }}>
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>

        {/* LEFT: sidebar */}
        <div style={{ width: 380, flexShrink: 0, borderRight: '1px solid rgba(120,150,210,0.1)', display: 'flex', flexDirection: 'column', background: '#080B12' }}>

          {/* Sidebar header */}
          <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid rgba(120,150,210,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer', opacity: 1, transition: 'opacity 0.15s' }} onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')} onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
                <Logo size={26} />
                <span style={{ fontSize: 18, fontWeight: 700, color: '#F2F5FB' }}>Caravel</span>
              </Link>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: '1px solid rgba(120,150,210,0.2)', cursor: 'pointer' }}>
                <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </div>
            </div>

            {/* Balance widget — click to open wallet panel */}
            {(() => {
              // Derive display value from shared scan state — no second scan
              const { status, balance } = scan
              const isScanning = status === 'scanning'
              const isDone = status === 'done'
              const tTARI = balance !== null
                ? (Number(balance) / 1_000_000).toFixed(6)
                : null
              const balanceValue = balanceHidden
                ? '••••'
                : isScanning && tTARI === null
                  ? '···'          // first scan in progress, no prior result
                  : isDone || (isScanning && tTARI !== null)
                    ? (tTARI ?? '0.000000')
                    : status === 'error'
                      ? '?'
                      : '—'       // idle (locked)
              const balanceColor = balanceHidden || isDone || (isScanning && tTARI !== null)
                ? '#EAFBF7'
                : '#8A97B4'
              return (
                <div
                  onClick={() => setWalletOpen(true)}
                  title="Open wallet"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderRadius: 12, background: 'linear-gradient(140deg, rgba(var(--accRGB,45,224,198),0.1), rgba(18,165,148,0.04))', border: '1px solid rgba(var(--accRGB,45,224,198),0.22)', cursor: 'pointer', transition: 'border-color 0.15s' }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(45,224,198,0.45)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(var(--accRGB,45,224,198),0.22)')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x={2} y={6} width={20} height={13} rx={2.5} /><path d="M2 10h20" /></svg>
                    <span style={{ fontSize: 13, color: '#8FB7B0', fontWeight: 500 }}>Balance</span>
                    {isScanning && (
                      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={2.5} strokeLinecap="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 16, fontWeight: 500, color: balanceColor, letterSpacing: '0.08em', transition: 'color 0.2s' }}>
                      {balanceValue}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--acc,#2DE0C6)' }}>TARI</span>
                    {/* Eye toggle — stops propagation so the wallet panel doesn't open */}
                    <button
                      onClick={e => { e.stopPropagation(); setBalanceHidden(v => !v) }}
                      title={balanceHidden ? 'Show balance' : 'Hide balance'}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#5E8A82', flexShrink: 0 }}
                    >
                      {balanceHidden
                        ? <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx={12} cy={12} r={3} /><path d="M4 4l16 16" /></svg>
                        : <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx={12} cy={12} r={3} /></svg>
                      }
                    </button>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#5E8A82" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                  </div>
                </div>
              )
            })()}
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            {/* Wallet address chip — also opens panel */}
            {shortAddr && (
              <div
                onClick={() => setWalletOpen(true)}
                title={address ?? ''}
                style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 8, background: 'rgba(120,150,210,0.06)', border: '1px solid rgba(120,150,210,0.1)', cursor: 'pointer' }}
              >
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortAddr}</span>
              </div>
            )}
          </div>

          {/* Search */}
          <div style={{ padding: '14px 16px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 10, background: '#10151F', border: '1px solid rgba(120,150,210,0.12)' }}>
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={2} strokeLinecap="round"><circle cx={11} cy={11} r={7} /><path d="M21 21l-4-4" /></svg>
              <span style={{ fontSize: 14, color: '#55617D' }}>Search conversations</span>
            </div>
          </div>

          {/* Conversation list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
            {conversations.map((c) => (
              <div key={c.name} className="cv-conv" style={{ display: 'flex', gap: 13, padding: 13, borderRadius: 12, background: c.active ? '#10161F' : 'transparent', border: c.active ? '1px solid rgba(var(--accRGB,45,224,198),0.18)' : '1px solid transparent', cursor: 'pointer', marginBottom: 4 }}>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{ width: 46, height: 46, borderRadius: 13, background: c.avatarGrad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 700, color: c.initialsColor }}>{c.initials}</div>
                  {c.online && <span style={{ position: 'absolute', bottom: -1, right: -1, width: 14, height: 14, borderRadius: '50%', background: 'var(--acc,#2DE0C6)', border: '2.5px solid #080B12' }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: c.active ? '#F2F5FB' : '#E8EEF9' }}>{c.name}</span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D' }}>{c.time}</span>
                  </div>
                  {c.preview === null ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#8A97B4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2} style={{ flexShrink: 0 }}><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                      <span style={{ color: 'var(--acc,#2DE0C6)', fontWeight: 500 }}>Payment sent · amount hidden</span>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: '#8A97B4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.preview}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT: active chat */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#0A0E17', position: 'relative' }}>

          {/* Chat header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 26px', borderBottom: '1px solid rgba(120,150,210,0.1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <div style={{ width: 42, height: 42, borderRadius: 12, background: 'linear-gradient(135deg, #1E6E63, var(--accD,#12A594))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: '#EAFBF7' }}>MR</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#F2F5FB' }}>Mara Reyes</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.2}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                  <span style={{ fontSize: 12, color: 'var(--accT,#7DE9D8)', fontWeight: 500 }}>End-to-end encrypted</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, border: '1px solid rgba(120,150,210,0.16)', cursor: 'pointer' }}>
                <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z" /><rect x={1} y={5} width={15} height={14} rx={2} /></svg>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, border: '1px solid rgba(120,150,210,0.16)', cursor: 'pointer' }}>
                <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth={1.9} strokeLinecap="round"><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} /><circle cx={5} cy={12} r={1.6} /></svg>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Encryption notice */}
            <div style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 100, background: 'rgba(120,150,210,0.06)', marginBottom: 4 }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#6B7793" strokeWidth={2}><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
              <span style={{ fontSize: 12, color: '#6B7793' }}>Messages and payments in this chat are end-to-end encrypted</span>
            </div>

            {/* Incoming */}
            <div style={{ alignSelf: 'flex-start', maxWidth: '62%' }}>
              <div style={{ padding: '13px 17px', borderRadius: '4px 16px 16px 16px', background: '#161C28', color: '#E4EAF4', fontSize: 15, lineHeight: 1.5 }}>Hey — are we still splitting the holiday booking this week?</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', marginTop: 5, marginLeft: 4 }}>14:21</div>
            </div>

            {/* Outgoing */}
            <div style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'linear-gradient(160deg, #1C7A6E, #12655A)', color: '#EAFBF7', fontSize: 15, lineHeight: 1.5 }}>Yes. Sending my share now so we're locked in.</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', marginTop: 5, marginRight: 4 }}>
                14:30
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
              </div>
            </div>

            {/* Confidential payment card */}
            <div style={{ alignSelf: 'flex-end', maxWidth: '68%', width: 400 }}>
              <div style={{ borderRadius: '18px 6px 18px 18px', overflow: 'hidden', border: '1px solid rgba(var(--accRGB,45,224,198),0.4)', background: 'linear-gradient(165deg, #0E2A28, #0A1A1C)', boxShadow: '0 0 34px rgba(var(--accRGB,45,224,198),0.16)' }}>
                {/* Payment header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 18px', background: 'linear-gradient(180deg, rgba(var(--accRGB,45,224,198),0.16), rgba(var(--accRGB,45,224,198),0.05))', borderBottom: '1px solid rgba(var(--accRGB,45,224,198),0.22)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 8, background: 'rgba(var(--accRGB,45,224,198),0.18)' }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accT,#7DE9D8)', letterSpacing: '0.06em' }}>CONFIDENTIAL PAYMENT</span>
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: 'var(--acc,#2DE0C6)' }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.2}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    Sent
                  </span>
                </div>
                {/* Amount */}
                <div style={{ padding: '20px 18px 8px', textAlign: 'center' }}>
                  <div style={{ fontSize: 34, fontWeight: 800, color: '#EAFBF7', letterSpacing: '0.02em', display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8 }}>
                    <span>5</span>
                    <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--acc,#2DE0C6)' }}>TARI</span>
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '4px 11px', borderRadius: 100, background: 'rgba(120,150,210,0.08)' }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#8FB7B0" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx={12} cy={12} r={3} /><path d="M4 4l16 16" /></svg>
                    <span style={{ fontSize: 11, color: '#8FB7B0', fontFamily: "'IBM Plex Mono', monospace" }}>amount hidden on-chain</span>
                  </div>
                </div>
                {/* Private note */}
                <div style={{ margin: '12px 14px 16px', padding: '13px 15px', borderRadius: 12, background: 'rgba(10,14,23,0.6)', border: '1px dashed rgba(var(--accRGB,45,224,198),0.28)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#5E8A82" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></svg>
                    <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', color: '#5E8A82' }}>PRIVATE NOTE</span>
                  </div>
                  <div style={{ fontSize: 14, color: '#C7E4DD', lineHeight: 1.45, fontStyle: 'italic' }}>"My half for the Lisbon trip — thanks for booking it!"</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', marginTop: 6, marginRight: 4, justifyContent: 'flex-end' }}>
                14:31
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
              </div>
            </div>

            {/* Incoming reply */}
            <div style={{ alignSelf: 'flex-start', maxWidth: '62%' }}>
              <div style={{ padding: '13px 17px', borderRadius: '4px 16px 16px 16px', background: '#161C28', color: '#E4EAF4', fontSize: 15, lineHeight: 1.5 }}>Got it — confirmed on my end. The note came through too. Can't wait for the trip! 🎉</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', marginTop: 5, marginLeft: 4 }}>14:32</div>
            </div>
          </div>

          {/* Composer */}
          <div style={{ padding: '16px 24px 20px', borderTop: '1px solid rgba(120,150,210,0.1)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
              {/* TARI button */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, flexShrink: 0, borderRadius: 13, background: 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))', cursor: 'pointer', boxShadow: '0 0 18px rgba(var(--accRGB,45,224,198),0.28)' }} title="Attach confidential payment">
                <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="var(--accOn,#04120F)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
              </div>
              {/* Text input */}
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderRadius: 14, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)' }}>
                <span style={{ flex: 1, fontSize: 15, color: '#55617D' }}>Write an encrypted message…</span>
                <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><circle cx={12} cy={12} r={10} /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></svg>
              </div>
              {/* Send button */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, flexShrink: 0, borderRadius: 13, background: '#161C28', border: '1px solid rgba(120,150,210,0.16)', cursor: 'pointer' }}>
                <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 11, paddingLeft: 4 }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2} strokeLinecap="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
              <span style={{ fontSize: 12, color: '#5E8A82' }}>Tap the <span style={{ color: 'var(--acc,#2DE0C6)', fontWeight: 600 }}>TARI</span> button to attach a confidential payment to your message</span>
            </div>
          </div>
        </div>

      </div>
    </div>

    {walletOpen && <WalletPanel onClose={() => setWalletOpen(false)} />}
    </>
  )
}
