import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import * as nip19 from 'nostr-tools/nip19'
import Logo from '../primitives/Logo'
import { useWallet } from '../../context/WalletContext'
import WalletModal from '../wallet/WalletModal'
import ProfilePanel from '../wallet/ProfilePanel'
import type { CaravelMessage } from '../../messaging/types'
import { loadNicknames, setNickname, MAX_NICKNAME_LEN, type NicknameMap } from '../../messaging/nicknameStore'
import { loadAddressSent, markAddressSent, clearAddressSent, type AddressSentMap } from '../../messaging/addressSentStore'
import { sendConfidential, tariToMicrotari, MAX_FEE } from '../../crypto/confidentialSend'
import { resolvePayment, type PaymentResolution } from '../../crypto/paymentResolver'
import { resolveOnsNameToHex, toOnsName, type OnsResolveErrorKind } from '../../crypto/ons'
import { ConnectionIndicator, RelayHealthPanel } from './ConnectionStatus'
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

// Compact relative age for request rows: "3m" / "2h" / "1d".
function ageShort(ts: number): string {
  const mins = (Date.now() - ts) / 60_000
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`
  const hrs = mins / 60
  if (hrs < 24) return `${Math.round(hrs)}h`
  return `${Math.round(hrs / 24)}d`
}

// Stable avatar gradient per peer — the design's 5 avatar-token pairs (teal/slate/plum/moss/amber),
// assigned by hash of the contact key.
const AVATARS = [
  { grad: 'var(--avatar-teal)', color: 'var(--avatar-teal-ink)' },
  { grad: 'var(--avatar-slate)', color: 'var(--avatar-slate-ink)' },
  { grad: 'var(--avatar-plum)', color: 'var(--avatar-plum-ink)' },
  { grad: 'var(--avatar-moss)', color: 'var(--avatar-moss-ink)' },
  { grad: 'var(--avatar-amber)', color: 'var(--avatar-amber-ink)' },
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

// Fee ceiling shown in the confirm step. Reuses confidentialSend.MAX_FEE and the wallet's trimmed
// format so both surfaces render the identical "≤ 0.01 TARI".
const FEE_CEIL_TARI = (Number(MAX_FEE) / 1_000_000).toString()
const MONO = "'IBM Plex Mono', monospace"

// Compose-modal resolution state (Flag 1b). `ok` carries the resolved peer; `name` is the ONS name
// (null for a raw npub), `existing` true when it is already an accepted conversation.
type ComposeRes =
  | { s: 'idle' }
  | { s: 'invalid'; kind: 'not-npub' | 'bad-npub' }
  | { s: 'resolving'; name: string }
  | { s: 'ok'; hex: string; name: string | null }
  | { s: 'fail'; kind: OnsResolveErrorKind; name: string }

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

type CardTone = 'teal' | 'neutral' | 'danger'

function BigAmount({ tari }: { tari: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontFamily: MONO, fontSize: 34, fontWeight: 700, color: 'var(--text-bright)', letterSpacing: '0.02em' }}>{tari}</span>
      <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--teal-500)' }}>TARI</span>
    </div>
  )
}

const cardChrome: Record<CardTone, { border: string; bg: string; headerBg: string; headerBorder: string; title: string }> = {
  teal: { border: 'rgba(var(--teal-500-rgb),0.24)', bg: 'var(--card-payment)', headerBg: 'linear-gradient(180deg, rgba(var(--teal-500-rgb),0.12), rgba(var(--teal-500-rgb),0.04))', headerBorder: 'rgba(var(--teal-500-rgb),0.2)', title: 'var(--teal-300)' },
  neutral: { border: 'rgba(var(--border-rgb),0.18)', bg: 'var(--card-neutral)', headerBg: 'rgba(var(--border-rgb),0.04)', headerBorder: 'rgba(var(--border-rgb),0.1)', title: 'var(--text-muted-dim)' },
  danger: { border: 'rgba(var(--danger-rgb),0.28)', bg: 'var(--card-danger)', headerBg: 'rgba(var(--danger-rgb),0.06)', headerBorder: 'rgba(var(--danger-rgb),0.2)', title: 'var(--danger-300)' },
}

// Card chrome per resolution tone. The private note ALWAYS renders (M10.0) below the amount area.
function PaymentCard({ sent, tone, chip, timestamp, plaintext, body }: { sent: boolean; tone: CardTone; chip: string; timestamp: number; plaintext: string; body: ReactNode }) {
  const c = cardChrome[tone]
  const chipColor = tone === 'danger' ? 'var(--danger-300)' : (sent && tone === 'teal') ? 'var(--teal-500)' : 'var(--text-muted-dim)'
  const noteBorder = tone === 'teal' ? 'rgba(var(--teal-500-rgb),0.28)' : 'rgba(var(--border-rgb),0.2)'
  return (
    <div style={{ alignSelf: sent ? 'flex-end' : 'flex-start', maxWidth: '68%', width: 440 }}>
      <div style={{ borderRadius: sent ? '16px 6px 16px 16px' : '6px 16px 16px 16px', overflow: 'hidden', border: `1px solid ${c.border}`, background: c.bg }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 17px', background: c.headerBg, borderBottom: `1px solid ${c.headerBorder}` }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: c.title, letterSpacing: '0.06em' }}>CONFIDENTIAL PAYMENT</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: chipColor }}>{chip}</span>
        </div>
        <div style={{ padding: '20px 17px 8px', textAlign: 'center' }}>{body}</div>
        <div style={{ margin: '10px 14px 16px', padding: '13px 15px', borderRadius: 12, background: 'rgba(10,14,23,0.6)', border: `1px dashed ${noteBorder}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-teal-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></svg>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-teal-dim)' }}>PRIVATE NOTE</span>
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-note)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{plaintext}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)', marginTop: 6, marginRight: sent ? 4 : 0, marginLeft: sent ? 0 : 4, justifyContent: sent ? 'flex-end' : 'flex-start' }}>
        {bubbleTime(timestamp)}
        {sent && <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>}
      </div>
    </div>
  )
}

const hiddenPill = (
  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 2, padding: '4px 11px', borderRadius: 100, background: 'rgba(var(--border-rgb),0.08)' }}>
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-teal-label)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx={12} cy={12} r={3} /><path d="M4 4l16 16" /></svg>
    <span style={{ fontSize: 11, color: 'var(--text-teal-label)', fontFamily: MONO }}>amount hidden on chain</span>
  </div>
)
const spinner18 = <span style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.9s linear infinite', flexShrink: 0 }} />
const retryBtn = (retry: () => void) => (
  <span onClick={retry} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 10, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', fontSize: 13, fontWeight: 700, color: 'var(--danger-300)', cursor: 'pointer' }}>
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--danger-300)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>Retry
  </span>
)

function SentPaymentCard({ message }: { message: CaravelMessage }) {
  const amount = message.localPayment ? microToTari(message.localPayment.amountMicrotari) : null
  const body = amount !== null
    ? <>{<BigAmount tari={amount} />}{hiddenPill}</>
    : <>
        <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, color: 'var(--text-teal-label)', letterSpacing: '0.08em', marginBottom: 10 }}>••••</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 320, margin: '0 auto' }}>Sent from another device, so the amount isn’t cached here. The recipient can still see it.</div>
      </>
  return <PaymentCard sent tone="teal" chip="Sent" timestamp={message.timestamp} plaintext={message.plaintext} body={body} />
}

function ReceivedPaymentCard({ message }: { message: CaravelMessage }) {
  const { state, retry } = usePaymentResolution(message.payment!.utxoId)
  let tone: CardTone = 'teal', chip = 'Received', body: ReactNode
  if (state.kind === 'resolved') {
    body = <>{<BigAmount tari={microToTari(state.amountMicrotari)} />}{hiddenPill}</>
  } else if (state.kind === 'loading') {
    body = <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 11, padding: '2px 0 12px' }}>{spinner18}<span style={{ fontSize: 14, color: 'var(--text-teal-label)' }}>Resolving amount…</span></div>
  } else if (state.kind === 'retrying' && state.reason === 'not_found') {
    body = <><div style={{ fontSize: 14, fontWeight: 600, color: 'var(--teal-300)', marginBottom: 6 }}>Waiting for the payment to be indexed</div><div style={{ fontSize: 13, color: 'var(--text-teal-label)', lineHeight: 1.5 }}>The payment arrived. The amount will appear once the indexer catches up.</div></>
  } else if (state.kind === 'retrying') {
    body = <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 11, padding: '2px 0 12px' }}>{spinner18}<span style={{ fontSize: 14, color: 'var(--text-teal-label)' }}>Reaching the indexer…</span></div>
  } else if (state.reason === 'spent') {
    tone = 'neutral'; chip = 'Spent'
    body = <><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginBottom: 8 }}><svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg><span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' }}>Payment output has been spent</span></div><div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>You already used these funds. Nothing to claim here.</div></>
  } else if (state.reason === 'unreadable') {
    tone = 'neutral'; chip = 'Unreadable'
    body = <><div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Not addressed to this wallet</div><div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>This wallet can’t decrypt it. It may belong to another of your devices.</div></>
  } else if (state.reason === 'not_found') {
    tone = 'danger'; chip = 'Not found'
    body = <><div style={{ fontSize: 14, fontWeight: 600, color: 'var(--danger-300)', marginBottom: 6 }}>No matching output on chain</div><div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 14 }}>The note referenced a payment we can’t locate.</div>{retryBtn(retry)}</>
  } else {
    tone = 'danger'; chip = 'Error'
    body = <><div style={{ fontSize: 14, fontWeight: 600, color: 'var(--danger-300)', marginBottom: 6 }}>Couldn’t reach the network</div><div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 14 }}>The payment is fine. We just can’t read it right now.</div>{retryBtn(retry)}</>
  }
  return <PaymentCard sent={false} tone={tone} chip={chip} timestamp={message.timestamp} plaintext={message.plaintext} body={body} />
}

function PaymentMessageCard({ message }: { message: CaravelMessage }) {
  return message.direction === 'sent'
    ? <SentPaymentCard message={message} />
    : <ReceivedPaymentCard message={message} />
}

// ── Component ────────────────────────────────────────────────────────────────────

export default function ChatApp() {
  const { wallet, address, scan, messages, nostrPubkeyHex, messagingStatus, contacts, acceptContact, contactAddresses, setManualTariAddress, createMessagingProvider, recordSentMessage, deleteConversation, getRelayStates, reconnectAll, balanceHidden, setBalanceHidden } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  // The user's own generated avatar (deterministic gradient from their pubkey hash) — used for the
  // sidebar profile button and the Profile panel's identity block.
  const selfAvatar = avatarFor(nostrPubkeyHex ?? '')
  const [sidebarQuery, setSidebarQuery] = useState('')
  const [relayPanelOpen, setRelayPanelOpen] = useState(false)

  // Selected conversation (peer hex). UI state only — falls back to most-recent when unset.
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)

  // Conversation ⋯ menu + delete confirmation.
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Compose-new-conversation modal.
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeNpub, setComposeNpub] = useState('')
  // Compose resolution state machine — driven by an eager, debounced resolve of the input (Flag 1b).
  const [composeRes, setComposeRes] = useState<ComposeRes>({ s: 'idle' })
  // Bumped by the "Try again" button on an unreachable failure to re-fire resolution unchanged.
  const [composeRetry, setComposeRetry] = useState(0)
  // Per-request in-flight guard (Flag 2) — disables both buttons + shows a spinner while accepting/
  // declining. Local UI only; acceptRequest/declineRequest are unchanged.
  const [busyRequest, setBusyRequest] = useState<{ peerHex: string; kind: 'accept' | 'decline' } | null>(null)

  // Composer state.
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // Per-message send overlay (design lifecycle): provisional bubbles rendered while a plain-text
  // send is in flight, then removed once the real persisted message appears (or marked 'failed').
  // ChatApp-local only — never persisted, never on the wire; the send path itself is unchanged.
  const [pendingSends, setPendingSends] = useState<{ id: string; peerHex: string; text: string; status: 'sending' | 'failed' }[]>([])

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

  // "Have I delivered my Tari address to this peer?" — drives the self-healing piggyback (M9.0d).
  const [addressSent, setAddressSent] = useState<AddressSentMap>({})
  useEffect(() => {
    setAddressSent(nostrPubkeyHex ? loadAddressSent(nostrPubkeyHex) : {})
  }, [nostrPubkeyHex])
  function markSent(peerHex: string) {
    if (nostrPubkeyHex) setAddressSent(prev => markAddressSent(nostrPubkeyHex, prev, peerHex))
  }
  // My address to attach to an outbound message, or undefined once the peer already has it.
  function outboundAddressFor(peerHex: string): string | undefined {
    return address && !addressSent[peerHex] ? address : undefined
  }
  // Send my address as a dedicated silent control message (initiate/accept); mark delivered on
  // relay-accept. Fire-and-forget — failures self-heal via the next message's piggyback.
  function sendAddressControl(peerHex: string) {
    if (!address) return
    const provider = createMessagingProvider()
    if (!provider) return
    provider.sendContactAddress(peerHex, address)
      .then(ok => { if (ok) markSent(peerHex) })
      .catch(() => { /* self-heals via piggyback on the next normal message */ })
      .finally(() => provider.disconnect())
  }

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

  // Sidebar search (real) — filter conversations + requests by name, npub handle, or last-message text.
  const sq = sidebarQuery.trim().toLowerCase()
  const matchPeer = (peerHex: string, preview: string) =>
    !sq || displayName(peerHex).toLowerCase().includes(sq) || truncNpub(peerHex).toLowerCase().includes(sq) || preview.toLowerCase().includes(sq)
  const filteredConversations = conversations.filter(c => matchPeer(c.peerHex, c.lastMessage?.plaintext ?? ''))
  const filteredRequests = pendingRequests.filter(r => matchPeer(r.peerHex, r.lastMessage?.plaintext ?? ''))

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
    deleteConversation(peer)   // clears messages + contact record + Tari address + payment cache
    if (nostrPubkeyHex) {
      setNicknames(prev => setNickname(nostrPubkeyHex, prev, peer, ''))
      setAddressSent(prev => clearAddressSent(nostrPubkeyHex, prev, peer))  // re-exchange if re-added
    }
    setSelectedPeer(null)   // fall back to most-recent remaining conversation, or the empty state
    setConfirmDelete(false)
    setMenuOpen(false)
  }

  // ── Compose / requests (M9.0c) ────────────────────────────────────────────────

  // Start (or jump to) a conversation with a resolved peer key. Initiating accepts them (M9.0b) —
  // acceptContact is idempotent, so this is uniform for brand-new / already-accepted / existing.
  // (Downstream is byte-identical to the old startConversation; only the resolution moved earlier.)
  function startWith(hex: string) {
    acceptContact(hex)      // initiate = accept (creates/promotes/refreshes the accepted record)
    sendAddressControl(hex) // M9.0d: exchange my Tari address (silent) — I initiated
    setSelectedPeer(hex)    // open it (empty thread if brand-new, or the existing conversation)
    setComposeOpen(false)
    setComposeNpub('')
    setComposeRes({ s: 'idle' })
  }

  // Eager, debounced resolution of the compose input (Flag 1b). Resolution logic is unchanged
  // (nip19.decode for npub, resolveOnsNameToHex for @names) — only WHEN it runs moved from the old
  // Start click to on-type (~350ms debounce). A token guards against stale async writes.
  const composeToken = useRef(0)
  useEffect(() => {
    if (!composeOpen) return
    const raw = composeNpub.trim()
    const token = ++composeToken.current
    if (!raw) { setComposeRes({ s: 'idle' }); return }
    if (raw.startsWith('npub1')) {
      try {
        const decoded = nip19.decode(raw)
        if (decoded.type !== 'npub') { setComposeRes({ s: 'invalid', kind: 'bad-npub' }); return }
        setComposeRes({ s: 'ok', hex: decoded.data as string, name: null })
      } catch { setComposeRes({ s: 'invalid', kind: 'bad-npub' }) }
      return
    }
    const name = toOnsName(raw)
    if (!/^[a-z0-9_-]+$/.test(name)) { setComposeRes({ s: 'invalid', kind: 'not-npub' }); return }
    setComposeRes({ s: 'resolving', name })
    const timer = setTimeout(async () => {
      const res = await resolveOnsNameToHex(raw)
      if (composeToken.current !== token) return   // input changed while resolving — drop stale result
      if (res.ok && res.hex) setComposeRes({ s: 'ok', hex: res.hex, name })
      else setComposeRes({ s: 'fail', kind: res.errorKind ?? 'not-found', name })
    }, 350)
    return () => clearTimeout(timer)
  }, [composeNpub, composeOpen, composeRetry])

  // Accept a pending request → promotes to a normal conversation and opens it. Sends my Tari
  // address (M9.0d); accept still does NOT do anything else (no auto-reply).
  function acceptRequest(peerHex: string) {
    acceptContact(peerHex)
    sendAddressControl(peerHex)
    setSelectedPeer(peerHex)
  }

  // Decline a pending request → M9.0a delete + tombstone + removeContact (hide-and-forget). A future
  // message from them creates a fresh request.
  function declineRequest(peerHex: string) {
    deleteConversation(peerHex)   // also clears their Tari address
    if (nostrPubkeyHex) {
      setNicknames(prev => setNickname(nostrPubkeyHex, prev, peerHex, ''))
      setAddressSent(prev => clearAddressSent(nostrPubkeyHex, prev, peerHex))
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
    const peer = selectedConvo.peerHex
    // Overlay (flag 1): show a provisional "sending" bubble immediately. Additive — the send path
    // below is unchanged.
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setPendingSends(p => [...p, { id: tempId, peerHex: peer, text, status: 'sending' }])
    try {
      const provider = createMessagingProvider()
      // Locked wallet → null. Surface a clear reason rather than leaking a null-reference error.
      if (!provider) throw new Error('Wallet is locked — unlock to send')
      // Self-healing address exchange (M9.0d): piggyback my address until the peer has it.
      const addr = outboundAddressFor(peer)
      const msg = await provider.sendMessage(peer, text, undefined, addr)
      provider.disconnect()
      recordSentMessage(msg)
      if (addr) markSent(peer)
      setDraft('')  // clear only on success — a failed send keeps the text
      setPendingSends(p => p.filter(x => x.id !== tempId))  // real persisted bubble now shows
    } catch (e) {
      // The design's failed bubble shows only "Couldn't send" + Retry (no raw string), so log the
      // underlying relay error here — a systematic failure stays diagnosable in the console.
      console.warn('[Caravel] message send failed:', e)
      setSendError(e instanceof Error ? e.message : String(e))
      setPendingSends(p => p.map(x => x.id === tempId ? { ...x, status: 'failed' } : x))  // failed bubble + Retry; draft kept
    } finally {
      setSending(false)
    }
  }

  // Retry a failed provisional send: drop the failed bubble and re-run the send (the draft still
  // holds the text, since a failed send never clears it).
  function retrySend(id: string) {
    setPendingSends(p => p.filter(x => x.id !== id))
    handleSend()
  }

  // ── Payment (TARI) flow ──────────────────────────────────────────────────────

  function toggleTari() {
    if (payBusy) return
    setPaymentMode(prev => {
      const next = !prev
      if (next) {
        // Entering payment mode: prefill the known address for this peer (exchanged or manual).
        if (selectedConvo) setPayAddress(contactAddresses[selectedConvo.peerHex]?.address ?? '')
        setPayError(null)
      } else {
        setConfirming(false)
      }
      return next
    })
  }

  // M9.0e: recipient address state. If the peer has an EXCHANGED (identity-bound) address, use it
  // silently — no field, no warning. Computed live from contactAddresses so an address arriving
  // while the composer is open upgrades the UI without re-opening. Manual/no-address fall through
  // to the M10.1 field + warning unchanged.
  const peerAddrRec = selectedConvo ? contactAddresses[selectedConvo.peerHex] : undefined
  const addressVerified = peerAddrRec?.source === 'exchanged'
  const effectivePayAddress = addressVerified ? peerAddrRec!.address : payAddress.trim()

  // Insufficient-balance pre-check (flag 3b): same rule as the wallet's validateSendForm —
  // amount + MAX_FEE must not exceed the confidential balance. Additive guard; never blocks a
  // valid send. `payInsufficient` drives the design's inline pre-check state in the composer.
  const payAmountNum = Number(payAmount)
  const payInsufficient = !!payAmount.trim() && isFinite(payAmountNum) && payAmountNum > 0
    && scan.balance !== null && tariToMicrotari(payAmountNum) + MAX_FEE > scan.balance

  function validatePayment(): string | null {
    const amt = Number(payAmount)
    if (!payAmount.trim() || !isFinite(amt) || amt <= 0) return 'Enter an amount greater than 0.'
    if (!effectivePayAddress.startsWith('otl_esm_')) return 'Enter a valid recipient Tari address (otl_esm_…).'
    if (payInsufficient) return 'Insufficient balance.'
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
    const recipientAddr = effectivePayAddress   // exchanged address, or the manually-entered one
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
        // Piggyback my address (M9.0d self-healing) on this payment message too, if not yet sent.
        const addr = outboundAddressFor(peerHex)
        const msg = await provider.sendMessage(peerHex, note, { utxoId: result.recipientUtxoId }, addr)
        provider.disconnect()
        if (addr) markSent(peerHex)
        // Cache the amount + txId LOCALLY (never on the wire) so our thread renders the amount.
        const withLocal: CaravelMessage = { ...msg, localPayment: { amountMicrotari: amountMicro.toString(), txId: result.txId } }
        recordSentMessage(withLocal)
        // Success: remember a MANUALLY-entered address for next time (an exchanged one is already
        // stored + authoritative, so don't re-store it as manual). Clear the composer + mode.
        if (!addressVerified) setManualTariAddress(peerHex, recipientAddr)
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

  return (
    <>
    <div style={{ height: '100vh', display: 'flex', background: 'var(--surface-base)' }}>
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>

        {/* LEFT: sidebar */}
        <div style={{ width: 380, flexShrink: 0, borderRight: '1px solid rgba(var(--border-rgb),0.1)', display: 'flex', flexDirection: 'column', background: 'var(--surface-sidebar)', position: 'relative' }}>

          {relayPanelOpen && <RelayHealthPanel getRelayStates={getRelayStates} reconnectAll={reconnectAll} onClose={() => setRelayPanelOpen(false)} />}

          {/* Sidebar header */}
          <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid rgba(var(--border-rgb),0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer', opacity: 1, transition: 'opacity 0.15s' }} onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')} onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
                <Logo size={26} />
                <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Caravel</span>
              </Link>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={() => setProfileOpen(true)}
                  title="Your profile"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: 'none', background: selfAvatar.grad, cursor: 'pointer', padding: 0 }}
                >
                  <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke={selfAvatar.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                </button>
                <button
                  onClick={() => { setComposeNpub(''); setComposeRes({ s: 'idle' }); setComposeOpen(true) }}
                  title="Start a new conversation"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: '1px solid rgba(var(--border-rgb),0.2)', background: 'transparent', cursor: 'pointer', padding: 0 }}
                >
                  <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                </button>
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
                ? 'var(--text-bright)'
                : 'var(--text-muted-dim)'
              return (
                <div
                  onClick={() => setWalletOpen(true)}
                  title="Open wallet"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderRadius: 12, background: 'linear-gradient(140deg, rgba(var(--accRGB,45,224,198),0.1), rgba(18,165,148,0.04))', border: '1px solid rgba(var(--accRGB,45,224,198),0.22)', cursor: 'pointer', transition: 'border-color 0.15s' }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(var(--teal-500-rgb),0.45)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(var(--accRGB,45,224,198),0.22)')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x={2} y={6} width={20} height={13} rx={2.5} /><path d="M2 10h20" /></svg>
                    <span style={{ fontSize: 13, color: 'var(--text-teal-label)', fontWeight: 500 }}>Balance</span>
                    {isScanning && (
                      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--text-faint-dim)" strokeWidth={2.5} strokeLinecap="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
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
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-teal-dim)', flexShrink: 0 }}
                    >
                      {balanceHidden
                        ? <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx={12} cy={12} r={3} /><path d="M4 4l16 16" /></svg>
                        : <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx={12} cy={12} r={3} /></svg>
                      }
                    </button>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--text-teal-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                  </div>
                </div>
              )
            })()}
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            {/* Ambient connection indicator — click opens the relay-health panel */}
            {(() => {
              const rs = getRelayStates()
              const total = rs.length
              const connected = rs.filter(s => s.status === 'connected').length
              return (
                <div style={{ marginTop: 14 }}>
                  <ConnectionIndicator status={messagingStatus} connected={connected} total={total} onClick={() => setRelayPanelOpen(v => !v)} />
                </div>
              )
            })()}
          </div>

          {/* Search — filters conversations + requests live */}
          <div style={{ padding: '14px 16px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 10, background: 'var(--surface-raised)', border: `1px solid ${sidebarQuery ? 'rgba(var(--teal-500-rgb),0.45)' : 'rgba(var(--border-rgb),0.12)'}`, boxShadow: sidebarQuery ? '0 0 0 3px rgba(var(--teal-500-rgb),0.09)' : 'none' }}>
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--text-faint-dim)" strokeWidth={2} strokeLinecap="round"><circle cx={11} cy={11} r={7} /><path d="M21 21l-4-4" /></svg>
              <input
                type="text"
                value={sidebarQuery}
                onChange={e => setSidebarQuery(e.target.value)}
                placeholder="Search conversations"
                style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 14, fontFamily: 'inherit', padding: 0 }}
              />
              {sidebarQuery && (
                <span onClick={() => setSidebarQuery('')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: 'rgba(var(--border-rgb),0.14)', cursor: 'pointer', flexShrink: 0 }}>
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth={3} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </span>
              )}
            </div>
          </div>

          {/* Requests (M9.0c) — pending peers who messaged first. Distinct from conversations; no
              reply is possible until accepted. Payment previews here deliberately do NOT resolve the
              amount: an unaccepted stranger could reference a UTXO, and we must not fire indexer
              fetches on their behalf before I choose to engage (network work + unsolicited contact).
              The note always renders as inert, auto-escaped text (M10.0 guarantee, no HTML/markdown). */}
          {filteredRequests.length > 0 && (
            <div style={{ padding: '10px 10px 4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 8px' }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-faint-dim)' }}>REQUESTS</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 5px', borderRadius: 100, background: 'rgba(var(--teal-500-rgb),0.14)', border: '1px solid rgba(var(--teal-500-rgb),0.3)', fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, color: 'var(--teal-300)' }}>{filteredRequests.length}</span>
              </div>
              {filteredRequests.map(req => {
                const av = avatarFor(req.peerHex)
                const nick = nicknames[req.peerHex]     // resolved-name variant iff I have a nickname
                const pay = req.lastMessage?.payment     // stranger payment — never resolved (privacy)
                const note = req.lastMessage?.plaintext ?? ''
                const busy = busyRequest?.peerHex === req.peerHex ? busyRequest.kind : null
                // Card frame: teal at rest, teal-stronger while accepting, neutral while declining.
                const frame = busy === 'decline'
                  ? { background: 'rgba(var(--border-rgb),0.03)', border: '1px solid rgba(var(--border-rgb),0.16)' }
                  : { background: 'rgba(var(--teal-500-rgb),0.04)', border: `1px solid rgba(var(--teal-500-rgb),${busy === 'accept' ? 0.26 : 0.18})` }
                return (
                  <div key={req.peerHex} style={{ padding: 16, borderRadius: 14, marginBottom: 5, ...frame }}>
                    {/* Header: avatar + name/npub + relative age. Dimmed while a decision is in flight. */}
                    <div style={{ display: 'flex', gap: 12, marginBottom: 12, opacity: busy ? 0.6 : 1 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: av.grad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: av.color, flexShrink: 0 }}>{initialsFor(nick)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {nick ? (
                          <>
                            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-name)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nick}</div>
                            <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncNpub(req.peerHex)}</div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 500, color: 'var(--text-name)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncNpub(req.peerHex)}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 3 }}>No @name registered</div>
                          </>
                        )}
                      </div>
                      {!busy && req.lastMessage && <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)' }}>{ageShort(req.lastMessage.timestamp)}</span>}
                    </div>

                    {pay ? (
                      /* Payment attached — amount stays confidential (••••) for a stranger; no chain query. */
                      <div style={{ borderRadius: 11, overflow: 'hidden', border: '1px dashed rgba(var(--teal-500-rgb),0.3)', background: 'rgba(10,14,23,0.55)', marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 13px', background: 'rgba(var(--teal-500-rgb),0.06)', borderBottom: '1px dashed rgba(var(--teal-500-rgb),0.22)' }}>
                          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--teal-300)', letterSpacing: '0.06em' }}>CONFIDENTIAL PAYMENT ATTACHED</span>
                        </div>
                        <div style={{ padding: 13 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginBottom: 9 }}>
                            <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: 'var(--text-teal-label)', letterSpacing: '0.1em' }}>••••</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-teal-dim)' }}>TARI</span>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, textAlign: 'center', marginBottom: note ? 11 : 0 }}>Amount stays unresolved until you accept. Caravel doesn’t query the chain for strangers.</div>
                          {note && (
                            <div style={{ padding: '10px 12px', borderRadius: 9, background: 'rgba(10,14,23,0.6)', border: '1px solid rgba(var(--border-rgb),0.1)' }}>
                              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-teal-dim)', marginBottom: 5 }}>NOTE</div>
                              <div style={{ fontSize: 12, color: 'var(--text-body-dim)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : note ? (
                      /* Text request — a stranger's message renders as inert plain text (React auto-escapes). */
                      <>
                        <div style={{ padding: '11px 13px', borderRadius: 10, background: `rgba(10,14,23,${busy ? 0.4 : 0.5})`, border: `1px solid rgba(var(--border-rgb),${busy ? 0.08 : 0.12})`, fontSize: 13, color: busy ? 'var(--text-muted-dim)' : 'var(--text-body-dim)', lineHeight: 1.5, marginBottom: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note}</div>
                        {!nick && !busy && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--text-muted-dim)', marginBottom: 12 }}>
                            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-5M12 8h.01" /></svg>
                            Shown as plain text. Formatting from strangers is never rendered.
                          </div>
                        )}
                      </>
                    ) : null}

                    {/* Accept / Decline — inline. A click sets a local in-flight guard (Flag 2) that
                        disables both buttons; the handlers themselves are unchanged. */}
                    <div style={{ display: 'flex', gap: 9 }}>
                      {busy === 'accept' ? (
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 10, borderRadius: 10, background: 'var(--surface-inset)', border: '1px solid rgba(var(--teal-500-rgb),0.2)', color: 'var(--teal-300)', fontSize: 13, fontWeight: 700 }}>
                          <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.8s linear infinite' }} />Accepting
                        </div>
                      ) : (
                        <button onClick={() => { setBusyRequest({ peerHex: req.peerHex, kind: 'accept' }); acceptRequest(req.peerHex) }} disabled={!!busy}
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10, borderRadius: 10, border: 'none', background: busy ? 'rgba(16,21,31,0.6)' : 'var(--teal-grad)', color: busy ? 'var(--text-faint-dim)' : 'var(--ink-on-accent)', fontSize: 13, fontWeight: 700, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                          Accept
                        </button>
                      )}
                      {busy === 'decline' ? (
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 10, borderRadius: 10, border: '1px solid rgba(var(--border-rgb),0.2)', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
                          <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.18)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />Declining
                        </div>
                      ) : (
                        <button onClick={() => { setBusyRequest({ peerHex: req.peerHex, kind: 'decline' }); declineRequest(req.peerHex) }} disabled={!!busy}
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10, borderRadius: 10, border: `1px solid rgba(var(--border-rgb),${busy ? 0.1 : 0.2})`, background: 'transparent', color: busy ? 'var(--text-faint-dim)' : 'var(--text-muted)', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                          Decline
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Conversation list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px' }}>
            {conversations.length === 0 ? (
              /* Zero conversations (design empty state) */
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', height: '100%', padding: 24, gap: 16 }}>
                <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>No conversations yet</div>
                  <div style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.55, maxWidth: 240 }}>Start one with an @name, or share yours so people can find you.</div>
                </div>
                <button onClick={() => { setComposeNpub(''); setComposeRes({ s: 'idle' }); setComposeOpen(true) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '11px 20px', borderRadius: 11, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', fontFamily: 'inherit' }}>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={2.2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>New conversation
                </button>
              </div>
            ) : filteredConversations.length === 0 ? (
              /* Search with no matches (design "No matches") */
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', height: '100%', padding: 24, gap: 10 }}>
                <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="var(--text-faint-dim)" strokeWidth={2} strokeLinecap="round"><circle cx={11} cy={11} r={7} /><path d="M21 21l-4-4" /></svg>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' }}>No matches</div>
                <div style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.5, maxWidth: 220 }}>Try a different name, @handle, or word.</div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 10px' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-faint-dim)' }}>CONVERSATIONS</span>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: 'var(--text-teal-dim)' }}>{sq ? `${filteredConversations.length} of ${conversations.length}` : ''}</span>
                </div>
                {filteredConversations.map((c) => {
                  const active = selectedConvo?.peerHex === c.peerHex
                  const nick = nicknames[c.peerHex]
                  const av = avatarFor(c.peerHex)
                  const lm = c.lastMessage
                  const isPay = !!lm?.payment
                  const preview = !lm ? '' : isPay ? 'Payment sent' : lm.direction === 'sent' ? `You: ${lm.plaintext}` : lm.plaintext
                  return (
                    <div key={c.peerHex} onClick={() => setSelectedPeer(c.peerHex)} className="cv-conv" style={{ display: 'flex', gap: 13, padding: 13, borderRadius: 12, position: 'relative', background: active ? 'var(--surface-row-selected)' : 'transparent', border: active ? '1px solid rgba(var(--teal-500-rgb),0.18)' : '1px solid transparent', cursor: 'pointer', marginBottom: 4 }}>
                      {active && <span style={{ position: 'absolute', left: 0, top: 14, bottom: 14, width: 3, borderRadius: '0 3px 3px 0', background: 'var(--teal-500)' }} />}
                      <div style={{ width: 46, height: 46, borderRadius: 13, background: av.grad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: av.color, flexShrink: 0 }}>{initialsFor(nick)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3, gap: 8 }}>
                          <span style={{ fontSize: 15, fontWeight: 600, color: active ? 'var(--text-primary)' : 'var(--text-name)', fontFamily: nick ? undefined : "'IBM Plex Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(c.peerHex)}</span>
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: 'var(--text-faint-dim)', flexShrink: 0 }}>{compactTime(c.lastActivity)}</span>
                        </div>
                        {isPay ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} style={{ flexShrink: 0 }}><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                            <span style={{ color: 'var(--teal-500)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</span>
                          </div>
                        ) : (
                          <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>

        {/* RIGHT: active chat */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--surface-base)', position: 'relative' }}>

          {selectedConvo === null ? (
            /* Chat pane at rest (design: sail + reassurance) */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, background: 'radial-gradient(700px 420px at 50% 40%, rgba(var(--teal-500-rgb),0.045), rgba(10,14,23,0))' }}>
              <svg viewBox="0 0 44 44" width={64} height={64} style={{ opacity: 0.34 }} aria-hidden="true">
                <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill="var(--teal-500)" />
                <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="var(--teal-500)" opacity={0.4} />
                <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="var(--teal-500)" />
              </svg>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-body-dim)', marginBottom: 8 }}>Select a conversation</div>
                <div style={{ fontSize: 14, color: 'var(--text-faint)', lineHeight: 1.6, maxWidth: 340 }}>Messages and payments here are end to end encrypted.</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-faint-dim)' }}>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                Your keys never leave this device
              </div>
            </div>
          ) : (
          <>
          {/* Chat header (design: avatar, nickname + @handle inline, E2E badge, ⋯ only) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
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
                    style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-bright)', background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.45)', boxShadow: '0 0 0 3px rgba(var(--teal-500-rgb),0.09)', borderRadius: 9, padding: '7px 11px', outline: 'none', width: 240 }}
                  />
                ) : (
                  <div onClick={beginEditNick} title="Click to set a nickname" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', fontFamily: nicknames[selectedConvo.peerHex] ? undefined : MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(selectedConvo.peerHex)}</span>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                    {nicknames[selectedConvo.peerHex] && <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--text-teal-dim)', flexShrink: 0 }}>{truncNpub(selectedConvo.peerHex)}</span>}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.2}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                  <span style={{ fontSize: 12, color: 'var(--teal-300)', fontWeight: 500 }}>End to end encrypted</span>
                </div>
              </div>
            </div>
            {/* ⋯ menu (design drops the call/video icon) */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={() => setMenuOpen(o => !o)}
                title="Conversation options"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, border: '1px solid rgba(var(--border-rgb),0.16)', background: menuOpen ? 'rgba(var(--border-rgb),0.1)' : 'transparent', cursor: 'pointer', padding: 0 }}
              >
                <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round"><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} /><circle cx={5} cy={12} r={1.6} /></svg>
              </button>
              {menuOpen && (
                <>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div style={{ position: 'absolute', top: 42, right: 0, zIndex: 41, minWidth: 200, padding: 6, borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.18)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
                    <button
                      onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}
                      style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 11px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--danger-300)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                    >
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--danger-300)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                      Delete conversation
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Messages */}
          {(() => {
            const isSelf = selectedConvo.peerHex === nostrPubkeyHex
            const pendingForPeer = pendingSends.filter(p => p.peerHex === selectedConvo.peerHex)
            const isEmpty = selectedConvo.messages.length === 0 && pendingForPeer.length === 0
            return (
          <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Notes-to-self banner (self thread) */}
            {isSelf && (
              <div style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 100, background: 'rgba(var(--border-rgb),0.06)', border: '1px solid rgba(var(--border-rgb),0.18)' }}>
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></svg>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Notes to self. Only you can read this thread.</span>
              </div>
            )}

            {/* Encryption pill (design) — teal */}
            {!isSelf && !isEmpty && (
              <div style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 100, background: 'rgba(var(--teal-500-rgb),0.05)', border: '1px solid rgba(var(--teal-500-rgb),0.18)', marginBottom: 4 }}>
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.2}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                <span style={{ fontSize: 12, color: 'var(--teal-300)' }}>Messages and payments here are end to end encrypted</span>
              </div>
            )}

            {/* Address-provenance banner (design) — wired to real state: exchanged (teal) / manual (amber) */}
            {!isSelf && peerAddrRec && (
              addressVerified ? (
                <div style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 15px', borderRadius: 11, background: 'rgba(var(--teal-500-rgb),0.05)', border: '1px solid rgba(var(--teal-500-rgb),0.24)', maxWidth: 560 }}>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>
                  <span style={{ fontSize: 12, color: 'var(--teal-300)', lineHeight: 1.45 }}>Payment address shared by {displayName(selectedConvo.peerHex)} in this conversation</span>
                </div>
              ) : (
                <div style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 15px', borderRadius: 11, background: 'rgba(var(--warn-rgb),0.05)', border: '1px solid rgba(var(--warn-rgb),0.28)', maxWidth: 560 }}>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                  <span style={{ fontSize: 12, color: 'var(--warn-300)', lineHeight: 1.45 }}>Address entered manually. Not verified against this contact’s identity.</span>
                </div>
              )
            )}

            {/* Empty accepted thread (first-message state) */}
            {isEmpty && !isSelf && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 100, background: 'rgba(var(--teal-500-rgb),0.05)', border: '1px solid rgba(var(--teal-500-rgb),0.18)' }}>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.2}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                  <span style={{ fontSize: 12, color: 'var(--teal-300)' }}>End to end encrypted</span>
                </div>
                <div style={{ textAlign: 'center', maxWidth: 300 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-body-dim)', marginBottom: 6 }}>This is the start of your conversation with {displayName(selectedConvo.peerHex)}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>Say hello, or send a confidential payment with a note attached.</div>
                </div>
              </div>
            )}

            {selectedConvo.messages.map((m) => (
              m.payment ? (
                <PaymentMessageCard key={m.id} message={m} />
              ) : (isSelf || m.direction === 'received') ? (
                /* Incoming / notes-to-self */
                <div key={m.id} style={{ alignSelf: isSelf ? 'flex-end' : 'flex-start', maxWidth: '62%' }}>
                  <div style={{ padding: '13px 17px', borderRadius: isSelf ? 14 : '4px 16px 16px 16px', background: 'var(--surface-inset)', border: isSelf ? '1px solid rgba(var(--border-rgb),0.14)' : 'none', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.plaintext}</div>
                  {!isSelf && <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)', marginTop: 5, marginLeft: 4 }}>{bubbleTime(m.timestamp)}</div>}
                </div>
              ) : (
                /* Outgoing */
                <div key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'var(--msg-sent)', color: 'var(--text-bright)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.plaintext}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 6, marginRight: 4 }}>
                    {bubbleTime(m.timestamp)}
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
                  </div>
                </div>
              )
            ))}

            {/* Pending-send overlay (design lifecycle: sending → failed + Retry) */}
            {pendingForPeer.map((p) => (
              <div key={p.id} style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                {p.status === 'sending' ? (
                  <>
                    <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'linear-gradient(160deg, rgba(28,122,110,0.55), rgba(18,101,90,0.55))', color: 'var(--text-note)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.text}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 6, marginRight: 4 }}>
                      <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.2)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />Sending
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'rgba(var(--danger-rgb),0.06)', border: '1px solid rgba(var(--danger-rgb),0.34)', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.text}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7, marginRight: 4 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--danger-300)' }}>
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.4} strokeLinecap="round"><circle cx={12} cy={12} r={9} /><path d="M12 8v5M12 16h.01" /></svg>Couldn’t send
                      </span>
                      <span onClick={() => retrySend(p.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', fontSize: 11, fontWeight: 700, color: 'var(--danger-300)', cursor: 'pointer' }}>
                        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--danger-300)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>Retry
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, marginRight: 4 }}>Your text is kept in the composer.</div>
                  </>
                )}
              </div>
            ))}
            {/* Auto-scroll anchor */}
            <div ref={bottomRef} />
          </div>
            ) })()}

          {/* Composer */}
          {(() => {
            const paymentValid = validatePayment() === null
            const canSend = payBusy || confirming
              ? false
              : paymentMode ? paymentValid : (!!draft.trim() && !sending)
            const showCounter = draft.length >= MAX_MESSAGE_LEN - 200
            const inputsDisabled = sending || payBusy || confirming
            return (
            <div style={{ padding: '16px 24px 20px', borderTop: '1px solid rgba(var(--border-rgb),0.1)' }}>

              {/* PERSISTENT must-acknowledge alert (orphan / timeout) — logic unchanged, reskinned */}
              {payAlert && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, padding: '13px 15px', borderRadius: 12, background: 'rgba(var(--warn-rgb),0.08)', border: '1.5px solid rgba(var(--warn-rgb),0.4)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--warn-300)' }}>
                      {payAlert.kind === 'orphan' ? 'Payment sent, but the message did not' : 'Payment submitted, but not confirmed'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-body-dim)', lineHeight: 1.5 }}>
                    {payAlert.kind === 'orphan'
                      ? <>The funds ({<b>{payAlert.amountTari} tTARI</b>}) left your wallet. {displayName(selectedConvo.peerHex)} has the money but no note explaining it, so tell them separately.</>
                      : <>Broadcast to the network, no confirmation yet ({<b>{payAlert.amountTari} tTARI</b>}). Do not resend. Check Activity before trying again.</>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 12px', borderRadius: 9, background: 'rgba(10,14,23,0.5)' }}>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-teal-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{payAlert.txId.slice(0, 8)}…{payAlert.txId.slice(-4)}</span>
                    <span onClick={() => navigator.clipboard.writeText(payAlert.txId).catch(() => {})} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--warn-300)', cursor: 'pointer', flexShrink: 0 }}>
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--warn-300)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x={9} y={9} width={13} height={13} rx={2} /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>Copy
                    </span>
                  </div>
                  <button onClick={() => setPayAlert(null)} style={{ alignSelf: 'flex-start', marginTop: 2, padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(var(--warn-rgb),0.5)', background: 'transparent', color: 'var(--warn-300)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                    I have noted this
                  </button>
                </div>
              )}

              {/* Payment error (validation / reject / pre-flight) — draft + fields preserved */}
              {payError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 10, fontSize: 12, color: 'var(--danger-300)', fontFamily: MONO, lineHeight: 1.45 }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx={12} cy={12} r={10} /><path d="M12 8v4M12 16h.01" /></svg>
                  <span style={{ wordBreak: 'break-word' }}>{payError}</span>
                </div>
              )}

              {/* Payment in flight — progress */}
              {payBusy && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12.5, color: 'var(--teal-300)', fontFamily: MONO }}>
                  <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.8s linear infinite', flexShrink: 0 }} />
                  <span>{payProgress ?? 'Working…'}</span>
                </div>
              )}

              {/* Payment composer card (transcribed from design source: contained card, amount+address
                  row, dashed note, Cancel/Review; danger-toned when the balance pre-check fails) */}
              {paymentMode && !confirming && !payBusy && (
                <div style={{ padding: 18, borderRadius: 16, background: 'var(--surface-base)', border: `1px solid ${payInsufficient ? 'rgba(var(--danger-rgb),0.3)' : 'rgba(var(--teal-500-rgb),0.24)'}`, marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--teal-300)', letterSpacing: '0.06em' }}>CONFIDENTIAL PAYMENT</span>
                    <button onClick={toggleTari} title="Cancel payment" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted-dim)', display: 'flex', padding: 2 }}>
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                  {/* amount + address row */}
                  <div style={{ display: 'flex', gap: 10, marginBottom: payInsufficient ? 8 : 10 }}>
                    <div style={{ flex: '0 0 150px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: `1px solid ${payInsufficient ? 'rgba(var(--danger-rgb),0.5)' : 'rgba(var(--teal-500-rgb),0.45)'}`, boxShadow: payInsufficient ? 'none' : '0 0 0 3px rgba(var(--teal-500-rgb),0.09)' }}>
                      <input value={payAmount} onChange={e => { setPayAmount(e.target.value); if (payError) setPayError(null) }} placeholder="0.00" inputMode="decimal" style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 15, color: 'var(--text-body)' }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: payInsufficient ? 'var(--danger-300)' : 'var(--teal-500)' }}>TARI</span>
                    </div>
                    {addressVerified ? (
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', padding: '12px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)', fontFamily: MONO, fontSize: 13, color: 'var(--text-body-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{peerAddrRec!.address.slice(0, 14)}…{peerAddrRec!.address.slice(-4)}</div>
                    ) : (
                      <input value={payAddress} onChange={e => { setPayAddress(e.target.value); if (payError) setPayError(null) }} placeholder="otl_esm_…" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '12px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)', fontFamily: MONO, fontSize: 13, color: 'var(--text-body-dim)', outline: 'none' }} />
                    )}
                  </div>
                  {/* insufficient-balance row */}
                  {payInsufficient && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, marginBottom: 14 }}>
                      <span style={{ color: 'var(--danger-300)' }}>Exceeds your balance</span>
                      {scan.balance !== null && <span style={{ fontFamily: MONO, color: 'var(--text-muted-dim)' }}>available {(Number(scan.balance) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                    </div>
                  )}
                  {/* note (dashed) */}
                  <textarea value={draft} onChange={e => { setDraft(e.target.value); if (sendError) setSendError(null) }} placeholder="Add a note (optional)…" rows={1} maxLength={MAX_MESSAGE_LEN} style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px dashed rgba(var(--teal-500-rgb),0.24)', fontSize: 13, color: 'var(--text-note)', fontStyle: draft ? 'normal' : 'italic', outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4, marginBottom: 14 }} />
                  {/* buttons */}
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={toggleTari} style={{ flex: '0 0 120px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, borderRadius: 11, border: '1px solid rgba(var(--border-rgb),0.2)', background: 'transparent', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                    {(() => { const ok = validatePayment() === null; return (
                      <button onClick={onComposerSend} disabled={!ok} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, borderRadius: 11, border: ok ? 'none' : '1px solid rgba(var(--border-rgb),0.12)', background: ok ? 'var(--teal-grad)' : 'rgba(16,21,31,0.6)', color: ok ? 'var(--ink-on-accent)' : 'var(--text-disabled)', fontSize: 14, fontWeight: 700, cursor: ok ? 'pointer' : 'default', fontFamily: 'inherit' }}>Review payment</button>
                    ) })()}
                  </div>
                </div>
              )}

              {/* In-thread confirm gate (transcribed from design source: --surface card, Amount /
                  Network fee ≤ 0.01 TARI / To rows, dashed note, warn callout, Cancel / Send payment) */}
              {confirming && (
                <div style={{ padding: 20, borderRadius: 16, background: 'var(--surface)', border: '1px solid rgba(var(--teal-500-rgb),0.28)', marginBottom: 12 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>Confirm payment to {displayName(selectedConvo.peerHex)}</div>
                  <div style={{ borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)', overflow: 'hidden', marginBottom: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderBottom: '1px solid rgba(var(--border-rgb),0.08)' }}><span style={{ fontSize: 13, color: 'var(--text-muted-dim)' }}>Amount</span><span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: 'var(--text-bright)' }}>{payAmount} TARI</span></div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderBottom: '1px solid rgba(var(--border-rgb),0.08)' }}><span style={{ fontSize: 13, color: 'var(--text-muted-dim)' }}>Network fee</span><span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--text-muted)' }}>≤ {FEE_CEIL_TARI} TARI</span></div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 15px' }}><span style={{ fontSize: 13, color: 'var(--text-muted-dim)', flexShrink: 0 }}>To</span><span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-body-dim)' }}>{effectivePayAddress.slice(0, 12)}…{effectivePayAddress.slice(-4)}</span></div>
                  </div>
                  <div style={{ padding: '12px 14px', borderRadius: 11, background: 'rgba(10,14,23,0.6)', border: '1px dashed rgba(var(--teal-500-rgb),0.26)', marginBottom: 14 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-teal-dim)', marginBottom: 6 }}>PRIVATE NOTE</div>
                    <div style={{ fontSize: 13, color: 'var(--text-note)', fontStyle: 'italic' }}>“{draft.trim() || '💸 Payment'}”</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 11, background: 'rgba(var(--warn-rgb),0.05)', border: '1px solid rgba(var(--warn-rgb),0.28)', marginBottom: 16 }}>
                    <span style={{ fontSize: 12, color: 'var(--warn-300)', lineHeight: 1.5 }}>This is a real, irreversible testnet payment. It cannot be recalled once sent.</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={() => setConfirming(false)} style={{ flex: '0 0 120px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, border: '1px solid rgba(var(--border-rgb),0.2)', background: 'transparent', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                    <button onClick={submitPayment} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, border: 'none', background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Send payment</button>
                  </div>
                </div>
              )}

              {/* Text composer row (design) — TARI toggle + input + send. Emoji button removed. */}
              {!paymentMode && !confirming && (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
                  <button
                    onClick={toggleTari}
                    disabled={payBusy}
                    title="Attach confidential payment"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, flexShrink: 0, borderRadius: 12, border: 'none', background: 'var(--teal-grad)', cursor: payBusy ? 'default' : 'pointer', boxShadow: '0 0 18px rgba(var(--teal-500-rgb),0.28)', padding: 0 }}
                  >
                    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                  </button>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '13px 17px', borderRadius: 13, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)' }}>
                    <textarea
                      ref={composerRef}
                      className="cv-composer"
                      value={draft}
                      onChange={e => { setDraft(e.target.value); if (sendError) setSendError(null) }}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onComposerSend() } }}
                      placeholder="Write an encrypted message…"
                      rows={1}
                      maxLength={MAX_MESSAGE_LEN}
                      disabled={inputsDisabled}
                      style={{ flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 15, fontFamily: 'inherit', lineHeight: 1.4, maxHeight: COMPOSER_MAX_H, overflowY: 'auto', padding: 0, display: 'block' }}
                    />
                  </div>
                  <button
                    onClick={onComposerSend}
                    disabled={!canSend}
                    title="Send message"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, flexShrink: 0, borderRadius: 12, background: 'var(--surface-inset)', border: '1px solid rgba(var(--border-rgb),0.16)', cursor: canSend ? 'pointer' : 'default', opacity: canSend ? 1 : 0.5, padding: 0 }}
                  >
                    {sending ? (
                      <span style={{ width: 20, height: 20, borderRadius: '50%', border: '2.5px solid rgba(var(--border-rgb),0.25)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />
                    ) : (
                      <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={canSend ? 'var(--teal-500)' : 'var(--text-muted-dim)'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
                    )}
                  </button>
                </div>
              )}
              {!paymentMode && !confirming && showCounter && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: draft.length >= MAX_MESSAGE_LEN ? 'var(--danger-500)' : 'var(--text-muted-dim)' }}>{draft.length}/{MAX_MESSAGE_LEN}</span>
                </div>
              )}
              <style>{`.cv-composer::placeholder { color: var(--text-faint-dim); }`}</style>
            </div>
            )
          })()}
          </>
          )}
        </div>

      </div>
    </div>

    {walletOpen && <WalletModal onClose={() => setWalletOpen(false)} />}
    {profileOpen && <ProfilePanel onClose={() => setProfileOpen(false)} avatar={selfAvatar} />}

    {/* Compose new conversation */}
    {composeOpen && (() => {
      // Derive the modal's visual state from the resolution machine (composeRes). Everything here is
      // presentational — transcribed from the /compose-preview gallery; the input feeds composeNpub,
      // the debounced effect fills composeRes, and Start/Open call startWith(hex).
      const r = composeRes
      const okHex = r.s === 'ok' ? r.hex : null
      const existing = okHex ? conversations.some(c => c.peerHex === okHex) : false
      const isRed = r.s === 'invalid' || (r.s === 'fail' && r.kind === 'not-found')
      const isAmber = r.s === 'fail' && (r.kind === 'unreachable' || r.kind === 'no-key')
      const inputBorder =
        isRed ? 'rgba(var(--danger-rgb),0.5)'
        : isAmber ? 'rgba(var(--warn-rgb),0.4)'
        : r.s === 'resolving' ? 'rgba(var(--border-rgb),0.24)'
        : r.s === 'ok' ? `rgba(var(--teal-500-rgb),${existing ? 0.32 : 0.45})`
        : 'rgba(var(--border-rgb),0.14)'
      const iconStroke = isRed ? 'var(--danger-300)' : isAmber ? 'var(--warn-300)' : r.s === 'ok' || r.s === 'resolving' ? 'var(--teal-300)' : 'var(--text-muted-dim)'
      const canStart = r.s === 'ok'
      const isUnreachable = r.s === 'fail' && r.kind === 'unreachable'
      return (
      <div
        onClick={() => setComposeOpen(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(5,8,14,0.78)', backdropFilter: 'blur(3px)', padding: 24 }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{ width: '100%', maxWidth: 460, borderRadius: 18, background: 'var(--surface)', border: '1px solid rgba(var(--border-rgb),0.2)', boxShadow: '0 30px 90px rgba(0,0,0,0.65)', overflow: 'hidden' }}
        >
          {/* Header — title + Esc hint + close */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>New conversation</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ padding: '3px 7px', borderRadius: 6, border: '1px solid rgba(var(--border-rgb),0.18)', fontFamily: MONO, fontSize: 10, color: 'var(--text-muted-dim)' }}>Esc</span>
              <span onClick={() => setComposeOpen(false)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(var(--border-rgb),0.16)', cursor: 'pointer' }}>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2.2} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </span>
            </div>
          </div>

          <div style={{ padding: '20px 18px' }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 14 }}>
              Enter an npub or @name. Caravel resolves @names on chain to a messaging key.
            </div>

            {/* Input row — leading icon tints by state, trailing shows spinner / check / cross. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 15px', borderRadius: 11, background: 'var(--surface-raised)', border: `1px solid ${inputBorder}`, boxShadow: r.s === 'ok' && !existing ? '0 0 0 3px rgba(var(--teal-500-rgb),0.09)' : undefined, marginBottom: 12 }}>
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={iconStroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
              <input
                autoFocus
                value={composeNpub}
                onChange={e => setComposeNpub(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { if (canStart) startWith(okHex!) } else if (e.key === 'Escape') setComposeOpen(false) }}
                placeholder="npub1… or @name"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 14, fontFamily: MONO, padding: 0 }}
              />
              {r.s === 'resolving' && <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.8s linear infinite', flexShrink: 0 }} />}
              {r.s === 'ok' && <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6L9 17l-5-5" /></svg>}
              {isRed && r.s !== 'invalid' && <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.4} strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M6 6l12 12M18 6L6 18" /></svg>}
            </div>

            {/* State line / card below the input. */}
            {r.s === 'invalid' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--danger-300)', marginBottom: 18 }}>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.2} strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
                {r.kind === 'not-npub' ? 'That is not an npub or an @name' : 'Invalid npub. The checksum doesn’t match.'}
              </div>
            )}
            {r.s === 'resolving' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-teal-label)', marginBottom: 18 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.8s linear infinite' }} />
                Resolving @{r.name} on the Tari network…
              </div>
            )}
            {r.s === 'ok' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 11, background: 'rgba(var(--teal-500-rgb),0.05)', border: `1px solid rgba(var(--teal-500-rgb),${existing ? 0.2 : 0.22})`, marginBottom: existing ? 14 : 18 }}>
                <div style={{ width: 36, height: 36, borderRadius: 11, background: avatarFor(okHex!).grad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: avatarFor(okHex!).color, flexShrink: 0 }}>{initialsFor(nicknames[okHex!] ?? r.name ?? undefined)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nicknames[okHex!] ?? (r.name ? `@${r.name}` : truncNpub(okHex!))}</div>
                  <div style={{ fontFamily: existing ? undefined : MONO, fontSize: 12, color: 'var(--text-teal-label)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{existing ? 'You already have this conversation' : (r.name ? truncNpub(okHex!) : 'Ready to message')}</div>
                </div>
              </div>
            )}
            {r.s === 'fail' && (
              <div style={{ padding: '12px 14px', borderRadius: 11, background: `rgba(var(--${r.kind === 'not-found' ? 'danger' : 'warn'}-rgb),0.05)`, border: `1px solid rgba(var(--${r.kind === 'not-found' ? 'danger' : 'warn'}-rgb),0.25)`, marginBottom: isUnreachable ? 14 : 18 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: `var(--${r.kind === 'not-found' ? 'danger' : 'warn'}-300)`, marginBottom: 4 }}>
                  {r.kind === 'not-found' ? `No one owns @${r.name}` : r.kind === 'unreachable' ? 'Couldn’t reach the name service' : `@${r.name} has no messaging key`}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {r.kind === 'not-found' ? 'The name isn’t registered on chain. Check the spelling, or ask them for their npub.'
                    : r.kind === 'unreachable' ? `This is a network problem, not a missing name. @${r.name} may well exist.`
                    : 'The name is registered, but no Nostr key is published against it, so there is nowhere to send.'}
                </div>
              </div>
            )}

            {/* Actions — Cancel + primary (Start / Start conversation / Open conversation / Try again). */}
            <div style={{ display: 'flex', gap: 10 }}>
              <div onClick={() => setComposeOpen(false)} style={{ flex: '0 0 120px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, border: '1px solid rgba(var(--border-rgb),0.2)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Cancel</div>
              {canStart ? (
                <div onClick={() => startWith(okHex!)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 13, borderRadius: 12, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  {existing ? 'Open conversation' : 'Start conversation'}
                  {existing && <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={2.4} strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>}
                </div>
              ) : isUnreachable ? (
                <div onClick={() => setComposeRetry(n => n + 1)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 13, borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>Try again
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, background: 'rgba(16,21,31,0.6)', border: '1px solid rgba(var(--border-rgb),0.12)', color: 'var(--text-faint-dim)', fontSize: 14, fontWeight: 700 }}>Start</div>
              )}
            </div>
          </div>
        </div>
      </div>
      )
    })()}

    {/* Delete-conversation confirmation — destructive, localStorage is the only copy */}
    {confirmDelete && selectedConvo && (
      <div
        onClick={() => setConfirmDelete(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,7,12,0.72)', padding: 24 }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{ width: '100%', maxWidth: 420, padding: '24px 24px 20px', borderRadius: 16, background: '#111722', border: '1px solid rgba(var(--danger-rgb),0.3)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 11, background: 'rgba(var(--danger-rgb),0.12)', flexShrink: 0 }}>
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Delete conversation?</div>
          </div>
          <div style={{ fontSize: 14, color: '#B4C0D4', lineHeight: 1.6, marginBottom: 20 }}>
            All messages, the nickname, and payment history with <b style={{ color: 'var(--text-name)' }}>{displayName(selectedConvo.peerHex)}</b> will be permanently removed from this device and <b style={{ color: 'var(--danger-300)' }}>cannot be recovered</b>. The other person keeps their copy.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              onClick={() => setConfirmDelete(false)}
              style={{ padding: '10px 18px', borderRadius: 9, border: '1px solid rgba(var(--border-rgb),0.25)', background: 'transparent', color: 'var(--text-muted-dim)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Cancel
            </button>
            <button
              onClick={performDelete}
              style={{ padding: '10px 18px', borderRadius: 9, border: 'none', background: 'var(--danger-500)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
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
