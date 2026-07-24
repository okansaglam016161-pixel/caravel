import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import * as nip19 from 'nostr-tools/nip19'
import Logo from '../Logo'
import { useWallet } from '../../context/WalletContext'
import WalletModal from '../wallet/WalletModal'
import type { CaravelMessage } from '../../messaging/types'
import { loadNicknames, setNickname, MAX_NICKNAME_LEN, type NicknameMap } from '../../messaging/nicknameStore'

// ── Conversation derivation ─────────────────────────────────────────────────────

interface Conversation {
  peerHex: string
  messages: CaravelMessage[]   // this peer's messages, oldest first
  lastMessage: CaravelMessage
  lastActivity: number
}

// Group all messages by the OTHER party: senderPubkeyHex for received, recipientPubkeyHex for
// sent. Self-messages (my pubkey on both sides) collapse into one thread keyed by my own pubkey
// — kept deliberately, it's a real notes-to-self thread. Blank-recipient messages (the M8.3
// cross-device self-copy path, which can't fire yet) are EXCLUDED: an unnamed, unselectable row
// would read as a bug.
function deriveConversations(messages: CaravelMessage[]): Conversation[] {
  const byPeer = new Map<string, CaravelMessage[]>()
  for (const m of messages) {
    const peerHex = m.direction === 'received' ? m.senderPubkeyHex : m.recipientPubkeyHex
    if (!peerHex) continue
    const arr = byPeer.get(peerHex)
    if (arr) arr.push(m)
    else byPeer.set(peerHex, [m])
  }
  const convos: Conversation[] = []
  for (const [peerHex, msgs] of byPeer) {
    const sorted = [...msgs].sort((a, b) => a.timestamp - b.timestamp)
    const lastMessage = sorted[sorted.length - 1]
    convos.push({ peerHex, messages: sorted, lastMessage, lastActivity: lastMessage.timestamp })
  }
  // Most recent activity first.
  convos.sort((a, b) => b.lastActivity - a.lastActivity)
  return convos
}

// ── Display helpers ──────────────────────────────────────────────────────────────

// npub1abcdefg…wxyz — never throws (blank/invalid hex falls back to raw prefix).
function truncNpub(peerHex: string): string {
  try {
    const npub = nip19.npubEncode(peerHex)
    return npub.slice(0, 12) + '…' + npub.slice(-4)
  } catch { return peerHex.slice(0, 10) + '…' }
}

// Two-letter avatar initials from a nickname; "··" when we only have an npub.
function initialsFor(nickname: string | undefined): string {
  if (!nickname) return '··'
  const parts = nickname.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return nickname.trim().slice(0, 2).toUpperCase()
}

// Compact list timestamp: time today, weekday within a week, else month/day.
function compactTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if ((now.getTime() - ts) < 7 * 86_400_000) {
    return d.toLocaleDateString([], { weekday: 'short' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Full time shown under each message bubble.
function bubbleTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Stable avatar gradient per peer, drawn from the existing palette so colours match the design.
const AVATARS = [
  { grad: 'linear-gradient(135deg, #1E6E63, var(--accD,#12A594))', color: '#EAFBF7' },
  { grad: 'linear-gradient(135deg, #2A3550, #3C4E78)', color: '#C7D0E4' },
  { grad: 'linear-gradient(135deg, #4A2F55, #6E3C78)', color: '#E4C7EC' },
  { grad: 'linear-gradient(135deg, #244A44, #2E6B5C)', color: '#C7ECE2' },
]
function avatarFor(peerHex: string) {
  let h = 0
  for (let i = 0; i < peerHex.length; i++) h = (h * 31 + peerHex.charCodeAt(i)) >>> 0
  return AVATARS[h % AVATARS.length]
}

// Cap on a single message. A longer paste would just be rejected by relays and surface as a
// confusing "all relays rejected" error rather than a clear reason, so stop it at the input.
const MAX_MESSAGE_LEN = 2000

// Composer grows with content up to this height (~5-6 lines), then scrolls internally.
const COMPOSER_MAX_H = 120

// ── Component ────────────────────────────────────────────────────────────────────

export default function ChatApp() {
  const { address, scan, messages, nostrPubkeyHex, createMessagingProvider, recordSentMessage } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)
  const [balanceHidden, setBalanceHidden] = useState(false)

  // Selected conversation (peer hex). UI state only — falls back to most-recent when unset.
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)

  // Composer state.
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  // Nicknames for the current identity, loaded from localStorage and re-derived on save.
  const [nicknames, setNicknames] = useState<NicknameMap>({})
  useEffect(() => {
    setNicknames(nostrPubkeyHex ? loadNicknames(nostrPubkeyHex) : {})
  }, [nostrPubkeyHex])

  // Inline nickname edit state (header).
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState('')

  const conversations = useMemo(() => deriveConversations(messages), [messages])
  const selectedConvo = conversations.find(c => c.peerHex === selectedPeer) ?? conversations[0] ?? null

  const displayName = (peerHex: string) => nicknames[peerHex] ?? truncNpub(peerHex)

  function beginEditNick() {
    if (!selectedConvo) return
    setNickDraft(nicknames[selectedConvo.peerHex] ?? '')
    setEditingNick(true)
  }
  function saveNick() {
    if (selectedConvo && nostrPubkeyHex) {
      setNicknames(prev => setNickname(nostrPubkeyHex, prev, selectedConvo.peerHex, nickDraft))
    }
    setEditingNick(false)
  }

  // Send the composer draft to the selected conversation. Same proven path as the dev panel:
  // a throwaway provider per send (a separate NostrMessagingProvider instance — it does NOT
  // disturb the long-lived subscription in WalletContext), then record the returned message so
  // it appears in the thread immediately without waiting for a relay round-trip.
  async function handleSend() {
    const text = draft.trim()
    if (!text || !selectedConvo || sending) return
    setSending(true)
    setSendError(null)
    try {
      const provider = createMessagingProvider()
      // Locked wallet → null. Surface a clear reason rather than leaking a null-reference error.
      if (!provider) throw new Error('Wallet is locked — unlock to send')
      const msg = await provider.sendMessage(selectedConvo.peerHex, text)
      provider.disconnect()
      recordSentMessage(msg)
      setDraft('')  // clear only on success — a failed send keeps the text
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  // Auto-scroll to newest: on conversation open and whenever this thread gains a message.
  const bottomRef = useRef<HTMLDivElement>(null)
  const selectedPeerHex = selectedConvo?.peerHex ?? null
  const selectedCount = selectedConvo?.messages.length ?? 0
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [selectedPeerHex, selectedCount])

  // Auto-grow the composer with its content: reset to 'auto' to measure, then set to the
  // content height capped at COMPOSER_MAX_H (beyond which it scrolls internally). Keyed on the
  // draft, so it grows on Shift+Enter/wrap, shrinks on delete, and resets to one line on send.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX_H) + 'px'
  }, [draft])

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

          {/* Search (inert placeholder) */}
          <div style={{ padding: '14px 16px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 10, background: '#10151F', border: '1px solid rgba(120,150,210,0.12)' }}>
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={2} strokeLinecap="round"><circle cx={11} cy={11} r={7} /><path d="M21 21l-4-4" /></svg>
              <span style={{ fontSize: 14, color: '#55617D' }}>Search conversations</span>
            </div>
          </div>

          {/* Conversation list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
            {conversations.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', height: '100%', padding: '0 28px', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 15, background: 'rgba(120,150,210,0.06)', border: '1px solid rgba(120,150,210,0.12)' }}>
                  <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#8A97B4' }}>No conversations yet</div>
                <div style={{ fontSize: 13, color: '#55617D', lineHeight: 1.5 }}>Messages you send and receive will appear here as encrypted conversations.</div>
              </div>
            ) : (
              conversations.map((c) => {
                const active = selectedConvo?.peerHex === c.peerHex
                const nick = nicknames[c.peerHex]
                const av = avatarFor(c.peerHex)
                const preview = c.lastMessage.direction === 'sent'
                  ? `You: ${c.lastMessage.plaintext}`
                  : c.lastMessage.plaintext
                return (
                  <div key={c.peerHex} onClick={() => setSelectedPeer(c.peerHex)} className="cv-conv" style={{ display: 'flex', gap: 13, padding: 13, borderRadius: 12, background: active ? '#10161F' : 'transparent', border: active ? '1px solid rgba(var(--accRGB,45,224,198),0.18)' : '1px solid transparent', cursor: 'pointer', marginBottom: 4 }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{ width: 46, height: 46, borderRadius: 13, background: av.grad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 700, color: av.color }}>{initialsFor(nick)}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3, gap: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 600, color: active ? '#F2F5FB' : '#E8EEF9', fontFamily: nick ? undefined : "'IBM Plex Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(c.peerHex)}</span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', flexShrink: 0 }}>{compactTime(c.lastActivity)}</span>
                      </div>
                      <div style={{ fontSize: 13, color: '#8A97B4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* RIGHT: active chat */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#0A0E17', position: 'relative' }}>

          {selectedConvo === null ? (
            /* No conversation selected / none exist */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 40px', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 72, height: 72, borderRadius: 20, background: 'rgba(var(--accRGB,45,224,198),0.06)', border: '1px solid rgba(var(--accRGB,45,224,198),0.16)' }}>
                <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#C7D0E4' }}>No conversation selected</div>
              <div style={{ fontSize: 14, color: '#55617D', lineHeight: 1.6, maxWidth: 360 }}>Select a conversation on the left to read it. New messages arrive automatically once someone sends to your address.</div>
            </div>
          ) : (
          <>
          {/* Chat header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 26px', borderBottom: '1px solid rgba(120,150,210,0.1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
              {(() => { const av = avatarFor(selectedConvo.peerHex); return (
                <div style={{ width: 42, height: 42, borderRadius: 12, background: av.grad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: av.color, flexShrink: 0 }}>{initialsFor(nicknames[selectedConvo.peerHex])}</div>
              ) })()}
              <div style={{ minWidth: 0 }}>
                {editingNick ? (
                  <input
                    autoFocus
                    value={nickDraft}
                    maxLength={MAX_NICKNAME_LEN}
                    onChange={e => setNickDraft(e.target.value)}
                    onBlur={saveNick}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveNick()
                      else if (e.key === 'Escape') setEditingNick(false)
                    }}
                    placeholder="Add a nickname…"
                    style={{ fontSize: 16, fontWeight: 600, color: '#F2F5FB', background: '#10151F', border: '1px solid rgba(var(--accRGB,45,224,198),0.35)', borderRadius: 8, padding: '3px 8px', outline: 'none', width: 240 }}
                  />
                ) : (
                  <div
                    onClick={beginEditNick}
                    title="Click to set a nickname"
                    style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}
                  >
                    <span style={{ fontSize: 16, fontWeight: 600, color: '#F2F5FB', fontFamily: nicknames[selectedConvo.peerHex] ? undefined : "'IBM Plex Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(selectedConvo.peerHex)}</span>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.2}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                  <span style={{ fontSize: 12, color: 'var(--accT,#7DE9D8)', fontWeight: 500 }}>End-to-end encrypted</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
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

            {selectedConvo.messages.map((m) => (
              m.direction === 'received' ? (
                /* Incoming */
                <div key={m.id} style={{ alignSelf: 'flex-start', maxWidth: '62%' }}>
                  <div style={{ padding: '13px 17px', borderRadius: '4px 16px 16px 16px', background: '#161C28', color: '#E4EAF4', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.plaintext}</div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', marginTop: 5, marginLeft: 4 }}>{bubbleTime(m.timestamp)}</div>
                </div>
              ) : (
                /* Outgoing */
                <div key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'linear-gradient(160deg, #1C7A6E, #12655A)', color: '#EAFBF7', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.plaintext}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', marginTop: 5, marginRight: 4 }}>
                    {bubbleTime(m.timestamp)}
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
                  </div>
                </div>
              )
            ))}
            {/* Auto-scroll anchor */}
            <div ref={bottomRef} />
          </div>

          {/* Composer */}
          {(() => {
            const canSend = !!draft.trim() && !sending
            const showCounter = draft.length >= MAX_MESSAGE_LEN - 200
            return (
            <div style={{ padding: '16px 24px 20px', borderTop: '1px solid rgba(120,150,210,0.1)' }}>
              {/* Send failure — inline, draft preserved */}
              {sendError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 10, fontSize: 12, color: '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.45 }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx={12} cy={12} r={10} /><path d="M12 8v4M12 16h.01" /></svg>
                  <span style={{ wordBreak: 'break-word' }}>Couldn't send — {sendError}</span>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
                {/* TARI button (inert — M10) */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, flexShrink: 0, borderRadius: 13, background: 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))', cursor: 'pointer', boxShadow: '0 0 18px rgba(var(--accRGB,45,224,198),0.28)' }} title="Attach confidential payment">
                  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="var(--accOn,#04120F)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                </div>
                {/* Text input */}
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderRadius: 14, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)' }}>
                  <textarea
                    ref={composerRef}
                    className="cv-composer"
                    value={draft}
                    onChange={e => { setDraft(e.target.value); if (sendError) setSendError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                    placeholder="Write an encrypted message…"
                    rows={1}
                    maxLength={MAX_MESSAGE_LEN}
                    disabled={sending}
                    style={{ flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: '#E4EAF4', fontSize: 15, fontFamily: 'inherit', lineHeight: 1.4, maxHeight: COMPOSER_MAX_H, overflowY: 'auto', padding: 0, display: 'block' }}
                  />
                  <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx={12} cy={12} r={10} /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></svg>
                </div>
                {/* Send button */}
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  title="Send message"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, flexShrink: 0, borderRadius: 13, background: '#161C28', border: '1px solid rgba(120,150,210,0.16)', cursor: canSend ? 'pointer' : 'default', opacity: canSend || sending ? 1 : 0.5, padding: 0 }}
                >
                  {sending ? (
                    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth={2.5} strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                  ) : (
                    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={canSend ? 'var(--acc,#2DE0C6)' : '#8A97B4'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
                  )}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 11, paddingLeft: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2} strokeLinecap="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                  <span style={{ fontSize: 12, color: '#5E8A82' }}>Tap the <span style={{ color: 'var(--acc,#2DE0C6)', fontWeight: 600 }}>TARI</span> button to attach a confidential payment to your message</span>
                </div>
                {showCounter && (
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: draft.length >= MAX_MESSAGE_LEN ? '#FF6B6B' : '#8A97B4', flexShrink: 0 }}>
                    {draft.length}/{MAX_MESSAGE_LEN}
                  </span>
                )}
              </div>
              <style>{`.cv-composer::placeholder { color: #55617D; }`}</style>
            </div>
            )
          })()}
          </>
          )}
        </div>

      </div>
    </div>

    {walletOpen && <WalletModal onClose={() => setWalletOpen(false)} />}
    </>
  )
}
