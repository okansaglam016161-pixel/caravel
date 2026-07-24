import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import * as nip19 from 'nostr-tools/nip19'
import Logo from '../Logo'
import { useWallet } from '../../context/WalletContext'
import WalletModal from '../wallet/WalletModal'
import type { CaravelMessage } from '../../messaging/types'
import { loadNicknames, setNickname, MAX_NICKNAME_LEN, type NicknameMap } from '../../messaging/nicknameStore'
import { loadTariAddresses, setTariAddress, type TariAddressMap } from '../../messaging/tariAddressStore'
import { sendConfidential, tariToMicrotari } from '../../crypto/confidentialSend'
import { resolvePayment, type PaymentResolution } from '../../crypto/paymentResolver'
import { loadResolvedAmounts, cacheResolvedAmount } from '../../messaging/paymentResolutionStore'

// ── Conversation derivation ─────────────────────────────────────────────────────

interface Conversation {
  peerHex: string
  messages: CaravelMessage[]   // this peer's messages, oldest first
  lastMessage: CaravelMessage | null   // null only for a freshly-composed, message-less thread
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

// Fee ceiling shown in the confirm step (matches confidentialSend.MAX_FEE = 10_000 µtTARI).
const MAX_FEE_TARI = 0.01

// Decimal µTari string → TARI display string. Defensive; never throws.
function microToTari(micro: string): string {
  try { return (Number(BigInt(micro)) / 1_000_000).toFixed(6) } catch { return '—' }
}

// ── Payment resolution (M10.2) ────────────────────────────────────────────────

// In-flight dedup: one fetch per (identity, utxoId) even if several cards mount at once, or React
// StrictMode double-invokes the effect. Keyed by pubkey too so it can't leak across identities.
const inflightResolve = new Map<string, Promise<PaymentResolution>>()
function dedupResolve(myPubkeyHex: string, utxoId: string, viewSecret: Uint8Array): Promise<PaymentResolution> {
  const k = `${myPubkeyHex}:${utxoId}`
  const existing = inflightResolve.get(k)
  if (existing) return existing
  const p = resolvePayment(utxoId, viewSecret).finally(() => { inflightResolve.delete(k) })
  inflightResolve.set(k, p)
  return p
}

type ResolveState =
  | { kind: 'loading' }
  | { kind: 'retrying'; reason: 'not_found' | 'network_error' }
  | { kind: 'resolved'; amountMicrotari: string }
  | { kind: 'failed'; reason: 'not_found' | 'network_error' | 'spent' | 'unreadable' }

// Three bounded auto-retries after the first attempt, for transient failures only. No polling.
const RESOLVE_BACKOFFS_MS = [2_000, 4_000, 8_000]

// Lazily resolve a received payment's amount. Cache-first (persisted successes), then a single
// fetch with bounded backoff for transient failures (not_found = indexer lag, network_error).
// Terminal failures (spent, unreadable) never auto-retry. Timers are cleared on unmount; manual
// retry() re-runs the whole sequence.
function usePaymentResolution(utxoId: string): { state: ResolveState; retry: () => void } {
  const { wallet, nostrPubkeyHex } = useWallet()
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<ResolveState>(() => {
    if (nostrPubkeyHex) {
      const cached = loadResolvedAmounts(nostrPubkeyHex)[utxoId]
      if (cached) return { kind: 'resolved', amountMicrotari: cached }
    }
    return { kind: 'loading' }
  })

  useEffect(() => {
    if (!wallet || !nostrPubkeyHex) return
    const cached = loadResolvedAmounts(nostrPubkeyHex)[utxoId]
    if (cached) { setState({ kind: 'resolved', amountMicrotari: cached }); return }
    const viewSecret = wallet.getViewOnlySecret()
    if (!viewSecret) return

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    if (nonce > 0) setState({ kind: 'loading' })  // manual retry resets the visible state

    async function attempt(i: number) {
      const res = await dedupResolve(nostrPubkeyHex!, utxoId, viewSecret!)
      if (cancelled) return
      if (res.status === 'resolved') {
        cacheResolvedAmount(nostrPubkeyHex!, utxoId, res.amountMicrotari)
        setState({ kind: 'resolved', amountMicrotari: res.amountMicrotari })
        return
      }
      if (res.status === 'spent' || res.status === 'unreadable') {
        setState({ kind: 'failed', reason: res.status })   // terminal — never auto-retry
        return
      }
      // transient: not_found (spent-or-not-yet-indexed) or network_error
      if (i < RESOLVE_BACKOFFS_MS.length) {
        setState({ kind: 'retrying', reason: res.status })
        timers.push(setTimeout(() => attempt(i + 1), RESOLVE_BACKOFFS_MS[i]))
      } else {
        setState({ kind: 'failed', reason: res.status })   // retries exhausted
      }
    }
    attempt(0)
    return () => { cancelled = true; timers.forEach(clearTimeout) }
  }, [utxoId, wallet, nostrPubkeyHex, nonce])

  return { state, retry: () => setNonce(n => n + 1) }
}

// ── Payment card ──────────────────────────────────────────────────────────────

// Confidential-payment card in the thread (design recovered from git history, driven by real data).
// Sender shows the amount from its local cache (never on the wire). Recipient resolves the true
// amount from the referenced UTXO with its own view key. The note ALWAYS renders (M10.0 guarantee).

function BigAmount({ tari }: { tari: string }) {
  return (
    <div style={{ fontSize: 34, fontWeight: 800, color: '#EAFBF7', letterSpacing: '0.02em', display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8 }}>
      <span>{tari}</span>
      <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--acc,#2DE0C6)' }}>TARI</span>
    </div>
  )
}

// Recipient-side amount area: renders the resolution state. String literals avoid apostrophes.
function ResolvedAmount({ state, retry }: { state: ResolveState; retry: () => void }) {
  if (state.kind === 'resolved') return <BigAmount tari={microToTari(state.amountMicrotari)} />

  if (state.kind === 'loading' || state.kind === 'retrying') {
    const msg = state.kind === 'retrying' && state.reason === 'not_found'
      ? 'Waiting for the payment to be indexed…'
      : state.kind === 'retrying' && state.reason === 'network_error'
        ? 'Reaching the indexer…'
        : 'Resolving amount…'
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13, color: '#8FB7B0', fontFamily: "'IBM Plex Mono', monospace" }}>
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#8FB7B0" strokeWidth={2.5} strokeLinecap="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
        {msg}
      </div>
    )
  }

  // failed
  const canRetry = state.reason === 'not_found' || state.reason === 'network_error'
  const label =
    state.reason === 'spent' ? 'Payment output has been spent'
      : state.reason === 'unreadable' ? 'Not addressed to this wallet — cannot read the amount'
        : state.reason === 'not_found' ? 'Payment output not found — it may be spent, or not yet indexed'
          : 'Could not reach the indexer'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ fontSize: 13, color: '#C79A5B', textAlign: 'center', lineHeight: 1.4 }}>{label}</div>
      {canRetry && (
        <button onClick={retry} style={{ padding: '5px 14px', borderRadius: 8, border: '1px solid rgba(var(--accRGB,45,224,198),0.4)', background: 'transparent', color: 'var(--acc,#2DE0C6)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
          Retry
        </button>
      )}
    </div>
  )
}

// Shared card chrome; the amount area is a slot supplied by the sender/recipient variant.
function PaymentCardShell({ sent, timestamp, plaintext, amountSlot }: { sent: boolean; timestamp: number; plaintext: string; amountSlot: ReactNode }) {
  return (
    <div style={{ alignSelf: sent ? 'flex-end' : 'flex-start', maxWidth: '68%', width: 400 }}>
      <div style={{ borderRadius: sent ? '18px 6px 18px 18px' : '6px 18px 18px 18px', overflow: 'hidden', border: '1px solid rgba(var(--accRGB,45,224,198),0.4)', background: 'linear-gradient(165deg, #0E2A28, #0A1A1C)', boxShadow: '0 0 34px rgba(var(--accRGB,45,224,198),0.16)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 18px', background: 'linear-gradient(180deg, rgba(var(--accRGB,45,224,198),0.16), rgba(var(--accRGB,45,224,198),0.05))', borderBottom: '1px solid rgba(var(--accRGB,45,224,198),0.22)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 8, background: 'rgba(var(--accRGB,45,224,198),0.18)' }}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accT,#7DE9D8)', letterSpacing: '0.06em' }}>CONFIDENTIAL PAYMENT</span>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: 'var(--acc,#2DE0C6)' }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.2}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            {sent ? 'Sent' : 'Received'}
          </span>
        </div>
        {/* Amount (slot) */}
        <div style={{ padding: '20px 18px 8px', textAlign: 'center' }}>
          {amountSlot}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '4px 11px', borderRadius: 100, background: 'rgba(120,150,210,0.08)' }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#8FB7B0" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx={12} cy={12} r={3} /><path d="M4 4l16 16" /></svg>
            <span style={{ fontSize: 11, color: '#8FB7B0', fontFamily: "'IBM Plex Mono', monospace" }}>amount hidden on-chain</span>
          </div>
        </div>
        {/* Private note — always rendered */}
        <div style={{ margin: '12px 14px 16px', padding: '13px 15px', borderRadius: 12, background: 'rgba(10,14,23,0.6)', border: '1px dashed rgba(var(--accRGB,45,224,198),0.28)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#5E8A82" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></svg>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', color: '#5E8A82' }}>PRIVATE NOTE</span>
          </div>
          <div style={{ fontSize: 14, color: '#C7E4DD', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{plaintext}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#55617D', marginTop: 6, marginRight: sent ? 4 : 0, marginLeft: sent ? 0 : 4, justifyContent: sent ? 'flex-end' : 'flex-start' }}>
        {bubbleTime(timestamp)}
        {sent && <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>}
      </div>
    </div>
  )
}

function SentPaymentCard({ message }: { message: CaravelMessage }) {
  const amount = message.localPayment ? microToTari(message.localPayment.amountMicrotari) : null
  const amountSlot = amount !== null
    ? <BigAmount tari={amount} />
    : <div style={{ fontSize: 18, fontWeight: 700, color: '#C7E4DD' }}>Confidential payment</div>
  return <PaymentCardShell sent timestamp={message.timestamp} plaintext={message.plaintext} amountSlot={amountSlot} />
}

function ReceivedPaymentCard({ message }: { message: CaravelMessage }) {
  const { state, retry } = usePaymentResolution(message.payment!.utxoId)
  return <PaymentCardShell sent={false} timestamp={message.timestamp} plaintext={message.plaintext} amountSlot={<ResolvedAmount state={state} retry={retry} />} />
}

function PaymentMessageCard({ message }: { message: CaravelMessage }) {
  return message.direction === 'sent'
    ? <SentPaymentCard message={message} />
    : <ReceivedPaymentCard message={message} />
}

// ── Component ────────────────────────────────────────────────────────────────────

export default function ChatApp() {
  const { wallet, address, scan, messages, nostrPubkeyHex, messagingStatus, contacts, acceptContact, createMessagingProvider, recordSentMessage, deleteConversation } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)
  const [balanceHidden, setBalanceHidden] = useState(false)

  // Selected conversation (peer hex). UI state only — falls back to most-recent when unset.
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)

  // Conversation ⋯ menu + delete confirmation.
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Compose-new-conversation modal.
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeNpub, setComposeNpub] = useState('')
  const [composeError, setComposeError] = useState<string | null>(null)

  // Composer state.
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  // Payment (TARI) composer state.
  const [paymentMode, setPaymentMode] = useState(false)
  const [payAmount, setPayAmount] = useState('')       // tTARI, as typed
  const [payAddress, setPayAddress] = useState('')     // recipient otl_esm_ (manual — see caveat)
  const [confirming, setConfirming] = useState(false)  // inline confirm panel shown
  const [payBusy, setPayBusy] = useState(false)        // payment/message in flight
  const [payProgress, setPayProgress] = useState<string | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  // Persistent, must-acknowledge banner for the two dangerous outcomes: a payment that went
  // through but whose message failed (orphan), or a payment left unconfirmed (timeout).
  const [payAlert, setPayAlert] = useState<{ kind: 'orphan' | 'timeout'; txId: string; amountTari: string } | null>(null)

  // Remembered recipient Tari addresses for the current identity (temporary bridge — see store).
  const [tariAddresses, setTariAddresses] = useState<TariAddressMap>({})
  useEffect(() => {
    setTariAddresses(nostrPubkeyHex ? loadTariAddresses(nostrPubkeyHex) : {})
  }, [nostrPubkeyHex])

  // Nicknames for the current identity, loaded from localStorage and re-derived on save.
  const [nicknames, setNicknames] = useState<NicknameMap>({})
  useEffect(() => {
    setNicknames(nostrPubkeyHex ? loadNicknames(nostrPubkeyHex) : {})
  }, [nostrPubkeyHex])

  // Inline nickname edit state (header).
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState('')

  // All peers with messages, split by effective contact state. Lazy migration: no record +
  // has messages ⇒ 'accepted'. Only accepted peers are shown as conversations; pending peers are
  // held back for the M9.0c request UI (exposed here as a count).
  const allConvos = useMemo(() => deriveConversations(messages), [messages])
  const conversations = useMemo(
    () => allConvos.filter(c => (contacts[c.peerHex]?.state ?? 'accepted') === 'accepted'),
    [allConvos, contacts],
  )
  const pendingRequests = useMemo(
    () => allConvos.filter(c => contacts[c.peerHex]?.state === 'pending'),
    [allConvos, contacts],
  )
  // Selected conversation. A composed (accepted) peer may have no messages yet — synthesise an
  // empty thread for it so the composer can send the first message (it enters the list on send).
  const selectedConvo: Conversation | null = (() => {
    if (selectedPeer) {
      const found = conversations.find(c => c.peerHex === selectedPeer)
      if (found) return found
      if (contacts[selectedPeer]?.state === 'accepted') {
        return { peerHex: selectedPeer, messages: [], lastMessage: null, lastActivity: 0 }
      }
    }
    return conversations[0] ?? null
  })()

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

  // Delete the selected conversation and everything tied to it (local-only). Context tombstones
  // the message ids FIRST then clears messages + resolved amounts; here we clear the nickname and
  // Tari address (whose React state ChatApp owns), then fall back to another conversation / empty.
  function performDelete() {
    if (!selectedConvo) return
    const peer = selectedConvo.peerHex
    deleteConversation(peer)
    if (nostrPubkeyHex) {
      setNicknames(prev => setNickname(nostrPubkeyHex, prev, peer, ''))
      setTariAddresses(prev => setTariAddress(nostrPubkeyHex, prev, peer, ''))
    }
    setSelectedPeer(null)   // fall back to most-recent remaining conversation, or the empty state
    setConfirmDelete(false)
    setMenuOpen(false)
  }

  // ── Compose / requests (M9.0c) ────────────────────────────────────────────────

  // Start (or jump to) a conversation with an npub. Initiating accepts them (M9.0b). Uniform for
  // brand-new (empty thread), already-accepted (jump), and pending (promote) — acceptContact is
  // idempotent. Self (my own npub) is allowed: a notes-to-self thread.
  function startConversation() {
    const raw = composeNpub.trim()
    if (!raw) { setComposeError('Enter an npub.'); return }
    let hex: string
    try {
      const decoded = nip19.decode(raw)
      if (decoded.type !== 'npub') { setComposeError('That is not an npub (expected npub1…).'); return }
      hex = decoded.data
    } catch {
      setComposeError('Invalid npub — could not decode it.')
      return
    }
    acceptContact(hex)      // initiate = accept (creates/promotes/refreshes the accepted record)
    setSelectedPeer(hex)    // open it (empty thread if brand-new, or the existing conversation)
    setComposeOpen(false)
    setComposeNpub('')
    setComposeError(null)
  }

  // Accept a pending request → promotes to a normal conversation and opens it. No address exchange
  // (that is M9.0d) — accept only changes contact state.
  function acceptRequest(peerHex: string) {
    acceptContact(peerHex)
    setSelectedPeer(peerHex)
  }

  // Decline a pending request → M9.0a delete + tombstone + removeContact (hide-and-forget). A future
  // message from them creates a fresh request.
  function declineRequest(peerHex: string) {
    deleteConversation(peerHex)
    if (nostrPubkeyHex) {
      setNicknames(prev => setNickname(nostrPubkeyHex, prev, peerHex, ''))
      setTariAddresses(prev => setTariAddress(nostrPubkeyHex, prev, peerHex, ''))
    }
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

  // ── Payment (TARI) flow ──────────────────────────────────────────────────────

  function toggleTari() {
    if (payBusy) return
    setPaymentMode(prev => {
      const next = !prev
      if (next) {
        // Entering payment mode: prefill the remembered address for this peer, if any.
        if (selectedConvo) setPayAddress(tariAddresses[selectedConvo.peerHex] ?? '')
        setPayError(null)
      } else {
        setConfirming(false)
      }
      return next
    })
  }

  function validatePayment(): string | null {
    const amt = Number(payAmount)
    if (!payAmount.trim() || !isFinite(amt) || amt <= 0) return 'Enter an amount greater than 0.'
    if (!payAddress.trim().startsWith('otl_esm_')) return 'Enter a valid recipient Tari address (otl_esm_…).'
    return null
  }

  // Send button: in payment mode this validates and opens the confirm gate; otherwise plain send.
  function onComposerSend() {
    if (paymentMode) {
      const err = validatePayment()
      if (err) { setPayError(err); return }
      setPayError(null)
      setConfirming(true)
    } else {
      handleSend()
    }
  }

  // Runs only after the user confirms. Sequencing (decided): pre-flight connection check → real
  // confidential payment → only on Commit send the message carrying the recipient UTXO id.
  async function submitPayment() {
    if (!selectedConvo) return
    setConfirming(false)
    setPayError(null)

    // PRE-FLIGHT: never spend money we cannot announce.
    if (messagingStatus !== 'connected' && messagingStatus !== 'degraded') {
      setPayError('Not connected to relays — cannot announce the payment. Try again once connected.')
      return
    }
    if (!wallet || !address) { setPayError('Wallet is locked — unlock to send.'); return }

    const amountMicro = tariToMicrotari(Number(payAmount))
    const recipientAddr = payAddress.trim()
    const note = draft.trim() || '💸 Payment'   // NIP-44 needs ≥1 byte; empty note gets a caption
    const peerHex = selectedConvo.peerHex
    const amountShown = payAmount

    setPayBusy(true)
    setPayProgress('Starting payment…')
    try {
      const result = await sendConfidential(wallet, address, {
        recipient: recipientAddr,
        amountMicrotari: amountMicro,
        onProgress: (m) => setPayProgress(m),
      })

      if (result.outcome === 'Reject') {
        // Nothing happened — keep payment mode + fields so the user can adjust and retry.
        setPayError('Payment was rejected on-chain — nothing was sent.')
        return
      }
      if (result.outcome === 'Timeout') {
        // Unconfirmed: do NOT announce. Missing beats broken. Exit payment mode to avoid a re-pay.
        setPayAlert({ kind: 'timeout', txId: result.txId, amountTari: amountShown })
        setPaymentMode(false)
        return
      }
      // Commit — need the recipient UTXO id to reference the payment.
      if (!result.recipientUtxoId) {
        setPayAlert({ kind: 'orphan', txId: result.txId, amountTari: amountShown })
        setPaymentMode(false)
        return
      }

      // Announce: send the message carrying the payment reference.
      setPayProgress('Payment confirmed — sending the message…')
      const provider = createMessagingProvider()
      if (!provider) {
        setPayAlert({ kind: 'orphan', txId: result.txId, amountTari: amountShown })
        setPaymentMode(false)
        return
      }
      try {
        const msg = await provider.sendMessage(peerHex, note, { utxoId: result.recipientUtxoId })
        provider.disconnect()
        // Cache the amount + txId LOCALLY (never on the wire) so our thread renders the amount.
        const withLocal: CaravelMessage = { ...msg, localPayment: { amountMicrotari: amountMicro.toString(), txId: result.txId } }
        recordSentMessage(withLocal)
        // Success: remember the address for next time, clear the composer + payment mode.
        if (nostrPubkeyHex) setTariAddresses(prev => setTariAddress(nostrPubkeyHex, prev, peerHex, recipientAddr))
        setDraft('')
        setPayAmount('')
        setPaymentMode(false)
      } catch {
        // The dangerous case: the payment went through but the message did not.
        setPayAlert({ kind: 'orphan', txId: result.txId, amountTari: amountShown })
        setPaymentMode(false)
      }
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e))
    } finally {
      setPayBusy(false)
      setPayProgress(null)
    }
  }

  // Auto-scroll to newest: on conversation open and whenever this thread gains a message.
  const bottomRef = useRef<HTMLDivElement>(null)
  const selectedPeerHex = selectedConvo?.peerHex ?? null
  const selectedCount = selectedConvo?.messages.length ?? 0
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [selectedPeerHex, selectedCount])

  // Reset the payment composer when switching conversations so a half-filled payment can't carry
  // across to a different peer. The must-acknowledge alert banner is intentionally NOT reset here.
  useEffect(() => {
    setPaymentMode(false)
    setConfirming(false)
    setPayError(null)
    setPayAmount('')
    setMenuOpen(false)
  }, [selectedPeerHex])

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
              <button
                onClick={() => { setComposeNpub(''); setComposeError(null); setComposeOpen(true) }}
                title="Start a new conversation"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: '1px solid rgba(120,150,210,0.2)', background: 'transparent', cursor: 'pointer', padding: 0 }}
              >
                <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </button>
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

          {/* Requests (M9.0c) — pending peers who messaged first. Distinct from conversations; no
              reply is possible until accepted. Payment previews here deliberately do NOT resolve the
              amount: an unaccepted stranger could reference a UTXO, and we must not fire indexer
              fetches on their behalf before I choose to engage (network work + unsolicited contact).
              The note always renders as inert, auto-escaped text (M10.0 guarantee, no HTML/markdown). */}
          {pendingRequests.length > 0 && (
            <div style={{ padding: '4px 12px 8px', borderBottom: '1px solid rgba(120,150,210,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px 8px' }}>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx={12} cy={7} r={4} /></svg>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--accT,#7DE9D8)' }}>REQUESTS ({pendingRequests.length})</span>
              </div>
              {pendingRequests.map(req => {
                const av = avatarFor(req.peerHex)
                const last = req.lastMessage
                const preview = !last ? '' : last.payment ? 'Confidential payment' : last.plaintext
                return (
                  <div key={req.peerHex} style={{ display: 'flex', gap: 11, padding: '10px 6px', borderRadius: 10 }}>
                    <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 12, background: av.grad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: av.color }}>··</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: '#E8EEF9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncNpub(req.peerHex)}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: '#8A97B4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                        {last?.payment && <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2} style={{ flexShrink: 0 }}><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button onClick={() => acceptRequest(req.peerHex)}
                          style={{ padding: '5px 14px', borderRadius: 8, border: 'none', background: 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))', color: 'var(--accOn,#04120F)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                          Accept
                        </button>
                        <button onClick={() => declineRequest(req.peerHex)}
                          style={{ padding: '5px 14px', borderRadius: 8, border: '1px solid rgba(120,150,210,0.25)', background: 'transparent', color: '#8A97B4', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                          Decline
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

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
                const preview = !c.lastMessage ? ''
                  : c.lastMessage.direction === 'sent' ? `You: ${c.lastMessage.plaintext}`
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
              {/* ⋯ menu */}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setMenuOpen(o => !o)}
                  title="Conversation options"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, border: '1px solid rgba(120,150,210,0.16)', background: menuOpen ? 'rgba(120,150,210,0.1)' : 'transparent', cursor: 'pointer', padding: 0 }}
                >
                  <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth={1.9} strokeLinecap="round"><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} /><circle cx={5} cy={12} r={1.6} /></svg>
                </button>
                {menuOpen && (
                  <>
                    {/* Invisible backdrop to close on outside click */}
                    <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                    <div style={{ position: 'absolute', top: 42, right: 0, zIndex: 41, minWidth: 190, padding: 6, borderRadius: 10, background: '#141A24', border: '1px solid rgba(120,150,210,0.18)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
                      <button
                        onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}
                        style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '9px 11px', borderRadius: 7, border: 'none', background: 'transparent', color: '#FF6B6B', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,107,107,0.1)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></svg>
                        Delete conversation
                      </button>
                    </div>
                  </>
                )}
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
              m.payment ? (
                /* Confidential payment */
                <PaymentMessageCard key={m.id} message={m} />
              ) : m.direction === 'received' ? (
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
            const paymentValid = validatePayment() === null
            const canSend = payBusy || confirming
              ? false
              : paymentMode ? paymentValid : (!!draft.trim() && !sending)
            const showCounter = draft.length >= MAX_MESSAGE_LEN - 200
            const inputsDisabled = sending || payBusy || confirming
            return (
            <div style={{ padding: '16px 24px 20px', borderTop: '1px solid rgba(120,150,210,0.1)' }}>

              {/* PERSISTENT alert — payment succeeded but message failed, or payment left unconfirmed.
                  Must be acknowledged explicitly; typing does not clear it. */}
              {payAlert && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, padding: '13px 15px', borderRadius: 12, background: 'rgba(255,140,40,0.10)', border: '1.5px solid rgba(255,150,50,0.55)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#FFB067" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#FFB067' }}>
                      {payAlert.kind === 'orphan' ? 'Payment sent — but the message did NOT' : 'Payment submitted — but not confirmed'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: '#E8D3B8', lineHeight: 1.5 }}>
                    {payAlert.kind === 'orphan'
                      ? <>The confidential payment of <b>{payAlert.amountTari} tTARI</b> went through, but the note could not be delivered. The recipient has the funds but no message or notification — follow up out-of-band.</>
                      : <>The confidential payment of <b>{payAlert.amountTari} tTARI</b> was submitted but is not yet confirmed, so no message was sent. Verify the transaction; if it commits, their background scan will find the funds.</>}
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#B79B7A', wordBreak: 'break-all' }}>tx {payAlert.txId}</div>
                  <button
                    onClick={() => setPayAlert(null)}
                    style={{ alignSelf: 'flex-start', marginTop: 2, padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(255,150,50,0.5)', background: 'transparent', color: '#FFB067', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    I have noted this
                  </button>
                </div>
              )}

              {/* Plain-message send failure — inline, draft preserved */}
              {sendError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 10, fontSize: 12, color: '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.45 }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx={12} cy={12} r={10} /><path d="M12 8v4M12 16h.01" /></svg>
                  <span style={{ wordBreak: 'break-word' }}>Couldn't send — {sendError}</span>
                </div>
              )}

              {/* Payment error (validation / reject / pre-flight) — draft + fields preserved */}
              {payError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 10, fontSize: 12, color: '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.45 }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx={12} cy={12} r={10} /><path d="M12 8v4M12 16h.01" /></svg>
                  <span style={{ wordBreak: 'break-word' }}>{payError}</span>
                </div>
              )}

              {/* Payment in flight — progress */}
              {payBusy && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12.5, color: 'var(--accT,#7DE9D8)', fontFamily: "'IBM Plex Mono', monospace" }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2.5} strokeLinecap="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                  <span>{payProgress ?? 'Working…'}</span>
                </div>
              )}

              {/* Payment fields — shown in payment mode, before the confirm gate */}
              {paymentMode && !confirming && !payBusy && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12, padding: '13px 15px', borderRadius: 12, background: 'rgba(var(--accRGB,45,224,198),0.05)', border: '1px solid rgba(var(--accRGB,45,224,198),0.25)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--accT,#7DE9D8)' }}>CONFIDENTIAL PAYMENT</span>
                    <button onClick={toggleTari} title="Cancel payment" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8A97B4', display: 'flex', padding: 2 }}>
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input
                      value={payAmount}
                      onChange={e => { setPayAmount(e.target.value); if (payError) setPayError(null) }}
                      placeholder="0.000000"
                      inputMode="decimal"
                      style={{ width: 140, background: '#10151F', border: '1px solid rgba(120,150,210,0.25)', borderRadius: 8, padding: '9px 12px', fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, color: '#EAFBF7', outline: 'none' }}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--acc,#2DE0C6)' }}>tTARI</span>
                  </div>
                  <input
                    value={payAddress}
                    onChange={e => { setPayAddress(e.target.value); if (payError) setPayError(null) }}
                    placeholder="Recipient Tari address (otl_esm_…)"
                    spellCheck={false}
                    style={{ background: '#10151F', border: '1px solid rgba(120,150,210,0.25)', borderRadius: 8, padding: '9px 12px', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: '#E4EAF4', outline: 'none', width: '100%', boxSizing: 'border-box' }}
                  />
                  {/* Honest caveat — a pasted address is NOT bound to this contact's Nostr identity */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11, color: '#C79A5B', lineHeight: 1.45 }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#C79A5B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                    <span>Address entered manually — not verified against this contact's identity.</span>
                  </div>
                </div>
              )}

              {/* Confirm gate — spending real testnet funds */}
              {confirming && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(var(--accRGB,45,224,198),0.06)', border: '1.5px solid rgba(var(--accRGB,45,224,198),0.45)' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accT,#7DE9D8)' }}>Confirm confidential payment</span>
                  <div style={{ fontSize: 13, color: '#D7E4E0', lineHeight: 1.6 }}>
                    Send <b style={{ color: '#EAFBF7' }}>{payAmount} tTARI</b> (plus up to {MAX_FEE_TARI} fee) to<br />
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: '#8FB7B0', wordBreak: 'break-all' }}>{payAddress.trim()}</span>
                    <br />with note “<span style={{ color: '#C7E4DD' }}>{draft.trim() || '💸 Payment'}</span>”.
                  </div>
                  <div style={{ fontSize: 11.5, color: '#C79A5B' }}>This is a real, irreversible testnet payment.</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                    <button onClick={submitPayment} style={{ padding: '9px 18px', borderRadius: 9, border: 'none', background: 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))', color: 'var(--accOn,#04120F)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                      Confirm &amp; send
                    </button>
                    <button onClick={() => setConfirming(false)} style={{ padding: '9px 18px', borderRadius: 9, border: '1px solid rgba(120,150,210,0.25)', background: 'transparent', color: '#8A97B4', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
                {/* TARI button — toggles payment mode */}
                <button
                  onClick={toggleTari}
                  disabled={payBusy}
                  title={paymentMode ? 'Cancel confidential payment' : 'Attach confidential payment'}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, flexShrink: 0, borderRadius: 13, border: paymentMode ? '2px solid var(--acc,#2DE0C6)' : 'none', background: paymentMode ? 'rgba(var(--accRGB,45,224,198),0.14)' : 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))', cursor: payBusy ? 'default' : 'pointer', boxShadow: paymentMode ? 'none' : '0 0 18px rgba(var(--accRGB,45,224,198),0.28)', padding: 0 }}
                >
                  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={paymentMode ? 'var(--acc,#2DE0C6)' : 'var(--accOn,#04120F)'} strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                </button>
                {/* Text input */}
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderRadius: 14, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)' }}>
                  <textarea
                    ref={composerRef}
                    className="cv-composer"
                    value={draft}
                    onChange={e => { setDraft(e.target.value); if (sendError) setSendError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onComposerSend() } }}
                    placeholder={paymentMode ? 'Add a note (optional)…' : 'Write an encrypted message…'}
                    rows={1}
                    maxLength={MAX_MESSAGE_LEN}
                    disabled={inputsDisabled}
                    style={{ flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: '#E4EAF4', fontSize: 15, fontFamily: 'inherit', lineHeight: 1.4, maxHeight: COMPOSER_MAX_H, overflowY: 'auto', padding: 0, display: 'block' }}
                  />
                  <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="#55617D" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx={12} cy={12} r={10} /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></svg>
                </div>
                {/* Send button */}
                <button
                  onClick={onComposerSend}
                  disabled={!canSend}
                  title={paymentMode ? 'Review payment' : 'Send message'}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, flexShrink: 0, borderRadius: 13, background: '#161C28', border: '1px solid rgba(120,150,210,0.16)', cursor: canSend ? 'pointer' : 'default', opacity: canSend ? 1 : 0.5, padding: 0 }}
                >
                  {(sending || payBusy) ? (
                    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth={2.5} strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                  ) : (
                    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={canSend ? 'var(--acc,#2DE0C6)' : '#8A97B4'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
                  )}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 11, paddingLeft: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2} strokeLinecap="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                  <span style={{ fontSize: 12, color: '#5E8A82' }}>
                    {paymentMode
                      ? <>Enter an amount and recipient address, then review before sending real funds</>
                      : <>Tap the <span style={{ color: 'var(--acc,#2DE0C6)', fontWeight: 600 }}>TARI</span> button to attach a confidential payment to your message</>}
                  </span>
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

    {/* Compose new conversation */}
    {composeOpen && (
      <div
        onClick={() => setComposeOpen(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,7,12,0.72)', padding: 24 }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{ width: '100%', maxWidth: 440, padding: '24px 24px 20px', borderRadius: 16, background: '#111722', border: '1px solid rgba(var(--accRGB,45,224,198),0.28)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 11, background: 'rgba(var(--accRGB,45,224,198),0.12)', flexShrink: 0 }}>
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#F2F5FB' }}>New conversation</div>
          </div>
          <div style={{ fontSize: 13, color: '#8A97B4', lineHeight: 1.55, marginBottom: 12 }}>
            Enter the recipient's Nostr public key (npub). Starting a conversation accepts them.
          </div>
          <input
            autoFocus
            value={composeNpub}
            onChange={e => { setComposeNpub(e.target.value); if (composeError) setComposeError(null) }}
            onKeyDown={e => { if (e.key === 'Enter') startConversation(); else if (e.key === 'Escape') setComposeOpen(false) }}
            placeholder="npub1…"
            spellCheck={false}
            style={{ width: '100%', boxSizing: 'border-box', background: '#10151F', border: `1px solid ${composeError ? 'rgba(255,107,107,0.5)' : 'rgba(120,150,210,0.25)'}`, borderRadius: 9, padding: '11px 13px', fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#E4EAF4', outline: 'none' }}
          />
          {composeError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, fontSize: 12, color: '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace" }}>
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx={12} cy={12} r={10} /><path d="M12 8v4M12 16h.01" /></svg>
              {composeError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
            <button
              onClick={() => setComposeOpen(false)}
              style={{ padding: '10px 18px', borderRadius: 9, border: '1px solid rgba(120,150,210,0.25)', background: 'transparent', color: '#8A97B4', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Cancel
            </button>
            <button
              onClick={startConversation}
              disabled={!composeNpub.trim()}
              style={{ padding: '10px 18px', borderRadius: 9, border: 'none', background: composeNpub.trim() ? 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))' : 'rgba(120,150,210,0.15)', color: composeNpub.trim() ? 'var(--accOn,#04120F)' : '#55617D', fontSize: 13, fontWeight: 700, cursor: composeNpub.trim() ? 'pointer' : 'default', fontFamily: 'inherit' }}
            >
              Start conversation
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Delete-conversation confirmation — destructive, localStorage is the only copy */}
    {confirmDelete && selectedConvo && (
      <div
        onClick={() => setConfirmDelete(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,7,12,0.72)', padding: 24 }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{ width: '100%', maxWidth: 420, padding: '24px 24px 20px', borderRadius: 16, background: '#111722', border: '1px solid rgba(255,107,107,0.3)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 11, background: 'rgba(255,107,107,0.12)', flexShrink: 0 }}>
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#F2F5FB' }}>Delete conversation?</div>
          </div>
          <div style={{ fontSize: 14, color: '#B4C0D4', lineHeight: 1.6, marginBottom: 20 }}>
            All messages, the nickname, and payment history with <b style={{ color: '#E8EEF9' }}>{displayName(selectedConvo.peerHex)}</b> will be permanently removed from this device and <b style={{ color: '#FF8A8A' }}>cannot be recovered</b>. The other person keeps their copy.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              onClick={() => setConfirmDelete(false)}
              style={{ padding: '10px 18px', borderRadius: 9, border: '1px solid rgba(120,150,210,0.25)', background: 'transparent', color: '#8A97B4', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Cancel
            </button>
            <button
              onClick={performDelete}
              style={{ padding: '10px 18px', borderRadius: 9, border: 'none', background: '#E5484D', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
