import { Fragment, useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import * as nip19 from 'nostr-tools/nip19'
import Logo from '../primitives/Logo'
import { useWallet } from '../../context/WalletContext'
import { assertValidRecipient } from '../../crypto/publicSend'
import { parseOotleAddress } from '@tari-project/ootle-wasm'
import { plainError } from '../wallet/v2/plainError'
import { compareMessages, sortKey, type CaravelMessage, type Group } from '../../messaging/types'
import GroupThread from './GroupThread'
import CreateGroupModal, { type GroupContactOption } from './CreateGroupModal'
import ModalCard from './ModalCard'
import CnsOverlay from './CnsOverlay'
import ReinviteModal, { type ReinviteMemberOption } from './ReinviteModal'
import { useScrollToBottom } from './useScrollToBottom'
import { useJumpToMessage } from './useJumpToMessage'
import PendingBubble, { type PendingSend } from './PendingBubble'
import { loadNicknames, setNickname, MAX_NICKNAME_LEN, type NicknameMap } from '../../messaging/nicknameStore'
import { loadAddressSent, markAddressSent, clearAddressSent, type AddressSentMap } from '../../messaging/addressSentStore'
import { sendConfidential, tariToMicrotari, MAX_FEE } from '../../crypto/confidentialSend'
import { beginEntry, settleEntry } from '../../crypto/journalStore'
import { resolveOnsNameToHex, toOnsName, type OnsResolveErrorKind } from '../../crypto/ons'
import { ConnectionIndicator, RelayHealthPanel } from './ConnectionStatus'
import { usePaymentResolution } from '../../hooks/usePaymentResolution'
import { balanceIsLowerBound, isInsufficientBalance } from './paymentGuard'
// The wallet's amount formatters, bigint-only — shared rather than re-derived, which is the whole
// point of format.ts having been written. MASK_SHORT is the same stand-in its balance rows use.
import { fmt6, MASK_SHORT } from '../wallet/v2/format'
// The wallet's own sentence for "this figure came off a truncated scan". Shared, not retyped: its
// note says there is one wording precisely so the two surfaces cannot drift apart on the claim.
import { incompleteAvailableNote } from '../wallet/v2/total'
import { avatarFor, initialsFor, truncNpub, bubbleTime, compactTime, dayLabel, isNewDay, mergeThreadItems, replyChipDetail, threadContentKey, MONO } from './chatDisplay'
import Avatar from './Avatar'
import MessageBubble from './MessageBubble'
import QuotedPreview from './QuotedPreview'
import { canBeginEdit, canBeginReply, canReplyTo } from './replyCompose'
import { aggregateReactions, atReactionLimit, canReactTo, myReactions } from './reactionDisplay'
import MessageActionRow from './MessageActionRow'
import ReactionPills from './ReactionPills'
import ReactionQuickSet from './ReactionQuickSet'
import { beginFlight, canEditMessage, displayTextFor, flightFor, isEditSubmittable, settleFlight, clearFlight, type EditFlightMap } from './messageEdit'
import MediaMessageCard from './MediaMessageCard'
import { describeMediaFailure, describeMediaStage, sendImageToGroup, sendImageToPeer, type MediaSendStage } from '../../messaging/sendMedia'
import { putBlob } from '../../messaging/blobCache'
import AttachPreview from './AttachPreview'
import { groupGlyph } from './groupGlyph'
import EmojiPicker from './EmojiPicker'
import { insertAtCursor } from './composerInsert'
import { THREAD_HEADER, HEADER_LEFT, THREAD_TITLE, MENU_SCRIM, MENU_PANEL, MENU_ITEM, THREAD_SCROLLER, THREAD_META_LINE, COMPOSER_SHELL, COMPOSER_CARD, COMPOSER_ROW, COMPOSER_ICON_BTN, COMPOSER_SEND, COMPOSER_POPOVER_OFFSET } from './threadChrome'
import { E2ELine, ThreadMenuButton, ThreadEmptyState, DayDivider, ComposerChip, REPLY_RULE } from './ThreadFrame'
import { useTheme } from '../../hooks/useTheme'

// ── Sidebar section headers ─────────────────────────────────────────────────────
//
// REQUESTS / GROUP INVITES / GROUPS / DIRECT, all four to one spec so they cannot drift. V3 sets
// them quieter than the teal-era caps did — 10.5px at .08em rather than 11px at .14em, and muted
// rather than faint — because on a light pane the old tracking read as a banner rather than a
// label. The count beside REQUESTS and GROUP INVITES is not in the design; it is real information
// about work waiting for you, so it stays, at the label's own size and in accent ink.

const SECTION_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, padding: '10px 6px 4px' }
const SECTION_LABEL: CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-muted-dim)' }
const SECTION_COUNT: CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--accent-ink)' }

// ── Conversation rows ───────────────────────────────────────────────────────────
//
// One spec for group and DM rows; only the avatar's shape and the preview's ink differ. V3 takes
// the row from ~72px to ~54px (36px avatar, 9px padding, was 46 and 13), which is most of a screen
// more conversations on a long list.
//
// SELECTION IS THE ACCENT WASH AND NOTHING ELSE. The teal-era row stacked three cues — a tinted
// background, a 1px border and a 3px left bar — on a state that is never ambiguous, because
// exactly one row is selected and the thread beside it says which. The wash reads in both themes
// and the name goes accent-ink with it. Hover is .cv-conv in index.css, which lifts the row to
// --surface; the two never collide, since a selected row is not hovered into a different state.

const CONV_ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
  borderRadius: 10, cursor: 'pointer', marginBottom: 2,
}
const CONV_NAME: CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const CONV_TIME: CSSProperties = { fontSize: 11, color: 'var(--text-muted-dim)', flexShrink: 0 }
const CONV_PREVIEW: CSSProperties = {
  fontSize: 12, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

// ── Request / invite cards ──────────────────────────────────────────────────────
//
// V3 draws these as ORDINARY CARDS — surface, hairline, one step of elevation — where the teal era
// tinted the whole frame with the accent and modulated that tint through the accepting / declining
// states. The accent now belongs to the Accept button alone, which is the thing being asked about;
// a frame that changed colour three ways was spending the loudest colour on the container.
//
// The busy states did not go anywhere: the head dims to 0.6 and the pressed button becomes its own
// spinner, which is where a decision in flight is actually legible.

const REQUEST_CARD: CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 12, padding: '12px 13px', boxShadow: 'var(--e1)',
}
const CARD_BTN: CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  padding: 7, borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
}

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
    if (m.groupId) continue   // group messages belong to their group thread ONLY — never a DM thread
    const peerHex = m.direction === 'received' ? m.senderPubkeyHex : m.recipientPubkeyHex
    if (!peerHex) continue
    const arr = byPeer.get(peerHex)
    if (arr) arr.push(m)
    else byPeer.set(peerHex, [m])
  }
  const convos: Conversation[] = []
  for (const [peerHex, msgs] of byPeer) {
    // Ordered by CLAMPED SEND TIME — the same value each bubble displays — with compareMessages'
    // tiebreak keeping a same-second burst in one fixed order across renders.
    const sorted = [...msgs].sort(compareMessages)
    const lastMessage = sorted[sorted.length - 1]
    convos.push({ peerHex, messages: sorted, lastMessage, lastActivity: sortKey(lastMessage) })
  }
  // Most recent activity first.
  convos.sort((a, b) => b.lastActivity - a.lastActivity)
  return convos
}

// ── Display helpers ──────────────────────────────────────────────────────────────
// Shared helpers (avatarFor, initialsFor, truncNpub, bubbleTime, compactTime, MONO) now live in
// chatDisplay.ts and are imported above — single source of truth for the DM + group views. The
// remaining helpers/consts below are ChatApp-local.

// Compact relative age for request rows: "3m" / "2h" / "1d".
function ageShort(ts: number): string {
  const mins = (Date.now() - ts) / 60_000
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`
  const hrs = mins / 60
  if (hrs < 24) return `${Math.round(hrs)}h`
  return `${Math.round(hrs / 24)}d`
}

// Cap on a single message. A longer paste would just be rejected by relays and surface as a
// confusing "all relays rejected" error rather than a clear reason, so stop it at the input.
const MAX_MESSAGE_LEN = 2000

// Composer grows with content up to this height (~5-6 lines), then scrolls internally.
const COMPOSER_MAX_H = 120

// The action pair at the foot of the payment compose card and the confirm gate. One spec: the two
// cards used to disagree — 12/r11 on one, 13/r12 on the other — for the same Cancel/commit pair.
const PAY_BTN: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 9, borderRadius: 10, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
}

/**
 * The inline payment panel (§8B) — ONE shell for compose and for confirm.
 *
 * It opens in the composer's own slot, over the composer, and is never a modal or a screen. The
 * shadow points UPWARD, which is the whole cue: this sheet has risen over the input rather than
 * floating above the page. Sitting inside COMPOSER_SHELL already, it takes no margin of its own.
 */
const PAY_PANEL: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 11,
  padding: '14px 16px', borderRadius: 14, marginBottom: 12,
  background: 'var(--surface)', boxShadow: '0 -8px 24px -12px rgba(10,19,34,0.18)',
}

// Compose and confirm are the same panel with its contents swapped, so they share one header —
// the padlock tile, the name, and the × that leaves payment mode altogether.
function PayPanelHeader({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 7, flexShrink: 0, background: 'var(--accent-wash)', color: 'var(--accent-ink)' }}>
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><rect x={5} y={11} width={14} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
      </span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Confidential payment</span>
      <button onClick={onClose} title="Cancel payment" aria-label="Cancel payment" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted-dim)', display: 'flex', padding: 2, flexShrink: 0 }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
  )
}

// Fee ceiling shown in the confirm step, from confidentialSend.MAX_FEE.
//
// fmt6 rather than `Number(MAX_FEE) / 1_000_000` — the third instance of the pattern 8A removed.
// Constant-folded, so it could never have been wrong here; replaced anyway, because the argument
// for the other two was that there should be one way to turn µtTARI into a figure, and an exception
// that happens to be safe is how the next unsafe one gets written.
const FEE_CEIL_XTR = fmt6(MAX_FEE)

// Compose-modal resolution state (Flag 1b). `ok` carries the resolved peer; `name` is the ONS name
// (null for a raw npub), `existing` true when it is already an accepted conversation.
type ComposeRes =
  | { s: 'idle' }
  | { s: 'invalid'; kind: 'not-npub' | 'bad-npub' }
  | { s: 'resolving'; name: string }
  | { s: 'ok'; hex: string; name: string | null }
  | { s: 'fail'; kind: OnsResolveErrorKind; name: string }

// Decimal µTari string → TARI display string. Defensive; never throws.
//
// fmt6, NOT `Number(µt) / 1_000_000`. Amounts are 128-bit on the wire and a float divide drifts on a
// large one — the same silent-rounding bug the faucet shipped once, which is why format.ts exists
// and is bigint-only. The try/catch stays: these strings come off the wire and out of a cache, and a
// malformed one must render a dash rather than throw inside a message row.
function microToTari(micro: string): string {
  try { return fmt6(BigInt(micro)) } catch { return '—' }
}

// ── Payment card (§8A) ────────────────────────────────────────────────────────
//
// Confidential-payment card in the thread. Sender shows the amount from its local cache (never on
// the wire). Recipient resolves the true amount from the referenced UTXO with its own view key. The
// note ALWAYS renders (M10.0 guarantee).
//
// ── THE CARD IS A VAULT ISLAND, DARK IN BOTH THEMES, ON PURPOSE ───────────────
//
// It pins `data-theme="dark"` over its own subtree, so the dark ramp resolves inside it whatever the
// page is doing. That is the same treatment the foundation gives the balance hero and the nav rail,
// and it is a statement rather than a leftover: a confidential payment is the one moment in chat
// where the product is a vault, and the card says so by not following the room's lighting. The pin
// is also what lets everything inside keep using ordinary role tokens — unpinned, a navy card on a
// white page would need a parallel set of literals for every piece of ink on it.
//
// ── ONE CARD, TEN STATES, NO TONES ───────────────────────────────────────────
//
// The card used to restyle its whole self per outcome: three tone chromes swapping background,
// border and header fill, plus a status chip. §8A draws one card and lets a single status line
// carry the difference, which is why the states below are DATA rather than ten JSX branches. What
// varies is: an amount or a mask or neither, one sentence, its ink, a spinner, a Retry, a pill.

type PayCardState = {
  dir: 'SENT' | 'RECEIVED'
  /** Formatted TARI, already through fmt6. Mutually exclusive with `masked`. */
  amount?: string
  /** The sender's "••••" — an amount that exists but is not on this device. */
  masked?: boolean
  status?: string
  /** Status ink. `danger` is reserved for the two states that offer a Retry. */
  tone?: 'dim' | 'danger'
  spin?: boolean
  retry?: () => void
  /** "Amount hidden on chain" — shown only where an amount actually is. */
  pill?: boolean
}

// The app's encryption mark, the same path E2ELine draws in the thread header.
const padlock = <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><rect x={5} y={11} width={14} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>

function PaymentCard({ sent, state, timestamp, plaintext, lid, flashed }: {
  sent: boolean
  state: PayCardState
  timestamp: number
  plaintext: string
  lid?: string
  flashed?: boolean
}) {
  const statusInk = state.tone === 'danger' ? 'var(--danger-500)' : 'var(--vault-ink-dim)'
  return (
    <div data-lid={lid} className={flashed ? 'cv-msg-flash' : undefined} style={{ alignSelf: sent ? 'flex-end' : 'flex-start', maxWidth: '68%', width: 440 }}>
      {/* See the header note: the pin is the point, not a workaround. `cv-msg-flash` is the dark
          flash for the same reason — this surface is near-black under either theme. */}
      <div data-theme="dark" style={{
        display: 'flex', flexDirection: 'column', gap: 12,
        padding: 18, borderRadius: 16,
        background: 'var(--card-payment)', border: '1px solid var(--card-payment-border)',
        boxShadow: 'var(--vault-shadow)', color: 'var(--text-primary)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 8, flexShrink: 0, background: 'rgba(var(--accent-300-rgb),0.14)', color: 'var(--accent-300)' }}>{padlock}</span>
          <span style={{ flex: 1, fontSize: 11.5, fontWeight: 600, color: 'var(--text-body-dim)', letterSpacing: '0.04em' }}>Confidential payment</span>
          {/* The DIRECTION, which never changes with the outcome — a spent payment is still one you
              received. The old chip said "Spent"/"Not found" here and the status line said it again. */}
          <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', color: 'var(--text-muted-dim)' }}>{state.dir}</span>
        </div>

        {state.amount !== undefined && (
          <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, fontFeatureSettings: "'tnum'", letterSpacing: '-0.01em' }}>
            {state.amount}<span style={{ fontSize: 13, color: 'var(--vault-ink-dim)', marginLeft: 6 }}>XTR</span>
          </div>
        )}
        {state.masked && (
          <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, color: 'var(--vault-ink-dim)', letterSpacing: '0.14em' }}>••••</div>
        )}

        {state.status && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.5, color: statusInk, textWrap: 'pretty' }}>
            {state.spin && <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--vault-hairline)', borderTopColor: 'var(--accent-300)', animation: 'cv-spin 1s linear infinite', flexShrink: 0, marginTop: 2 }} />}
            <span style={{ flex: 1 }}>{state.status}</span>
            {state.retry && (
              <span onClick={state.retry} style={{ flexShrink: 0, padding: '3px 9px', borderRadius: 7, border: '1px solid rgba(var(--danger-rgb),0.4)', fontSize: 11.5, fontWeight: 600, color: 'var(--danger-500)', cursor: 'pointer' }}>Retry</span>
            )}
          </div>
        )}

        {state.pill && (
          <div style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, background: 'rgba(var(--accent-300-rgb),0.12)', color: 'var(--accent-300)', fontSize: 10.5, fontWeight: 600 }}>
            <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><path d="M4 4l16 16" /></svg>
            Amount hidden on chain
          </div>
        )}

        {/* ALWAYS RENDERED, in every one of the ten states — the M10.0 guarantee. */}
        <div style={{ border: '1px dashed var(--vault-dash)', borderRadius: 10, padding: '9px 12px' }}>
          <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.12em', color: 'var(--text-muted-dim)' }}>PRIVATE NOTE</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-note)', marginTop: 3, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{plaintext}</div>
        </div>

        {/* INSIDE the card, unlike every other row's meta line. §8A draws the payment as an object
            rather than a bubble — uniform corners, no tail — and the time belongs to the object. */}
        <div style={{ fontSize: 10.5, color: 'var(--text-muted-dim)' }}>{bubbleTime(timestamp)}</div>
      </div>
    </div>
  )
}

function SentPaymentCard({ message, lid, flashed }: { message: CaravelMessage; lid?: string; flashed?: boolean }) {
  const amount = message.localPayment ? microToTari(message.localPayment.amountMicrotari) : null
  const state: PayCardState = amount !== null
    ? { dir: 'SENT', amount, pill: true }                                                   // S1
    : { dir: 'SENT', masked: true, tone: 'dim', status: 'Sent from another device, so the amount isn’t cached here.' }  // S2
  return <PaymentCard sent state={state} timestamp={message.timestamp} plaintext={message.plaintext} lid={lid} flashed={flashed} />
}

function ReceivedPaymentCard({ message, lid, flashed }: { message: CaravelMessage; lid?: string; flashed?: boolean }) {
  const { state: res, retry } = usePaymentResolution(message.payment!.utxoId)
  // Same branches, same order, same predicates as before — only what they PRODUCE has changed.
  let state: PayCardState
  if (res.kind === 'resolved') {
    state = { dir: 'RECEIVED', amount: microToTari(res.amountMicrotari), pill: true }        // R1
  } else if (res.kind === 'loading') {
    state = { dir: 'RECEIVED', tone: 'dim', spin: true, status: 'Resolving amount…' }        // R2
  } else if (res.kind === 'retrying' && res.reason === 'not_found') {
    // NO SPINNER, deliberately. The payment arrived; only the index is behind, and a spinner would
    // make a settled fact look like a request in doubt.
    state = { dir: 'RECEIVED', tone: 'dim', status: 'Waiting for the payment to be indexed. It will appear on its own.' }  // R3
  } else if (res.kind === 'retrying') {
    state = { dir: 'RECEIVED', tone: 'dim', spin: true, status: 'Reaching the indexer…' }    // R4
  } else if (res.reason === 'spent') {
    state = { dir: 'RECEIVED', tone: 'dim', status: 'Payment output has been spent.' }       // R5
  } else if (res.reason === 'unreadable') {
    state = { dir: 'RECEIVED', tone: 'dim', status: 'Not addressed to this wallet.' }        // R6
  } else if (res.reason === 'not_found') {
    // HONEST 404. The resolver cannot tell "spent" from "not yet indexed" at this status — its own
    // comment says so — and the old copy ("No matching output on chain") picked one and sounded
    // certain about it. This says what we actually know.
    state = { dir: 'RECEIVED', tone: 'danger', retry, status: 'Could not verify this payment. It may have been spent, or not yet indexed.' }  // R7
  } else {
    state = { dir: 'RECEIVED', tone: 'danger', retry, status: 'Could not reach the network.' }  // R8
  }
  return <PaymentCard sent={false} state={state} timestamp={message.timestamp} plaintext={message.plaintext} lid={lid} flashed={flashed} />
}

function PaymentMessageCard({ message, lid, flashed }: { message: CaravelMessage; lid?: string; flashed?: boolean }) {
  return message.direction === 'sent'
    ? <SentPaymentCard message={message} lid={lid} flashed={flashed} />
    : <ReceivedPaymentCard message={message} lid={lid} flashed={flashed} />
}

// ── Component ────────────────────────────────────────────────────────────────────

export default function ChatApp() {
  const { wallet, address, scan, messages, nostrPubkeyHex, messagingStatus, contacts, acceptContact, contactAddresses, setManualTariAddress, createMessagingProvider, recordSentMessage, deleteConversation, editMessage, reactMessage, getRelayStates, reconnectAll, groups, createGroup, acceptGroup, declineGroup, leaveGroup, reinviteGroup, balanceHidden } = useWallet()
  // Logo has no theme awareness of its own — `onLight` is a manual prop. Both marks in this view
  // sit on surfaces that are now light in the light theme, so the white mark would vanish.
  const { theme } = useTheme()
  const onLight = theme === 'light'
  const [sidebarQuery, setSidebarQuery] = useState('')
  const [relayPanelOpen, setRelayPanelOpen] = useState(false)

  // Selected conversation (peer hex). UI state only — falls back to most-recent when unset.
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  // CNS lives in chat rather than in the spine: the [@] beside the two list actions opens it as
  // an overlay over this view, which is why it is a boolean here and not a fourth service.
  const [cnsOpen, setCnsOpen] = useState(false)
  // C-M2 re-invite picker, keyed on the group it was opened for.
  const [reinviteFor, setReinviteFor] = useState<string | null>(null)

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
  // Group-invite in-flight guard (A-M2), keyed on group id — the parallel to busyRequest (which
  // keys on peerHex). Separate key space: a group invite and a DM request never collide.
  const [busyInvite, setBusyInvite] = useState<{ groupId: string; kind: 'accept' | 'decline' } | null>(null)

  // Composer state.
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // Per-message send overlay (design lifecycle): provisional bubbles rendered while a plain-text
  // send is in flight, then removed once the real persisted message appears (or marked 'failed').
  // ChatApp-local only — never persisted, never on the wire; the send path itself is unchanged.
  const [pendingSends, setPendingSends] = useState<(PendingSend & { peerHex: string; file?: File; caption?: string })[]>([])
  // Group equivalent, keyed on groupId (the parallel to pendingSends' peerHex). Same lifecycle:
  // provisional bubble before the fan-out resolves, removed on success, marked failed on throw.
  const [pendingGroupSends, setPendingGroupSends] = useState<(PendingSend & { groupId: string; file?: File; caption?: string })[]>([])
  // EDIT MODE (M3). The FOURTH exclusive composer state, alongside normal / paymentMode / confirming
  // — all four bind `draft`, so entering one while another is active would have them fight over the
  // same textarea. `stashedDraft` holds whatever the user had half-typed, restored verbatim on
  // cancel: starting an edit must never destroy an unsent message.
  const [editing, setEditing] = useState<{ logicalId: string; original: string } | null>(null)
  const [stashedDraft, setStashedDraft] = useState('')
  // Optimistic layer: the new text lives here while its publish is outstanding, because
  // editMessage only writes to the store once a relay ACCEPTS (M2). Never persisted, never on the
  // wire. See messageEdit.ts for why a failed flight snaps the bubble back instead of holding it.
  const [editFlights, setEditFlights] = useState<EditFlightMap>({})
  // REPLY MODE (replies v1). Unlike edit, this does NOT own the draft: you type a new message while
  // the chip names what you are quoting, so there is no stash to keep. Interlocked with edit via
  // canBeginReply/canBeginEdit (replyCompose.ts) — symmetric, so neither silently clears the other.
  const [replying, setReplying] = useState<{ logicalId: string } | null>(null)
  // Mirror of `editing` for the thread-switch reset below, which must know whether we WERE editing
  // without taking `editing` as a dependency (that would re-fire the whole payment-composer reset
  // every time an edit starts or ends).
  const editingRef = useRef(false)
  useEffect(() => { editingRef.current = !!editing }, [editing])
  // Ephemeral, honest partial-delivery note for the group composer footer: a fan-out can reach some
  // members and not others, and `membersReached` is RELAY ACCEPTANCE, not receipt — so this says
  // "reached", never "delivered". React state only; nothing is persisted per message (a durable
  // per-bubble indicator would need a local-only CaravelMessage field — noted follow-up).
  // `kind` (M4) names which fan-out fell short, since an EDIT fans out the same way a message does.
  // ONE slot for both, last-writer-wins: either way it means "the most recent thing you sent to this
  // group didn't reach everyone", and stacking two warn lines in the footer would say no more.
  const [groupSendNote, setGroupSendNote] = useState<{ groupId: string; kind: 'send' | 'edit'; reached: number; total: number } | null>(null)

  // Payment (TARI) composer state.
  // ATTACH MODE (images M5): the picked-but-not-yet-sent image. A FIFTH exclusive composer state
  // alongside normal / paymentMode / confirming — attaching while composing a payment would have the
  // two fighting over the same textarea, which in attach mode is the caption field.
  const [attachment, setAttachment] = useState<File | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const [paymentMode, setPaymentMode] = useState(false)
  const [payAmount, setPayAmount] = useState('')       // XTR, as typed
  const [payAddress, setPayAddress] = useState('')     // recipient otl_esm_ (manual — see caveat)
  const [confirming, setConfirming] = useState(false)  // inline confirm panel shown
  const [payBusy, setPayBusy] = useState(false)        // payment/message in flight
  const [payProgress, setPayProgress] = useState<string | null>(null)
  const [payError, setPayErrorRaw] = useState<string | null>(null)
  /**
   * Whether we may add "Nothing left your wallet." to the error.
   *
   * §8B·4 states it flatly, and for four of the five failure sites it is simply true: a validation
   * refusal, the pre-flight connection check, a locked wallet, and an on-chain Reject all fail
   * BEFORE or INSTEAD OF money moving. The fifth is the catch, and there it is unprovable — this
   * file's own note on that path says a throw "can land either side of the money moving and proves
   * neither". Telling someone their funds are safe on the one path where we cannot know is the
   * confident-wrong-claim this codebase keeps engineering against, so the flag DEFAULTS TO FALSE and
   * each safe site opts in: a new failure site added later stays quiet until someone proves it can.
   */
  const [payErrorSafe, setPayErrorSafe] = useState(false)
  /**
   * EVERY pay error goes through the translator (M9 C10).
   *
   * This screen spends the same money through the same builders as the wallet's Send tab, and those
   * builders speak µtTARI and "output(s)" on purpose — their messages are quoted in tests and in
   * on-chain reconciliation notes, so they are not softened at source. The wallet modal translates
   * at its boundary; chat had no boundary and showed them raw, so the identical failure read as
   * "amount is spread across too many small outputs" here and as plain English three tabs away.
   *
   * plainError passes anything it does not recognise through UNCHANGED, so routing the fixed
   * strings and network rejections through it too costs nothing and means no future call site can
   * forget. That is the point of wrapping the setter rather than the call sites.
   */
  const setPayError = useCallback((m: string | null, safe = false) => {
    setPayErrorRaw(m === null ? null : plainError(m))
    setPayErrorSafe(m !== null && safe)
  }, [])
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

  // ── Groups (Phase 1) — a parallel selection path; DM logic above is untouched ──
  const selectedGroup: Group | null = selectedGroupId ? (groups.find(g => g.id === selectedGroupId) ?? null) : null
  const groupMessages = useMemo(
    () => (selectedGroupId ? messages.filter(m => m.groupId === selectedGroupId).sort(compareMessages) : []),
    [messages, selectedGroupId]
  )
  // Sidebar group rows, split by invite state (A-M2). Only ACTIVE groups render as open-thread
  // rows; PENDING groups render as invite cards (accept/decline); 'left' groups are excluded from
  // both — the store already suppresses them, this is where the UI finally stops surfacing them.
  const activeGroupRows = useMemo(() => {
    return groups
      .filter(g => g.state === 'active')
      .map(g => {
        const gmsgs = messages.filter(m => m.groupId === g.id)
        // Preview text comes from PROSE only: a system notice (B-M2) has empty plaintext and would
        // render as a blank preview. It still counts for lastActivity, so a leave re-sorts the row.
        const prose = gmsgs.filter(m => !m.system)
        // Same rule as the DM list above, via the same comparator — so "newest" cannot mean one
        // thing in the thread and another in the sidebar row summarising it.
        const lastMessage = prose.length ? prose.reduce((a, b) => (compareMessages(a, b) > 0 ? a : b)) : null
        const newest = gmsgs.length ? gmsgs.reduce((a, b) => (compareMessages(a, b) > 0 ? a : b)) : null
        return { group: g, lastMessage, lastActivity: newest ? sortKey(newest) : g.createdAt }
      })
      .sort((a, b) => b.lastActivity - a.lastActivity)
  }, [groups, messages])
  // Pending group invites, newest-first by creation. Their held messages stay in the store,
  // unsurfaced (A-M1), until accept flips the group to 'active'.
  const pendingInvites = useMemo(
    () => groups.filter(g => g.state === 'pending').sort((a, b) => b.createdAt - a.createdAt),
    [groups],
  )

  // Release the in-flight guards once their card is gone (C-M1 fix). Both guards are keyed on the
  // subject's id and were never cleared: harmless while an id could only ever be pending ONCE, but
  // a re-invite returns the SAME group id to 'pending', and the stale 'accept' then rendered the
  // fresh card permanently mid-flight (a spinner that only a reload — which resets this component
  // state — could clear). Clearing on the commit that removes the card means no flicker, and it
  // holds for any future path that re-pends a subject rather than special-casing re-invite.
  // busyRequest has the identical latent bug, masked only because declineRequest deletes outright.
  useEffect(() => {
    if (busyInvite && !pendingInvites.some(g => g.id === busyInvite.groupId)) setBusyInvite(null)
  }, [pendingInvites, busyInvite])
  useEffect(() => {
    if (busyRequest && !pendingRequests.some(c => c.peerHex === busyRequest.peerHex)) setBusyRequest(null)
  }, [pendingRequests, busyRequest])

  // Only an ACTIVE group opens a thread (A-M2 §5). Pending groups reach the user as invite cards,
  // never as a clickable row; this guard makes "opening a pending group can't open the thread"
  // structural rather than incidental.
  function selectGroup(gid: string) {
    if (groups.find(g => g.id === gid)?.state !== 'active') return
    setSelectedGroupId(gid); setSelectedPeer(null)
  }

  // Leave a group (B-M1 + B-M2). ORDERING IS THE POINT: fan the leave notice out FIRST, while the
  // provider and the roster are still in hand (`group.members` is captured in the closure, so the
  // state flip below cannot affect wraps still in flight), then suppress locally — synchronously and
  // unconditionally. The send is deliberately NOT awaited and its rejection is swallowed: leaving is
  // a local act, so a dead relay costs the notice, never the leave. Same fire-and-forget shape as
  // createGroup's definition fan-out; sendGroupLeave never throws by design.
  // Clearing the selection is required — the render guard below demands state 'active'.
  function handleLeaveGroup(group: Group) {
    const provider = createMessagingProvider()
    if (provider) {
      provider.sendGroupLeave(group.id, group.members)
        .catch(() => { /* best-effort — the notice is cosmetic; the leave already happened locally */ })
        .finally(() => provider.disconnect())
    }
    leaveGroup(group.id)
    setSelectedGroupId(null)
  }

  // Send to the selected group: fan out via the provider, then record the local 'sent' row. The
  // provider's tally is relays-reached, not a delivery receipt (see sendGroupMessage).
  // Group send, at DM parity: a provisional bubble appears immediately (so the thread scrolls and
  // the wait is visible), then resolves to a real message or a failed bubble with Retry.
  //
  // PARTIAL FAN-OUT is the one genuinely group-specific case. sendGroupMessage throws only when the
  // message reached NO member, and that is exactly the boundary where a retry is safe: retrying
  // re-wraps with fresh event ids, so anyone who already received the message would get a duplicate
  // (addReceivedMessage dedups by event id only). So ≥1 reached is recorded as sent with NO retry
  // offered, and the shortfall is reported honestly in the composer footer instead.
  async function sendToGroup(groupId: string, members: string[], text: string, replyTo?: string) {
    const tempId = `gpending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setPendingGroupSends(p => [...p, { id: tempId, groupId, text, status: 'sending', attemptedAt: Date.now() }])
    setGroupSendNote(null)
    try {
      const provider = createMessagingProvider()
      // Locked wallet → null. Previously this returned silently; now it surfaces as a failed bubble.
      if (!provider) throw new Error('Wallet is locked — unlock to send')
      try {
        const res = await provider.sendGroupMessage(groupId, members, text, { replyTo })
        recordSentMessage(res.message)
        setPendingGroupSends(p => p.filter(x => x.id !== tempId))  // real persisted bubble now shows
        // Reached some but not all — surface it rather than letting "sent" imply everyone got it.
        if (res.membersReached < res.memberCount) {
          setGroupSendNote({ groupId, kind: 'send', reached: res.membersReached, total: res.memberCount })
        }
      } finally {
        provider.disconnect()
      }
    } catch (e) {
      // Mirrors the DM path: log the underlying relay error (the bubble shows no raw string), then
      // switch the provisional bubble to failed + Retry. This catch is also what stops the rejection
      // escaping into an unhandled promise rejection, which it did for every failed group send.
      console.warn('[Caravel] group message send failed:', e)
      setPendingGroupSends(p => p.map(x => x.id === tempId ? { ...x, status: 'failed' } : x))
      throw e   // GroupThread's send() relies on this to keep the draft (it clears only on success)
    }
  }

  async function handleGroupSend(text: string, replyTo?: string) {
    if (!selectedGroup) return
    await sendToGroup(selectedGroup.id, selectedGroup.members, text, replyTo)
  }

  // Retry a failed group send. Unlike the DM retry (which re-reads the composer draft), this resends
  // the PENDING ENTRY'S OWN TEXT — ChatApp doesn't own the group composer's draft, and retrying the
  // message you actually tried to send is the correct semantic anyway. Only reachable from a bubble
  // whose send reached nobody, so it cannot duplicate.
  function retryGroupSend(id: string) {
    const entry = pendingGroupSends.find(x => x.id === id)
    if (!entry) return
    if (entry.file) { retryImage(id); return }   // image entry — re-run the image path
    const group = groups.find(g => g.id === entry.groupId)
    if (!group) return
    setPendingGroupSends(p => p.filter(x => x.id !== id))
    void sendToGroup(group.id, group.members, entry.text).catch(() => { /* surfaced as a failed bubble */ })
  }

  // Roster options for the C-M2 re-invite picker: the FULL roster minus self, annotated with a
  // BELIEVED-LEFT hint and sorted so believed-left members come first.
  //
  // The hint is derived from the leave notices already persisted by B-M2 (system rows in `messages`)
  // — no new store. It is deliberately only a hint: leave notices are best-effort, so a member can
  // be genuinely gone with no notice, and pre-B-M2 leaves left none at all. That is why every roster
  // member stays listed and selectable; the hint drives ordering, subtitle and pre-selection only.
  //
  // A member who left and later RE-JOINED still has their old leave row, so compare it against their
  // newest ordinary message: if they have spoken since leaving, they are back and not flagged.
  const reinviteMembers: ReinviteMemberOption[] = useMemo(() => {
    const g = reinviteFor ? groups.find(gr => gr.id === reinviteFor) : null
    if (!g) return []
    const gmsgs = messages.filter(m => m.groupId === g.id)
    const newestBy = (hex: string, pick: (m: CaravelMessage) => boolean) =>
      // A high-water NUMBER rather than a message, so this takes sortKey and not the comparator.
      // Note what it now rests on: a leave notice is stamped on OUR clock, an ordinary message on
      // the SENDER's, and this compares the two. A member who back-dates therefore reads as not
      // having spoken since leaving — bounded by nothing, since the clamp only caps the future.
      gmsgs.reduce((acc, m) => (m.senderPubkeyHex === hex && pick(m) && sortKey(m) > acc ? sortKey(m) : acc), 0)
    return g.members
      .filter(hex => hex && hex !== nostrPubkeyHex)
      .map(hex => {
        const leftTs = newestBy(hex, m => m.system === 'group-leave')
        const spokeTs = newestBy(hex, m => !m.system)
        // Inlined rather than via displayName() so the memo depends on `nicknames` itself, not on a
        // function identity that changes every render.
        return { hex, name: nicknames[hex] ?? truncNpub(hex), leftAt: leftTs > spokeTs && leftTs > 0 ? leftTs : null }
      })
      .sort((a, b) => (b.leftAt ?? 0) - (a.leftAt ?? 0))
  }, [reinviteFor, groups, messages, nostrPubkeyHex, nicknames])

  // Accepted contacts offered in the create-group modal, resolved to display names.
  const groupContactOptions: GroupContactOption[] = Object.entries(contacts)
    .filter(([, c]) => (c?.state ?? 'accepted') === 'accepted')
    .map(([hex]) => ({ hex, name: displayName(hex) }))

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

  // Accept a pending group invite (A-M2) → acceptGroup flips it to 'active' (releasing its held
  // messages at the store), then open the now-active thread. No address handshake (Flag B) and no
  // auto-reply — the group parallel to acceptRequest.
  function acceptInvite(groupId: string) {
    acceptGroup(groupId)
    setSelectedGroupId(groupId)
    setSelectedPeer(null)
  }

  // Decline a group invite (A-M2) → declineGroup marks it 'left' (permanent local suppression;
  // A-M1). Unlike declineRequest this is NON-destructive (Flag C): held messages stay in the store,
  // suppressed by state — nothing to delete, no nickname/address to clear (groups have neither).
  function declineInvite(groupId: string) {
    declineGroup(groupId)
  }

  // Send the composer draft to the selected conversation. Same proven path as the dev panel:
  // a throwaway provider per send (a separate NostrMessagingProvider instance — it does NOT
  // disturb the long-lived subscription in WalletContext), then record the returned message so
  // it appears in the thread immediately without waiting for a relay round-trip.
  async function handleSend() {
    const text = draft.trim()
    if (!text || !selectedConvo || sending || editing) return
    setSending(true)
    const peer = selectedConvo.peerHex
    // Overlay (flag 1): show a provisional "sending" bubble immediately. Additive — the send path
    // below is unchanged.
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setPendingSends(p => [...p, { id: tempId, peerHex: peer, text, status: 'sending', attemptedAt: Date.now() }])
    try {
      const provider = createMessagingProvider()
      // Locked wallet → null. Surface a clear reason rather than leaking a null-reference error.
      if (!provider) throw new Error('Wallet is locked — unlock to send')
      // Self-healing address exchange (M9.0d): piggyback my address until the peer has it.
      const addr = outboundAddressFor(peer)
      const msg = await provider.sendMessage(peer, text, { tariAddress: addr, replyTo: replying?.logicalId })
      provider.disconnect()
      recordSentMessage(msg)
      if (addr) markSent(peer)
      setDraft('')  // clear only on success — a failed send keeps the text
      setReplying(null)  // same rule as the draft: the quote survives a failed send, with the text
      setPendingSends(p => p.filter(x => x.id !== tempId))  // real persisted bubble now shows
    } catch (e) {
      // The design's failed bubble shows only "Couldn't send" + Retry (no raw string), so log the
      // underlying relay error here — a systematic failure stays diagnosable in the console.
      console.warn('[Caravel] message send failed:', e)
      setPendingSends(p => p.map(x => x.id === tempId ? { ...x, status: 'failed' } : x))  // failed bubble + Retry; draft kept
    } finally {
      setSending(false)
    }
  }

  // ── Image sending (images M5) ────────────────────────────────────────────────
  //
  // ChatApp owns the provider, so it owns the send for BOTH threads: the DM composer calls this
  // directly, and GroupThread hands its picked file up via onSendImage.
  //
  // An image send gets the SAME provisional bubble a text send has always had — 'sending' (labelled
  // with the pipeline stage), then either the real row or a failed bubble carrying stage-specific
  // copy and, only where it could work, a Retry. The File rides on the pending entry so Retry can
  // re-run it. ChatApp-local state only: never persisted, never on the wire.
  const [imageBusy, setImageBusy] = useState(false)
  // The current pipeline stage, shown on the preview panel while a send runs. Null when idle.
  const [imageStage, setImageStage] = useState<string | null>(null)

  async function sendImage(file: File, caption: string | undefined, target: { groupId: string; members: string[] } | { peerHex: string }) {
    if (imageBusy) return
    setImageBusy(true)
    const tempId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const inGroup = 'groupId' in target
    // Stage labels ride on the provisional bubble's text so the user can see WHERE a slow send is —
    // preparing a large photo, uploading, or waiting on relays are very different waits.
    const setStage = (stage: MediaSendStage) => {
      const words = describeMediaStage(stage)
      setImageStage(words)
      const label = `${file.name} · ${words}`
      if (inGroup) setPendingGroupSends(p => p.map(x => x.id === tempId ? { ...x, text: label } : x))
      else setPendingSends(p => p.map(x => x.id === tempId ? { ...x, text: label } : x))
    }

    if (inGroup) setPendingGroupSends(p => [...p, { id: tempId, groupId: target.groupId, text: file.name, status: 'sending', attemptedAt: Date.now(), file, caption }])
    else setPendingSends(p => [...p, { id: tempId, peerHex: target.peerHex, text: file.name, status: 'sending', attemptedAt: Date.now(), file, caption }])

    const provider = createMessagingProvider()
    try {
      if (!provider) throw new Error('Wallet is locked — unlock to send')
      if (inGroup) {
        const { result, plaintextBytes } = await sendImageToGroup(provider, file, target.groupId, target.members, caption, setStage)
        recordSentMessage(result.message)
        seedOwnImage(result.message, plaintextBytes)
        setPendingGroupSends(p => p.filter(x => x.id !== tempId))
      } else {
        const addr = outboundAddressFor(target.peerHex)
        const { message, plaintextBytes } = await sendImageToPeer(provider, file, target.peerHex, caption, addr, setStage)
        recordSentMessage(message)
        seedOwnImage(message, plaintextBytes)
        if (addr) markSent(target.peerHex)
        setPendingSends(p => p.filter(x => x.id !== tempId))
      }
    } catch (e) {
      // Logged for diagnosis AND surfaced on the bubble — the console alone is not a user interface.
      console.warn('[Caravel] image send failed:', e)
      const failure = describeMediaFailure(e, file)
      const restore = (x: { id: string }) => x.id === tempId
      if (inGroup) setPendingGroupSends(p => p.map(x => restore(x) ? { ...x, text: file.name, status: 'failed', failure } : x))
      else setPendingSends(p => p.map(x => restore(x) ? { ...x, text: file.name, status: 'failed', failure } : x))
    } finally {
      provider?.disconnect()
      setImageBusy(false)
      setImageStage(null)
    }
  }

  // SENDER-SEED (the M4 deferral, contract documented at both ends). We already hold the decrypted
  // bytes we just encrypted and uploaded, so writing them straight into the blob cache means our own
  // image renders instantly from cache instead of round-tripping our own upload back from the host.
  //
  // Fire-and-forget and idempotent: the resolver reads the same cache first, and a `put` on the same
  // key at worst overwrites identical bytes.
  function seedOwnImage(message: CaravelMessage, plaintextBytes: ArrayBuffer) {
    if (!nostrPubkeyHex || !message.media) return
    void putBlob(nostrPubkeyHex, message.media.x, plaintextBytes, message.media.mime)
  }

  // Picked from the DM composer. GroupThread has its own picker and routes through onSendImage.
  async function sendImageToSelectedPeer(file: File, caption: string | undefined) {
    if (!selectedConvo) return
    await sendImage(file, caption, { peerHex: selectedConvo.peerHex })
  }

  // Retry a failed image send by re-running it with the File kept on the pending entry. Only
  // reachable where describeMediaFailure marked the failure retryable — an undecodable file or an
  // over-cap one shows no Retry at all, because a second attempt gives the identical result.
  function retryImage(id: string) {
    const dm = pendingSends.find(x => x.id === id)
    const grp = pendingGroupSends.find(x => x.id === id)
    const entry = dm ?? grp
    if (!entry?.file) return
    // Re-target from the entry itself rather than from the currently-open thread: a retry must go
    // back where it was attempted even if the user has since switched conversations.
    const group = grp ? groups.find(g => g.id === grp.groupId) : undefined
    if (grp && !group) return
    setPendingSends(p => p.filter(x => x.id !== id))
    setPendingGroupSends(p => p.filter(x => x.id !== id))
    // The caption rides on the entry too — a retry that silently dropped it would send a different
    // message from the one the user composed.
    void sendImage(entry.file, entry.caption, grp
      ? { groupId: group!.id, members: group!.members }
      : { peerHex: dm!.peerHex })
  }

  // Clear a failed provisional bubble. The ONLY deliberate way out, and the only one at all for a
  // terminal failure such as an undecodable image, which shows no Retry.
  //
  // Text sends have needed this since they were built: their apparent dismiss was an accident —
  // Retry removed the entry and then handleSend() bailed on the first line because the composer was
  // empty. That happened to work and was never intended to be the mechanism.
  function dismissPending(id: string) {
    setPendingSends(p => p.filter(x => x.id !== id))
    setPendingGroupSends(p => p.filter(x => x.id !== id))
  }

  // Retry a failed provisional send: drop the failed bubble and re-run the send (the draft still
  // holds the text, since a failed send never clears it).
  function retrySend(id: string) {
    // An image entry carries its File — re-run the image path rather than re-reading the composer
    // draft, which has nothing to do with it.
    if (pendingSends.find(x => x.id === id)?.file) { retryImage(id); return }
    setPendingSends(p => p.filter(x => x.id !== id))
    handleSend()
  }

  // ── Message editing (M3) ─────────────────────────────────────────────────────

  // Load a message into the composer. Refused while any other composer state owns the draft
  // (payment compose / confirm) or while a send is in flight — all of them bind the same textarea.
  // Load a message into the reply chip. Refused mid-EDIT (symmetric interlock) and while a send is
  // in flight; re-targeting an existing reply is allowed, since picking a different message to quote
  // is a normal correction and not a state change.
  function beginReply(logicalId: string) {
    if (!canBeginReply({ editing: !!editing, replying: !!replying })) return
    if (sending || payBusy) return
    setReplying({ logicalId })
    composerRef.current?.focus()
  }

  function cancelReply() {
    setReplying(null)
  }

  function beginEdit(logicalId: string, currentText: string) {
    // Symmetric interlock: an edit cannot start while a reply is pending. Cancelling the reply for
    // the user would discard a choice they made without saying so — see replyCompose.ts.
    if (!canBeginEdit({ editing: !!editing, replying: !!replying })) return
    // `attachment` belongs in this list for the same reason as the others, and it is the one neither
    // feature branch could have added alone: attach mode uses this same textarea as the image's
    // CAPTION field while edit mode uses it as the EDIT field, both bound to `draft`. With an image
    // picked, starting an edit would have the caption and the edit text overwrite each other and
    // Save/Send act on whichever won — silently, with nothing thrown and nothing failing to compile.
    if (paymentMode || confirming || sending || payBusy || attachment) return
    setStashedDraft(editing ? stashedDraft : draft)   // don't clobber the stash when re-targeting
    setEditing({ logicalId, original: currentText })
    setDraft(currentText)
    composerRef.current?.focus()
  }

  // ── Reactions (C) ───────────────────────────────────────────────────────────
  // Which message's quick-set is open (by logicalId), and which (message, emoji) pair is mid-flight.
  const [reactOpen, setReactOpen] = useState<string | null>(null)
  const [reactPending, setReactPending] = useState<{ logicalId: string; emoji: string } | null>(null)

  // THE one reaction publish path for the DM thread. Deliberately NOT optimistic, unlike saveEdit
  // below (F7): reactMessage writes the store only once a relay has accepted, so between tap and
  // pill there is nothing to render — and a reaction is cheap enough that inventing a flight map,
  // a snap-back and a Retry for it would cost more than it is worth. The feedback is the tapped
  // control dimming until the round trip settles, which is honest about what is and is not known.
  //
  // A failed reaction is therefore SILENT: the pill simply never appears. That is the deliberate
  // trade — an edit that vanishes is a lie about what the other side is reading, a reaction that
  // vanishes is a reaction that was never sent.
  async function toggleReaction(logicalId: string, emoji: string, action: 'add' | 'remove') {
    if (reactPending) return                     // one at a time; the popover is disabled meanwhile
    setReactPending({ logicalId, emoji })
    try { await reactMessage(logicalId, emoji, action) }
    finally {
      setReactPending(null)
      setReactOpen(null)
    }
  }

  // Put the composer back exactly as the user left it.
  function cancelEdit() {
    if (!editing) return
    setEditing(null)
    setDraft(stashedDraft)
    setStashedDraft('')
  }

  // THE one edit publish path, shared by the DM composer, the group composer (via GroupThread's
  // onSaveEdit) and both Retry buttons. Optimistic by design: the bubble shows the new text
  // immediately (a publish can take up to PUBLISH_TIMEOUT_MS, and a frozen bubble reads as broken),
  // while the STORE only changes if the edit actually got out — editMessage owns that. On failure the
  // flight flips to 'failed', the bubble snaps back to the stored text, and a Retry appears.
  //
  // GROUPS (M4) add partial reach. `ok` is TOTAL-failure-only there, so a fan-out that reached some
  // members keeps the new text (those members already show it) and the shortfall is reported in the
  // composer footer instead. Nothing on either path ever claims the edit was DELIVERED.
  async function runEdit(logicalId: string, text: string) {
    setEditFlights(m => beginFlight(m, logicalId, text))
    const res = await editMessage(logicalId, text)
    setEditFlights(m => settleFlight(m, logicalId, res.ok))

    // Partial fan-out: same honest tally the group SEND footer shows, flagged as an edit so the line
    // names the right thing. Counts are group-only, so a DM never reaches this.
    const groupId = messages.find(m => m.logicalId === logicalId)?.groupId
    if (res.ok && groupId && res.memberCount !== undefined && res.membersReached !== undefined
        && res.membersReached < res.memberCount) {
      setGroupSendNote({ groupId, kind: 'edit', reached: res.membersReached, total: res.memberCount })
    }
  }

  // Save from the DM composer.
  async function saveEdit() {
    if (!editing) return
    const next = draft.trim()
    // Unchanged or empty is a cancel, not a send: it would burn a revision for nothing.
    if (!isEditSubmittable(editing.original, next)) { cancelEdit(); return }

    const { logicalId } = editing
    setEditing(null)
    setDraft(stashedDraft)
    setStashedDraft('')
    await runEdit(logicalId, next)
  }

  // Retry a failed edit with the text the user actually typed (kept on the failed flight). Safe to
  // offer after ANY failure, including a partial group fan-out: applyEdit's strictly-newer guard
  // makes a re-delivered edit idempotent, so unlike a retried group SEND this cannot duplicate.
  async function retryEdit(logicalId: string) {
    const flight = editFlights[logicalId]
    if (!flight) return
    await runEdit(logicalId, flight.text)
  }

  // ── Payment (TARI) flow ──────────────────────────────────────────────────────

  function toggleTari() {
    if (payBusy) return
    if (editing) return   // edit mode owns the composer; leave it explicitly first
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
  //
  // THE RULE ITSELF LIVES IN paymentGuard.ts, and the reason is written there: it used to block on a
  // TRUNCATED scan, where the balance is a lower bound and "larger than what we could see" is not
  // "more than you have". Inline in this file nothing could test it, and it failed as a disabled
  // button with no explanation.
  // ── The "Private available" line (§8B·1) ────────────────────────────────────
  //
  // PRIVATE ONLY, and that is the honest figure rather than a partial one. A chat payment goes
  // through sendConfidential, which spends confidential UTXOs — the public balance is not spendable
  // from this panel without a move first, so showing it here would offer money this button cannot
  // touch. The wallet's Send tab shows both because it can actually choose a source; this cannot.
  //
  // The three qualifications are the wallet's, not new ones: null is "—" and never 0 (a failed read
  // is not an empty wallet), a truncated scan keeps its figure and states the uncertainty rather
  // than withdrawing a number that is safe to act on, and the hide toggle masks it.
  const availableLowerBound = balanceIsLowerBound(scan)
  const availableText = balanceHidden
    ? MASK_SHORT
    : scan.balance === null ? '—' : `${fmt6(scan.balance)} XTR`

  const payAmountNum = Number(payAmount)
  const payAmountUsable = !!payAmount.trim() && isFinite(payAmountNum) && payAmountNum > 0
  const payInsufficient = isInsufficientBalance(
    payAmountUsable ? tariToMicrotari(payAmountNum) : null,
    MAX_FEE,
    scan,
  )

  function validatePayment(): string | null {
    const amt = Number(payAmount)
    if (!payAmount.trim() || !isFinite(amt) || amt <= 0) return 'Enter an amount greater than 0.'
    // THE SAME CHECK THE WALLET USES — parse, network byte, key length. A prefix test is not
    // enough: a MAINNET address starts with otl_ too, is well-formed, and parses cleanly, so it
    // passes `startsWith` and then commits the payment to keys nobody on this chain is watching.
    // There is no bounce and no error at spend time, which makes it unrecoverable. This screen
    // spends the same money as the wallet's Send tab and gets the same guard.
    try {
      assertValidRecipient(effectivePayAddress, parseOotleAddress)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    if (payInsufficient) return 'Insufficient balance.'
    return null
  }

  // Send button: in payment mode this validates and opens the confirm gate; otherwise plain send.
  function onComposerSend() {
    if (paymentMode) {
      const err = validatePayment()
      if (err) { setPayError(err, true); return }   // validation — nothing has been attempted
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
      setPayError('Not connected to relays — cannot announce the payment. Try again once connected.', true)
      return
    }
    if (!wallet || !address) { setPayError('Wallet is locked — unlock to send.', true); return }

    const amountMicro = tariToMicrotari(Number(payAmount))
    const recipientAddr = effectivePayAddress   // exchanged address, or the manually-entered one
    const note = draft.trim() || '💸 Payment'   // NIP-44 needs ≥1 byte; empty note gets a caption
    const peerHex = selectedConvo.peerHex
    const amountShown = payAmount

    setPayBusy(true)
    setPayProgress('Starting payment…')

    // ── JOURNALLED FOR SUBTRACTION, NOT FOR DISPLAY ──
    //
    // A chat payment spends this wallet's confidential UTXOs and hands back a change output at our
    // own stealth address. That output carries no sender, exactly like a payment from a stranger,
    // so a later scan cannot tell the two apart — and reconciliation would report our own change
    // as money somebody sent us. Recording its commitment is what stops that.
    //
    // IT NEVER BECOMES A WALLET ACTIVITY ROW. activity.ts returns no row for `chat-payment`, the
    // same way it returns none for `receive`. Compartmentalisation is about the display, and this
    // is bookkeeping.
    //
    // WHAT IS DELIBERATELY NOT RECORDED: the peer and the note. Those are chat's, they already
    // live in the message store, and copying them into the wallet's plaintext journal would widen
    // the disclosure for no gain — subtraction needs the commitments and nothing else. The amount
    // and fee ARE recorded: that is this wallet's own money moving, which is its business.
    const journalId = beginEntry(address, {
      kind: 'chat-payment',
      amountMicrotari: amountMicro,
      feeMicrotari: null,
      from: 'private',
      to: 'external',
      counterparty: null,
      note: null,
      source: 'local-journal',
      selfOutputIds: null,
    }).entry.id

    try {
      const result = await sendConfidential(wallet, address, {
        recipient: recipientAddr,
        amountMicrotari: amountMicro,
        onProgress: (m) => setPayProgress(m),
      })

      // BEFORE THE BRANCHING, AND THAT IS THE POINT. Every exit below — rejected, timed out, no
      // recipient id, no provider, and the orphan where the payment lands but the message does not
      // — happens after the transaction was already submitted. One settle here covers all of them,
      // where a write inside each branch would be five chances to miss the one that matters most.
      settleEntry(address, journalId, {
        outcome: result.outcome === 'Commit' ? 'committed'
          : result.outcome === 'Reject' ? 'rejected'
          : 'timeout',
        txId: result.txId,
        feeMicrotari: result.feeMicrotari ?? null,
        // A rejected transaction created nothing, so there is nothing of ours on chain to subtract.
        selfOutputIds: result.outcome === 'Reject' ? [] : result.selfOutputIds ?? null,
      })

      if (result.outcome === 'Reject') {
        // Nothing happened — keep payment mode + fields so the user can adjust and retry.
        setPayError('Payment was rejected on-chain — nothing was sent.', true)
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
        const msg = await provider.sendMessage(peerHex, note, { payment: { utxoId: result.recipientUtxoId }, tariAddress: addr })
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
      // The throw path. The row already exists, so an exception mid-broadcast leaves a record that
      // the attempt happened rather than nothing at all — and records it as ATTEMPTED, because a
      // throw can land either side of the money moving and proves neither.
      settleEntry(address, journalId, { outcome: 'pending' })
      // NO `safe` FLAG HERE, deliberately — same reason the journal records this as ATTEMPTED. The
      // error strip will not add "Nothing left your wallet."; on this one path we do not know that.
      setPayError(e instanceof Error ? e.message : String(e))
    } finally {
      setPayBusy(false)
      setPayProgress(null)
    }
  }

  // Auto-scroll to newest: on conversation open and whenever this thread gains a message. Shared
  // with GroupThread so the two views can't drift — see useScrollToBottom.
  const selectedPeerHex = selectedConvo?.peerHex ?? null
  // Pending sends count too, so a provisional bubble is scrolled into view as soon as it appears
  // instead of only when the real message lands — AND so the swap to the real row re-fires, which a
  // bare total never did. Same rule in GroupThread — one behaviour. See threadContentKey.
  const bottomRef = useScrollToBottom(
    selectedPeerHex,
    threadContentKey(selectedConvo?.messages ?? [], pendingSends.filter(p => p.peerHex === selectedPeerHex)),
  )

  // Reset the payment composer when switching conversations so a half-filled payment can't carry
  // across to a different peer. The must-acknowledge alert banner is intentionally NOT reset here.
  //
  // `attachment` belongs in here for the same reason, and more urgently (images M5): a picked photo
  // left mounted across a thread switch would sit in the new conversation's composer, and pressing
  // Send would deliver it TO THE WRONG PERSON. That is a privacy failure, not a UI wrinkle.
  //
  // Switching between a DM and a GROUP does not necessarily change selectedPeerHex — but it does not
  // need to: the DM composer is not rendered while a group thread is open (the right pane renders one
  // or the other), so the preview is unmounted and its object URL revoked, and coming back lands on
  // the SAME peer it was picked for. Only a change of peer can misdirect a send, and that is exactly
  // what this dependency tracks.
  useEffect(() => {
    setAttachment(null)
    setPaymentMode(false)
    setConfirming(false)
    setPayError(null)
    setPayAmount('')
    setMenuOpen(false)
    // Edit mode is per-message, so it cannot survive a thread switch — otherwise the composer would
    // stay loaded with another conversation's text and Save would edit a message you can't see.
    // Restoring the stash here would drop it into the WRONG thread's composer, so the draft is
    // simply cleared, exactly as every other composer state is on switch.
    setEditing(null)
    setStashedDraft('')
    setDraft(d => (editingRef.current ? '' : d))
    // A reply names a message in the thread being left, so it cannot survive the switch either.
    setReplying(null)
    // The picker is anchored to a composer that is about to hold a different conversation's draft.
    setEmojiOpen(false)
    // The quick-set is anchored to a bubble that is about to unmount.
    setReactOpen(null)
  }, [selectedPeerHex])

  // Auto-grow the composer with its content: reset to 'auto' to measure, then set to the
  // content height capped at COMPOSER_MAX_H (beyond which it scrolls internally). Keyed on the
  // draft, so it grows on Shift+Enter/wrap, shrinks on delete, and resets to one line on send.
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // logicalId → message for the OPEN thread, built once per render pass so a quote resolves with a
  // Map lookup instead of a scan. The alternative — messages.find() per rendered reply — is
  // O(rows × replies) over an array that holds every thread's messages, paid on every keystroke.
  const quotedIndex = useMemo(() => {
    const map = new Map<string, CaravelMessage>()
    for (const m of selectedConvo?.messages ?? []) if (m.logicalId) map.set(m.logicalId, m)
    return map
  }, [selectedConvo?.messages])

  // Who the pending reply quotes, for the chip. 'yourself' rather than your own name: the chip is
  // read in the second person ("Replying to …"), and a DM has only two participants, so a name there
  // would be the only place in the thread the user is addressed by their own handle.
  // Tap-to-jump (replies v1). Keyed on the open peer so a flash cannot survive a thread switch.
  const { containerRef: threadRef, flashedId, jumpTo } = useJumpToMessage(selectedPeerHex)

  const replyTarget = replying ? quotedIndex.get(replying.logicalId) : undefined
  const replyChipLabel = !replyTarget
    ? 'a message'
    : replyTarget.direction === 'sent'
      ? 'yourself'
      : displayName(replyTarget.senderPubkeyHex)
  useEffect(() => {
    const el = composerRef.current
    // A HIDDEN SUBTREE MEASURES ZERO, AND THAT ZERO IS PERMANENT.
    //
    // AppShell mounts all three services at once and hides the inactive ones with display:none, so
    // this effect's first run happens before chat has ever been shown — and `selectedConvo` falls
    // back to conversations[0], so the composer is already mounted when it does. scrollHeight is 0
    // in a display:none subtree, and writing that to an inline height is a one-way door: React never
    // clears it (`height` is not in the textarea's style prop, only maxHeight), and this effect only
    // re-runs on `draft`, which cannot change through a zero-height textarea. The composer was dead
    // until something unmounted and remounted it — switching to a group and back.
    //
    // offsetParent is null exactly when an ancestor is display:none. It is also null for a
    // position:fixed element; this composer is neither, so the check means here what it says.
    // Skipping the write is safe: the textarea keeps its natural rows={1} height, and the first
    // keystroke re-runs this with real layout.
    if (!el || el.offsetParent === null) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX_H) + 'px'
  }, [draft])

  // ── Emoji picker (B) ────────────────────────────────────────────────────────
  const [emojiOpen, setEmojiOpen] = useState(false)

  // Where the caret must go once React has committed the draft an insert produced, or null when
  // nothing is pending.
  //
  // THIS REF IS THE WHOLE REASON insertAtCursor RETURNS A CARET. The textarea is CONTROLLED, so
  // writing a new `draft` re-renders it with a fresh value and the browser drops the caret at the
  // END — silently turning "insert where I was typing" into "append", which is exactly the bug the
  // helper exists to prevent. Restoring it has to happen AFTER the commit and BEFORE paint, or the
  // caret visibly jumps, which is what useLayoutEffect is for. The group composer carries the
  // identical pair; they are not shared because each owns its own draft state and its own textarea.
  const pendingCaretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    const el = composerRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(caret, caret)
  }, [draft])

  // Splice the picked emoji in at the cursor. A refused insert (it would pass MAX_MESSAGE_LEN —
  // see F9, which the textarea's own maxLength cannot enforce for a programmatic write) comes back
  // as the unchanged draft, and is dropped here rather than queuing a pointless caret restore.
  function insertEmoji(char: string) {
    const el = composerRef.current
    const { text, caret } = insertAtCursor(draft, el?.selectionStart, el?.selectionEnd, char, MAX_MESSAGE_LEN)
    if (text === draft) return
    pendingCaretRef.current = caret
    setDraft(text)
  }

  // Truncate address for display: otl_esm_1abc…xyz

  return (
    <>
    {/* FILLS ITS PANE, like WalletPage and NamePage do. AppShell's Pane is a flex row, so chat's
        root has to grow into it — without `flex: 1` it shrink-to-fits the sidebar plus the thread's
        intrinsic width and leaves the rest of the pane blank. `minWidth: 0` travels with it: a flex
        item otherwise refuses to shrink below its content's min-content width, which is what would
        let one long unbroken message push the thread wider than the pane holding it.

        This used to come from the DarkPin wrapper, which was a flex box in its own right. Chat was
        the only service getting its box from a wrapper rather than declaring it, which is why
        removing the pin left a gap here and nowhere else. `100%` rather than `100vh` for the same
        reason: chat is a pane inside AppShell's height now, not a route filling the viewport. */}
    <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', background: 'var(--surface-base)' }}>
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>

        {/* LEFT: sidebar */}
        <div style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--surface-base)', position: 'relative' }}>

          {relayPanelOpen && <RelayHealthPanel getRelayStates={getRelayStates} reconnectAll={reconnectAll} onClose={() => setRelayPanelOpen(false)} />}

          {/* ── Search, and the two list actions ────────────────────────────────────────────
              V3 opens the pane at the search field: no lockup, no profile control, no balance.
              All three left with the wallet — the spine carries the mark and the identity tile,
              and the balance belongs to the Wallet service (the payment composer still prints an
              `available` line where it is actually load-bearing).

              NEW CONVERSATION AND NEW GROUP RIDE THE SEARCH ROW. They are the only two controls
              the emptied header held that have nowhere else to go, and a header strip containing
              nothing but two icons is more chrome than they are worth. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 12px 8px' }}>
            <div style={{
              flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 9,
              padding: '9px 12px', borderRadius: 10, background: 'var(--surface)',
              border: `1px solid ${sidebarQuery ? 'var(--accent-400)' : 'var(--border)'}`,
              boxShadow: sidebarQuery ? '0 0 0 3px rgba(var(--accent-400-rgb),0.18)' : 'none',
            }}>
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx={11} cy={11} r={7} /><path d="M21 21l-4-4" /></svg>
              <input
                type="text"
                value={sidebarQuery}
                onChange={e => setSidebarQuery(e.target.value)}
                placeholder="Search conversations"
                className="cv-composer"
                style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 13, fontFamily: 'inherit', padding: 0 }}
              />
              {sidebarQuery && (
                <span onClick={() => setSidebarQuery('')} title="Clear search" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 17, height: 17, borderRadius: '50%', background: 'var(--surface-inset)', cursor: 'pointer', flexShrink: 0 }}>
                  <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth={3} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </span>
              )}
            </div>
            <button
              onClick={() => { setComposeNpub(''); setComposeRes({ s: 'idle' }); setComposeOpen(true) }}
              title="Start a new conversation"
              aria-label="Start a new conversation"
              className="cv-icon-btn"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, flexShrink: 0, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', padding: 0, color: 'var(--text-muted-dim)' }}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button
              onClick={() => setCreateGroupOpen(true)}
              title="New group"
              aria-label="New group"
              className="cv-icon-btn"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, flexShrink: 0, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', padding: 0, color: 'var(--text-muted-dim)' }}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx={9} cy={7} r={4} /><path d="M19 8v6M22 11h-6" /></svg>
            </button>
            {/* @ — YOUR NAMES. The third list action, and the glyph is the spine's own `name` icon:
                CNS stops being a service beside Wallet and Chat and becomes a thing you open from
                inside chat, so the mark moves with it rather than being redrawn.

                IT SHOWS WHEN IT IS OPEN, unlike its two neighbours. They fire and forget — a modal
                opens and the button behind it is irrelevant — but this one sits under a 520px
                overlay the user can dismiss by clicking the ground, and a control that had no idea
                whether its own panel was up would be the odd one out of three. */}
            <button
              onClick={() => setCnsOpen(true)}
              title="Your @names"
              aria-label="Your @names"
              aria-expanded={cnsOpen}
              className="cv-icon-btn"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34,
                flexShrink: 0, borderRadius: 10, cursor: 'pointer', padding: 0,
                border: `1px solid ${cnsOpen ? 'var(--accent-400)' : 'var(--border)'}`,
                background: cnsOpen ? 'var(--accent-wash)' : 'var(--surface)',
                color: cnsOpen ? 'var(--accent-ink)' : 'var(--text-muted-dim)',
              }}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx={12} cy={12} r={4} /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></svg>
            </button>
          </div>

          {/* Ambient connection strip — click opens the relay-health panel. BELOW the search now,
              where V3 draws it, rather than above it in a header that no longer exists. */}
          {(() => {
            const rs = getRelayStates()
            const total = rs.length
            const connected = rs.filter(s => s.status === 'connected').length
            return (
              <div style={{ padding: '0 12px 6px' }}>
                <ConnectionIndicator status={messagingStatus} connected={connected} total={total} onClick={() => setRelayPanelOpen(v => !v)} />
              </div>
            )
          })()}

          {/* Requests (M9.0c) — pending peers who messaged first. Distinct from conversations; no
              reply is possible until accepted. Payment previews here deliberately do NOT resolve the
              amount: an unaccepted stranger could reference a UTXO, and we must not fire indexer
              fetches on their behalf before I choose to engage (network work + unsolicited contact).
              The note always renders as inert, auto-escaped text (M10.0 guarantee, no HTML/markdown). */}
          {filteredRequests.length > 0 && (
            <div style={{ padding: '2px 8px 0' }}>
              <div style={SECTION_ROW}>
                <span style={SECTION_LABEL}>REQUESTS</span>
                <span style={SECTION_COUNT}>{filteredRequests.length}</span>
              </div>
              {filteredRequests.map(req => {
                const av = avatarFor(req.peerHex)
                const nick = nicknames[req.peerHex]     // resolved-name variant iff I have a nickname
                const pay = req.lastMessage?.payment     // stranger payment — never resolved (privacy)
                const note = req.lastMessage?.plaintext ?? ''
                const busy = busyRequest?.peerHex === req.peerHex ? busyRequest.kind : null
                // One frame for every state — see REQUEST_CARD. The decision in flight shows in the
                // dimmed head and the button that became a spinner, not in the container's colour.
                const frame = REQUEST_CARD
                return (
                  <div key={req.peerHex} style={{ ...frame, marginBottom: 6 }}>
                    {/* Header: avatar + name/npub + relative age. Dimmed while a decision is in flight. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10, opacity: busy ? 0.6 : 1 }}>
                      <div style={{ width: 30, height: 30, borderRadius: 99, background: av.grad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: av.color, flexShrink: 0 }}>{initialsFor(nick)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-name)', fontFamily: nick ? undefined : MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nick || truncNpub(req.peerHex)}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', fontFamily: nick ? MONO : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nick ? truncNpub(req.peerHex) : 'Contact request'}</div>
                      </div>
                      {!busy && req.lastMessage && <span style={{ fontSize: 11, color: 'var(--text-muted-dim)', flexShrink: 0 }}>{ageShort(req.lastMessage.timestamp)}</span>}
                    </div>

                    {pay ? (
                      /* Payment attached — amount stays confidential (••••) for a stranger; no chain query. */
                      <div style={{ borderRadius: 11, overflow: 'hidden', border: '1px dashed rgba(var(--accent-400-rgb),0.3)', background: 'var(--surface-trough)', marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 13px', background: 'rgba(var(--accent-400-rgb),0.06)', borderBottom: '1px dashed rgba(var(--accent-400-rgb),0.22)' }}>
                          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--accent-400)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-300)', letterSpacing: '0.06em' }}>CONFIDENTIAL PAYMENT ATTACHED</span>
                        </div>
                        <div style={{ padding: 13 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginBottom: 9 }}>
                            <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.1em' }}>••••</span>
                            <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: 'var(--text-accent-dim)' }}>XTR</span>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, textAlign: 'center', marginBottom: note ? 11 : 0 }}>Amount stays unresolved until you accept. Caravel doesn’t query the chain for strangers.</div>
                          {note && (
                            <div style={{ padding: '10px 12px', borderRadius: 9, background: 'var(--surface-trough)', border: '1px solid var(--border)' }}>
                              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-accent-dim)', marginBottom: 5 }}>NOTE</div>
                              <div style={{ fontSize: 12, color: 'var(--text-body-dim)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : note ? (
                      /* Text request — a stranger's message renders as inert plain text (React auto-escapes). */
                      <>
                        <div style={{ padding: '11px 13px', borderRadius: 10, background: 'var(--surface-trough)', border: '1px solid var(--border)', fontSize: 13, color: busy ? 'var(--text-muted-dim)' : 'var(--text-body-dim)', lineHeight: 1.5, marginBottom: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note}</div>
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
                    <div style={{ display: 'flex', gap: 8 }}>
                      {busy === 'accept' ? (
                        <div style={{ ...CARD_BTN, background: 'var(--surface-inset)', color: 'var(--accent-ink)' }}>
                          <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid var(--border-strong)', borderTopColor: 'var(--accent-400)', animation: 'cv-spin 0.8s linear infinite' }} />Accepting
                        </div>
                      ) : (
                        <button onClick={() => { setBusyRequest({ peerHex: req.peerHex, kind: 'accept' }); acceptRequest(req.peerHex) }} disabled={!!busy}
                          className={busy ? undefined : 'cv-btn-primary'}
                          style={{ ...CARD_BTN, border: 'none', background: busy ? 'var(--surface-inset)' : 'var(--accent-400)', color: busy ? 'var(--text-disabled)' : 'var(--ink-on-accent)', cursor: busy ? 'default' : 'pointer' }}>
                          Accept
                        </button>
                      )}
                      {busy === 'decline' ? (
                        <div style={{ ...CARD_BTN, border: '1px solid var(--border-strong)', color: 'var(--text-muted-dim)' }}>
                          <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid var(--border-strong)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />Declining
                        </div>
                      ) : (
                        <button onClick={() => { setBusyRequest({ peerHex: req.peerHex, kind: 'decline' }); declineRequest(req.peerHex) }} disabled={!!busy}
                          style={{ ...CARD_BTN, border: `1px solid ${busy ? 'var(--border)' : 'var(--border-strong)'}`, background: 'transparent', color: busy ? 'var(--text-disabled)' : 'var(--text-body-dim)', cursor: busy ? 'default' : 'pointer' }}>
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
          <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 10px' }}>
            {/* Group invites (A-M2) — pending groups render as accept/decline cards, NOT open-thread
                rows. Mirrors the DM REQUESTS card (same frame/tokens/spinner), adapted to a group:
                Avatar glyph, group name, member/roster subtitle. Placed above active group rows so
                all group affordances stay co-located. Search-filtered on the same title as rows. */}
            {(() => {
              const invites = pendingInvites.filter(g => {
                const t = (g.name || `group ${g.id.slice(0, 6)}`).toLowerCase()
                return !sq || t.includes(sq)
              })
              if (invites.length === 0) return null
              return (
                <div style={{ padding: '0 0 4px' }}>
                  <div style={SECTION_ROW}>
                    <span style={SECTION_LABEL}>GROUP INVITES</span>
                    <span style={SECTION_COUNT}>{invites.length}</span>
                  </div>
                  {invites.map(g => {
                    const title = g.name.trim() || `Group ${g.id.slice(0, 6)}…`
                    const sub = g.members.length ? `${g.members.length} members` : 'roster pending…'
                    const busy = busyInvite?.groupId === g.id ? busyInvite.kind : null
                    // Identical treatment to the DM request card — see REQUEST_CARD.
                    const frame = REQUEST_CARD
                    return (
                      <div key={g.id} style={{ ...frame, marginBottom: 6 }}>
                        {/* Header: glyph avatar + name/subtitle. Dimmed while a decision is in flight. */}
                        <div style={{ display: 'flex', gap: 9, marginBottom: 10, alignItems: 'center', opacity: busy ? 0.6 : 1 }}>
                          <Avatar icon={groupGlyph} size={30} radius={9} bg="var(--accent-wash)" fg="var(--accent-ink)" />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-name)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)' }}>{sub}</div>
                          </div>
                        </div>
                        {/* Accept / Decline — same markup/tokens/spinner as the DM request card. */}
                        <div style={{ display: 'flex', gap: 8 }}>
                          {busy === 'accept' ? (
                            <div style={{ ...CARD_BTN, background: 'var(--surface-inset)', color: 'var(--accent-ink)' }}>
                              <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid var(--border-strong)', borderTopColor: 'var(--accent-400)', animation: 'cv-spin 0.8s linear infinite' }} />Accepting
                            </div>
                          ) : (
                            <button onClick={() => { setBusyInvite({ groupId: g.id, kind: 'accept' }); acceptInvite(g.id) }} disabled={!!busy}
                              className={busy ? undefined : 'cv-btn-primary'}
                              style={{ ...CARD_BTN, border: 'none', background: busy ? 'var(--surface-inset)' : 'var(--accent-400)', color: busy ? 'var(--text-disabled)' : 'var(--ink-on-accent)', cursor: busy ? 'default' : 'pointer' }}>
                              Accept
                            </button>
                          )}
                          {busy === 'decline' ? (
                            <div style={{ ...CARD_BTN, border: '1px solid var(--border-strong)', color: 'var(--text-muted-dim)' }}>
                              <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid var(--border-strong)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />Declining
                            </div>
                          ) : (
                            <button onClick={() => { setBusyInvite({ groupId: g.id, kind: 'decline' }); declineInvite(g.id) }} disabled={!!busy}
                              style={{ ...CARD_BTN, border: `1px solid ${busy ? 'var(--border)' : 'var(--border-strong)'}`, background: 'transparent', color: busy ? 'var(--text-disabled)' : 'var(--text-body-dim)', cursor: busy ? 'default' : 'pointer' }}>
                              Decline
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  <div style={{ height: 1, background: 'var(--border)', margin: '8px 6px 4px' }} />
                </div>
              )
            })()}
            {/* Groups (Phase 1) — active groups rendered above the DMs; each opens its own thread. */}
            {(() => {
              const rows = activeGroupRows.filter(gr => {
                const t = (gr.group.name || `group ${gr.group.id.slice(0, 6)}`).toLowerCase()
                return !sq || t.includes(sq)
              })
              if (rows.length === 0) return null
              return (
                <>
                  <div style={SECTION_ROW}>
                    <span style={SECTION_LABEL}>GROUPS</span>
                  </div>
                  {rows.map(gr => {
                    const g = gr.group
                    const title = g.name.trim() || `Group ${g.id.slice(0, 6)}…`
                    const active = selectedGroupId === g.id
                    const lm = gr.lastMessage
                    const preview = !lm
                      ? (g.members.length ? `${g.members.length} members` : 'New group')
                      : lm.direction === 'sent' ? `You: ${lm.plaintext}` : `${displayName(lm.senderPubkeyHex)}: ${lm.plaintext}`
                    return (
                      <div key={g.id} onClick={() => selectGroup(g.id)} className="cv-conv" style={{ ...CONV_ROW, background: active ? 'var(--accent-wash)' : 'transparent' }}>
                        {/* The group tile is QUIET, not accent — V3 reserves the accent fill for a
                            person's avatar, so a group reads as a container rather than a contact. */}
                        <Avatar icon={groupGlyph} size={36} radius={11} bg="var(--msg-received)" fg="var(--text-body-dim)" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                            <span style={{ ...CONV_NAME, color: active ? 'var(--accent-ink)' : 'var(--text-name)' }}>{title}</span>
                            <span style={CONV_TIME}>{compactTime(gr.lastActivity)}</span>
                          </div>
                          <div style={{ ...CONV_PREVIEW, color: active ? 'var(--text-body-dim)' : 'var(--text-muted-dim)' }}>{preview}</div>
                        </div>
                      </div>
                    )
                  })}
                  <div style={{ height: 1, background: 'var(--border)', margin: '8px 6px 4px' }} />
                </>
              )
            })()}
            {conversations.length === 0 && activeGroupRows.length > 0 ? null : conversations.length === 0 ? (
              /* Zero conversations (design empty state) */
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', height: '100%', padding: 24, gap: 16 }}>
                <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="var(--accent-400)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>No conversations yet</div>
                  <div style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.55, maxWidth: 240 }}>Start one with an @name, or share yours so people can find you.</div>
                </div>
                <button onClick={() => { setComposeNpub(''); setComposeRes({ s: 'idle' }); setComposeOpen(true) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 18px', borderRadius: 10, background: 'var(--accent-400)', color: 'var(--ink-on-accent)', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', fontFamily: 'inherit' }} className="cv-btn-primary">
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
                <div style={SECTION_ROW}>
                  <span style={{ ...SECTION_LABEL, flex: 1 }}>DIRECT</span>
                  {sq && <span style={SECTION_COUNT}>{filteredConversations.length} of {conversations.length}</span>}
                </div>
                {filteredConversations.map((c) => {
                  const active = !selectedGroupId && selectedConvo?.peerHex === c.peerHex
                  const nick = nicknames[c.peerHex]
                  const lm = c.lastMessage
                  const isPay = !!lm?.payment
                  const preview = !lm ? '' : isPay ? 'Payment sent' : lm.direction === 'sent' ? `You: ${lm.plaintext}` : lm.plaintext
                  return (
                    <div key={c.peerHex} onClick={() => { setSelectedPeer(c.peerHex); setSelectedGroupId(null) }} className="cv-conv" style={{ ...CONV_ROW, background: active ? 'var(--accent-wash)' : 'transparent' }}>
                      {/* A person's avatar is a CIRCLE and a group's is a rounded tile — the shape
                          carries the distinction in V3, which is why the row needs no other badge. */}
                      <Avatar hex={c.peerHex} nickname={nick} size={36} radius={99} fontSize={13} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ ...CONV_NAME, color: active ? 'var(--accent-ink)' : 'var(--text-name)', fontFamily: nick ? undefined : MONO }}>{displayName(c.peerHex)}</span>
                          <span style={CONV_TIME}>{compactTime(c.lastActivity)}</span>
                        </div>
                        {isPay ? (
                          <div style={{ ...CONV_PREVIEW, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--accent-ink)' }}>
                            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flexShrink: 0 }}><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                            <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</span>
                          </div>
                        ) : (
                          <div style={{ ...CONV_PREVIEW, color: active ? 'var(--text-body-dim)' : 'var(--text-muted-dim)' }}>{preview}</div>
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--surface)', position: 'relative' }}>

          {selectedGroupId && selectedGroup && selectedGroup.state === 'active' ? (
            <GroupThread
              group={selectedGroup}
              messages={groupMessages}
              pending={pendingGroupSends.filter(p => p.groupId === selectedGroup.id)}
              sendNote={groupSendNote?.groupId === selectedGroup.id ? { kind: groupSendNote.kind, reached: groupSendNote.reached, total: groupSendNote.total } : null}
              nameFor={displayName}
              onSend={handleGroupSend}
              onRetryPending={retryGroupSend}
              /* Reactions (C): the publish path is ChatApp's, like every other send, but the
                 in-flight state is GroupThread's own — a reaction round trip is short and, unlike an
                 edit flight, has nothing to survive a thread switch for. */
              mePubkeyHex={nostrPubkeyHex ?? ''}
              onReact={async (logicalId, emoji, action) => { await reactMessage(logicalId, emoji, action) }}
              /* Editing (M4): the flight map is owned HERE, shared with the DM thread, so a group
                 edit's in-flight state survives switching threads. GroupThread owns only which of
                 ITS bubbles is loaded into ITS own composer. */
              editFlights={editFlights}
              onSaveEdit={runEdit}
              onRetryEdit={retryEdit}
              onDismissEdit={(logicalId) => setEditFlights(x => clearFlight(x, logicalId))}
              onDismissPending={dismissPending}
              /* Leave (B-M1) replaces Delete as the thread's exit action: 'left' is the stronger
                 suppression (delete's "forget until re-invited" resurrects the group as a pending
                 invite on the next message) and it keeps the roster the B-M2 notice fans out to. */
              onLeave={() => handleLeaveGroup(selectedGroup)}
              /* Re-invite (C-M2): open the picker. Sending is the modal's confirm, not this click. */
              onReinvite={() => setReinviteFor(selectedGroup.id)}
              /* GroupThread owns its own composer + preview; ChatApp owns the provider, so the
                 confirmed file comes back up here to be sent. */
              onSendImage={(file, caption) => sendImage(file, caption, { groupId: selectedGroup.id, members: selectedGroup.members })}
              imageStageLabel={imageStage}
            />
          ) : selectedConvo === null ? (
            /* Chat pane at rest (design: sail + reassurance) */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, background: 'radial-gradient(700px 420px at 50% 40%, rgba(var(--accent-400-rgb),0.045), rgba(var(--accent-400-rgb),0))' }}>
              <Logo size={64} onLight={onLight} style={{ opacity: 0.34 }} />
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
          <div style={THREAD_HEADER}>
            <div style={HEADER_LEFT}>
              <Avatar hex={selectedConvo.peerHex} nickname={nicknames[selectedConvo.peerHex]} size={34} radius={99} fontSize={13} />
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
                    style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)', background: 'var(--surface-raised)', border: '1px solid var(--accent-400)', boxShadow: '0 0 0 3px rgba(var(--accent-400-rgb),0.18)', borderRadius: 8, padding: '5px 9px', outline: 'none', width: 220 }}
                  />
                ) : (
                  <div onClick={beginEditNick} title="Click to set a nickname" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <span style={{ ...THREAD_TITLE, fontFamily: nicknames[selectedConvo.peerHex] ? undefined : MONO }}>{displayName(selectedConvo.peerHex)}</span>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                    {nicknames[selectedConvo.peerHex] && <span style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--text-muted-dim)', flexShrink: 0 }}>{truncNpub(selectedConvo.peerHex)}</span>}
                  </div>
                )}
                <E2ELine />
              </div>
            </div>
            {/* ⋯ menu (design drops the call/video icon) */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <ThreadMenuButton open={menuOpen} title="Conversation options" onClick={() => setMenuOpen(o => !o)} />
              {menuOpen && (
                <>
                  <div onClick={() => setMenuOpen(false)} style={MENU_SCRIM} />
                  <div style={MENU_PANEL}>
                    <button
                      onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}
                      style={{ ...MENU_ITEM, color: 'var(--danger-300)', cursor: 'pointer' }}
                    >
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
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
            // data-popover-bounds below: the box a reaction popover must stay inside. This element
            // is the scroll container, and `overflow-y: auto` resolves overflow-x to `auto` too — so
            // a panel that spills past its LEFT edge is not merely off-screen, it is unreachable, a
            // scroll container's scrollable region never extending leftward. See popoverFit.ts.
            return (
          <div ref={threadRef} data-popover-bounds style={THREAD_SCROLLER}>

            {/* Notes-to-self banner (self thread) */}
            {isSelf && (
              <div style={THREAD_META_LINE}>
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></svg>
                Notes to self. Only you can read this thread.
              </div>
            )}

            {/* Address provenance. ASYMMETRIC ON PURPOSE: "we got this address from them" is an
                "of course" and reads as a meta line; "you typed this in and nobody checked it" is
                the one fact here you might need to act on, so it keeps a full banner. Quieting
                the reassurance is what makes the warning mean something when it appears. */}
            {!isSelf && peerAddrRec && (
              addressVerified ? (
                <div style={THREAD_META_LINE}>
                  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>
                  Payment address shared by {displayName(selectedConvo.peerHex)} in this conversation
                </div>
              ) : (
                <div style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px', borderRadius: 10, background: 'var(--card-warn)', border: '1px solid var(--card-warn-border)', maxWidth: 520 }}>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                  <span style={{ fontSize: 12, color: 'var(--warn)', lineHeight: 1.45 }}>Address entered manually. Not verified against this contact’s identity.</span>
                </div>
              )
            )}

            {/* Empty accepted thread (first-message state). The design's tile + title + body,
                and OUR second sentence: the composer's $ is an unlabelled glyph, and since the
                balance pill left chat in stage 2 this is the only place the product says a
                payment can start inside a conversation. */}
            {isEmpty && !isSelf && (
              <ThreadEmptyState
                title="Your conversation is private"
                body={<>Messages with {displayName(selectedConvo.peerHex)} are end-to-end encrypted — only the two of you can read them. Say hello, or send a confidential payment with a note.</>}
              />
            )}

            {/* Real messages and provisional bubbles in ONE chronological pass. Pending rows used to
                render in a separate map after this one, which pinned a failed send to the bottom of
                the thread forever — see mergeThreadItems. */}
            {mergeThreadItems(selectedConvo.messages, pendingForPeer).map((item, i, items) => {
              // DAY DIVIDERS. Inserted at render time by comparing neighbours — nothing is written into
              // the merged list, so mergeThreadItems and the ThreadItem union are untouched. The
              // Fragment carries the key; the inner element's own key is then unused and harmless.
              const dayLbl = i === 0 || isNewDay(items[i - 1].at, item.at) ? dayLabel(item.at) : null
              const rowKey = item.kind === 'pending' ? `p-${item.pending.id}` : `m-${item.message.id}`
              const row = (() => {
                if (item.kind === 'pending') {
                  const p = item.pending
                  return (
                    <PendingBubble
                      key={p.id}
                      text={p.text}
                      status={p.status}
                      failure={p.failure}
                      onRetry={() => retrySend(p.id)}
                      onDismiss={() => dismissPending(p.id)}
                    />
                  )
                }
                const m = item.message
                if (m.payment) return <PaymentMessageCard key={m.id} message={m} lid={m.logicalId} flashed={!!m.logicalId && flashedId === m.logicalId} />
                /* Encrypted image (images M4): resolves itself — cache first, then the host. */
                if (m.media) return <MediaMessageCard key={m.id} message={m} lid={m.logicalId} flashed={!!m.logicalId && flashedId === m.logicalId} />
                const flight = flightFor(m, editFlights)
                const editable = canEditMessage(m)
                // NO REACT AFFORDANCE IN A NOTES-TO-SELF THREAD. reactMessage refuses it — the wire
                // destination would be my own key, and it will not publish a reaction to myself and
                // then apply it locally as if it had gone somewhere. Offering a button that always
                // fails would be worse than not offering one.
                const reactable = !isSelf && canReactTo(m)
                // The action row sits OUTBOARD of its bubble, so it is on the left of a sent bubble and
                // the right of a received one. Popovers open inboard, i.e. the opposite way (F17).
                const outboardLeft = isSelf || m.direction === 'sent'
                const summaries = aggregateReactions(m, nostrPubkeyHex ?? '')
                const pendingEmoji = reactPending && reactPending.logicalId === m.logicalId ? reactPending.emoji : null
                return (
                  <Fragment key={m.id}>
                    <MessageBubble
                      text={displayTextFor(m, editFlights)}
                      timestamp={m.timestamp}
                      variant={isSelf ? 'self' : m.direction === 'received' ? 'received' : 'sent'}
                      edited={!!m.editedAt}
                      highlighted={!!m.logicalId && editing?.logicalId === m.logicalId}
                      lid={m.logicalId}
                      flashed={!!m.logicalId && flashedId === m.logicalId}
                      // 'self' is the notes-to-self bubble — dark inset, NOT teal — so only a true 'sent'
                      // bubble takes the inverted palette.
                      quoted={m.replyTo ? <QuotedPreview replyTo={m.replyTo} byLogicalId={quotedIndex} onJump={jumpTo} tone={!isSelf && m.direction === 'sent' ? 'on-accent' : 'on-dark'} /> : undefined}
                      // No labelFor in a DM: the answer is one of two people, and a tooltip listing
                      // npubs would be noise rather than information.
                      reactions={summaries.length > 0 ? (
                        <ReactionPills
                          summaries={summaries}
                          pending={pendingEmoji}
                          onToggle={(emoji, action) => void toggleReaction(m.logicalId!, emoji, action)}
                        />
                      ) : undefined}
                      actions={(editable || canReplyTo(m) || reactable) ? (
                        <MessageActionRow
                          menuAlign={outboardLeft ? 'left' : 'right'}
                          onReact={reactable ? () => setReactOpen(o => (o === m.logicalId ? null : m.logicalId!)) : undefined}
                          reactOpen={reactOpen === m.logicalId}
                          reactPopover={reactOpen === m.logicalId ? (
                            <ReactionQuickSet
                              align={outboardLeft ? 'left' : 'right'}
                              mine={myReactions(m, nostrPubkeyHex ?? '')}
                              blocked={atReactionLimit(m, nostrPubkeyHex ?? '')}
                              pending={pendingEmoji}
                              onPick={emoji => void toggleReaction(m.logicalId!, emoji, myReactions(m, nostrPubkeyHex ?? '').includes(emoji) ? 'remove' : 'add')}
                              onClose={() => setReactOpen(null)}
                            />
                          ) : undefined}
                          onReply={canReplyTo(m) ? () => beginReply(m.logicalId!) : undefined}
                          onEdit={editable ? () => beginEdit(m.logicalId!, m.plaintext) : undefined}
                        />
                      ) : undefined}
                    />
                    {/* In-flight + failed states for an edit. "Saving" says only that it left this
                        device; nothing here implies the recipient received it. */}
                    {flight?.status === 'saving' && (
                      <div style={{ alignSelf: 'flex-end', display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: -2, marginRight: 4 }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.2)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />Saving edit
                      </div>
                    )}
                    {flight?.status === 'failed' && (
                      <div style={{ alignSelf: 'flex-end', display: 'flex', alignItems: 'center', gap: 10, marginTop: -2, marginRight: 4 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--danger-300)' }}>
                          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.4} strokeLinecap="round"><circle cx={12} cy={12} r={9} /><path d="M12 8v5M12 16h.01" /></svg>Couldn’t save edit
                        </span>
                        <span onClick={() => retryEdit(m.logicalId!)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', fontSize: 11, fontWeight: 700, color: 'var(--danger-300)', cursor: 'pointer' }}>Retry</span>
                        <span onClick={() => setEditFlights(x => clearFlight(x, m.logicalId!))} style={{ fontSize: 11, color: 'var(--text-muted-dim)', cursor: 'pointer' }}>Dismiss</span>
                      </div>
                    )}
                  </Fragment>
                )
              })()
              return (
                <Fragment key={rowKey}>
                  {dayLbl && <DayDivider label={dayLbl} />}
                  {row}
                </Fragment>
              )
            })}
            {/* Auto-scroll anchor */}
            <div ref={bottomRef} />
          </div>
            ) })()}

          {/* Composer */}
          {(() => {
            const paymentValid = validatePayment() === null
            // Edit mode is the fourth exclusive composer state: Save replaces Send, and is live only
            // when the text is both non-empty and actually different (an unchanged save would burn a
            // revision for nothing).
            const editSubmittable = !!editing && isEditSubmittable(editing.original, draft)
            const canSend = payBusy || confirming
              ? false
              : editing ? editSubmittable
              : paymentMode ? paymentValid : (!!draft.trim() && !sending)
            const showCounter = draft.length >= MAX_MESSAGE_LEN - 200
            const inputsDisabled = sending || payBusy || confirming
            return (
            <div style={COMPOSER_SHELL}>

              {/* §8B·5 — PERSISTENT must-acknowledge alert (orphan / timeout), above the restored
                  composer. Logic unchanged.
                  THE DESIGN'S BANNER IS TRIMMED BACK TO TWO SENTENCES; the txId, its Copy and the
                  dismiss are kept anyway. This alert is the only place the product can hand over a
                  transaction id, "Check Activity before trying again" is unactionable without one,
                  and setPayAlert(null) is the single thing that clears it — a banner with no
                  acknowledge would either never leave or leave on its own, and both are wrong here.
                  This is the one screen where dropping information is the dangerous choice. */}
              {payAlert && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, padding: '11px 13px', borderRadius: 12, background: 'var(--card-warn)', border: '1px solid var(--warn)' }}>
                  <div style={{ display: 'flex', gap: 9 }}>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                    <div style={{ fontSize: 11.5, lineHeight: 1.5, textWrap: 'pretty' }}>
                      {payAlert.kind === 'orphan'
                        ? <><span style={{ fontWeight: 600, color: 'var(--warn)' }}>The funds left your wallet, but no note was attached.</span> <span style={{ color: 'var(--text-body-dim)' }}>{displayName(selectedConvo.peerHex)} received {payAlert.amountTari} XTR without your message, so tell them separately.</span></>
                        : <><span style={{ fontWeight: 600, color: 'var(--warn)' }}>The send timed out. Do not resend.</span> <span style={{ color: 'var(--text-body-dim)' }}>{payAlert.amountTari} XTR may still have gone through. Check Activity before trying again.</span></>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 12px', borderRadius: 9, background: 'var(--surface-trough)' }}>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{payAlert.txId.slice(0, 8)}…{payAlert.txId.slice(-4)}</span>
                    <span onClick={() => navigator.clipboard.writeText(payAlert.txId).catch(() => {})} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--warn-300)', cursor: 'pointer', flexShrink: 0 }}>
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--warn-300)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x={9} y={9} width={13} height={13} rx={2} /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>Copy
                    </span>
                  </div>
                  <button onClick={() => setPayAlert(null)} style={{ alignSelf: 'flex-start', marginTop: 2, padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(var(--warn-rgb),0.5)', background: 'transparent', color: 'var(--warn-300)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                    I have noted this
                  </button>
                </div>
              )}

              {/* §8B·4 — the error, ABOVE the still-editable form rather than replacing it. The
                  design draws a "Try again" that restores the panel; submitPayment already keeps
                  payment mode and every field on a failure, so the form the link would bring back
                  is the one directly underneath. The second sentence is conditional — see
                  payErrorSafe: on the throw path we cannot claim the money stayed put. */}
              {payError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '11px 13px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--danger-500)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 8, flexShrink: 0, background: 'rgba(var(--danger-rgb),0.12)', color: 'var(--danger-500)' }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx={12} cy={12} r={9} /><path d="M15 9l-6 6M9 9l6 6" /></svg>
                  </span>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.5, textWrap: 'pretty', wordBreak: 'break-word' }}>
                    <span style={{ fontWeight: 600, color: 'var(--danger-300)' }}>{payError}</span>
                    {payErrorSafe && <span style={{ color: 'var(--text-body-dim)' }}> Nothing left your wallet.</span>}
                  </div>
                </div>
              )}

              {/* §8B·3 — sending. The design writes a fixed "Sending payment to @haci…"; payProgress
                  is kept instead because it names the PHASE, and one of those phases is "Payment
                  confirmed — sending the message…", i.e. the money has already moved and only the
                  note is outstanding. That line is the only warning before an orphan alert. */}
              {payBusy && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '11px 13px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border-strong)' }}>
                  <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--accent-400)', animation: 'cv-spin 1s linear infinite', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-body-dim)' }}>{payProgress ?? 'Working…'}</span>
                  {payAmount.trim() && <span style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--text-muted-dim)', flexShrink: 0 }}>{payAmount} XTR</span>}
                </div>
              )}

              {/* §8B·1 — THE INLINE PANEL. Not a modal and not a screen: it opens in the composer's
                  own slot, over the composer, and the upward shadow is what says so. */}
              {paymentMode && !confirming && !payBusy && (
                <div style={{ ...PAY_PANEL, border: `1px solid ${payInsufficient ? 'var(--danger-500)' : 'var(--border-strong)'}` }}>
                  <PayPanelHeader onClose={toggleTari} />

                  {/* Amount, and who it is going to. The design pairs the field with a recipient
                      CHIP rather than an address box — which it can, because it assumes an
                      identity-bound address. See the address row below for when we have none. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div style={{
                      flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 7,
                      padding: '10px 12px', borderRadius: 10,
                      border: `1px solid ${payInsufficient ? 'var(--danger-500)' : 'var(--accent-400)'}`,
                      boxShadow: payInsufficient ? '0 0 0 3px rgba(var(--danger-rgb),0.14)' : '0 0 0 3px rgba(var(--accent-400-rgb),0.14)',
                    }}>
                      <input
                        value={payAmount}
                        onChange={e => { setPayAmount(e.target.value); if (payError) setPayError(null) }}
                        placeholder="0.000000"
                        inputMode="decimal"
                        aria-label="Amount in XTR"
                        style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 15, fontWeight: 600, color: 'var(--text-body)' }}
                      />
                      <span style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--text-muted-dim)', flexShrink: 0 }}>XTR</span>
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-body-dim)', flexShrink: 0 }}>
                      to
                      <Avatar hex={selectedConvo.peerHex} nickname={nicknames[selectedConvo.peerHex]} size={20} radius={99} fontSize={9.5} />
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{displayName(selectedConvo.peerHex)}</span>
                    </span>
                  </div>

                  {/* THE ADDRESS ROW HAS NO EQUIVALENT IN §8B·1, and it has to exist. The design's
                      chip assumes an exchanged, identity-bound address; M10.1 also allows typing one
                      in for a peer who has never shared theirs, and dropping the field would make
                      those payments impossible rather than merely unstyled. The thread keeps its own
                      "entered manually, not verified" banner — this is only the entry. */}
                  {!addressVerified && (
                    <input
                      value={payAddress}
                      onChange={e => { setPayAddress(e.target.value); if (payError) setPayError(null) }}
                      placeholder="otl_esm_…"
                      spellCheck={false}
                      aria-label="Recipient address"
                      style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, background: 'transparent', border: '1px solid var(--border)', fontFamily: MONO, fontSize: 12.5, color: 'var(--text-body-dim)', outline: 'none' }}
                    />
                  )}

                  {/* The spendable figure. Private only — see the derivation above. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: -4 }}>
                    <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0 }}><rect x={5} y={11} width={14} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                    Private available: <span style={{ fontFamily: MONO, color: 'var(--text-body-dim)' }}>{availableText}</span>
                  </div>
                  {availableLowerBound && !balanceHidden && (
                    <div style={{ fontSize: 11, color: 'var(--warn)', lineHeight: 1.5, marginTop: -6, textWrap: 'pretty' }}>{incompleteAvailableNote()}</div>
                  )}
                  {payInsufficient && (
                    <div style={{ fontSize: 11.5, color: 'var(--danger-300)', marginTop: -6 }}>Exceeds your balance</div>
                  )}

                  <textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    placeholder={`Private note, only you and ${displayName(selectedConvo.peerHex)} can read it`}
                    rows={1}
                    maxLength={MAX_MESSAGE_LEN}
                    style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, background: 'transparent', border: '1px solid var(--border)', fontSize: 12.5, color: 'var(--text-body)', outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
                  />

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={toggleTari} style={{ ...PAY_BTN, flex: 1, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-body-dim)' }}>Cancel</button>
                    {(() => { const ok = validatePayment() === null; return (
                      <button onClick={onComposerSend} disabled={!ok} className={ok ? 'cv-btn-primary' : undefined} style={{ ...PAY_BTN, flex: 1, border: ok ? 'none' : '1px solid var(--border)', background: ok ? 'var(--accent-400)' : 'var(--surface-inset)', color: ok ? 'var(--ink-on-accent)' : 'var(--text-disabled)', cursor: ok ? 'pointer' : 'default' }}>Review payment</button>
                    ) })()}
                  </div>
                </div>
              )}

              {/* §8B·2 — the confirm gate, in the SAME panel. The old "Confirm payment to X" title
                  is gone: the design carries the recipient as a To row instead, and the note joins
                  the summary rather than sitting in a box of its own. */}
              {confirming && (
                <div style={{ ...PAY_PANEL, border: '1px solid var(--border-strong)' }}>
                  <PayPanelHeader onClose={toggleTari} />

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '11px 13px', borderRadius: 11, background: 'var(--surface-base)', border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
                      <span style={{ color: 'var(--text-muted-dim)' }}>Amount</span>
                      <span style={{ fontFamily: MONO, fontWeight: 600, color: 'var(--text-primary)' }}>{payAmount} XTR</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, minWidth: 0 }}>
                      <span style={{ color: 'var(--text-muted-dim)', flexShrink: 0 }}>To</span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(selectedConvo.peerHex)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, minWidth: 0 }}>
                      <span style={{ color: 'var(--text-muted-dim)', flexShrink: 0 }}>Note</span>
                      <span style={{ color: 'var(--text-body-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{draft.trim() || '💸 Payment'}</span>
                    </div>
                    {/* A CEILING, said as one. The exact fee is not known until the transaction
                        settles — the send has no prepare/submit split to price it — so the caption
                        is doing real work rather than softening a number. */}
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
                      <span style={{ color: 'var(--text-muted-dim)' }}>Fee, at most</span>
                      <span style={{ fontFamily: MONO, fontWeight: 600, color: 'var(--text-primary)' }}>{FEE_CEIL_XTR} XTR</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted-dim)', marginTop: -3, textAlign: 'right' }}>The exact fee is known once it settles</div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, padding: '9px 11px', borderRadius: 9, background: 'var(--card-warn)', color: 'var(--warn)', fontSize: 11.5, lineHeight: 1.5, textWrap: 'pretty' }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 2 }}><circle cx={12} cy={12} r={9} /><path d="M12 8v4M12 16h.01" /></svg>
                    <span>Confidential payments cannot be cancelled once sent.</span>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setConfirming(false)} style={{ ...PAY_BTN, flex: 1, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-body-dim)' }}>Cancel</button>
                    <button onClick={submitPayment} className="cv-btn-primary" style={{ ...PAY_BTN, flex: 1, border: 'none', background: 'var(--accent-400)', color: 'var(--ink-on-accent)', cursor: 'pointer' }}>Send payment</button>
                  </div>
                </div>
              )}


              {/* Picked image, awaiting Send (images M5) — same slot the payment card uses. */}
              {attachment && !paymentMode && !confirming && (
                <AttachPreview
                  file={attachment}
                  busy={imageBusy}
                  stageLabel={imageStage}
                  onSend={() => {
                    const file = attachment
                    const caption = draft.trim()
                    void sendImageToSelectedPeer(file, caption || undefined).then(() => {
                      setAttachment(null)
                      setDraft('')
                    })
                  }}
                  onCancel={() => setAttachment(null)}
                />
              )}

              {/* THE COMPOSER CARD. V3 puts the reply chip and the editing banner INSIDE this
                  border, above the input row, rather than floating them above it as their own
                  bordered blocks — the composer being in a state, rather than a notice near it.
                  The card itself turns accent while editing, so the mode is legible from the
                  control you are typing into. */}
              {!paymentMode && !confirming && (
                <div style={{
                  ...COMPOSER_CARD,
                  ...(editing ? { border: '1px solid var(--accent-400)', boxShadow: '0 0 0 3px rgba(var(--accent-400-rgb),0.14)' } : null),
                }}>
                  {replying && (
                    <ComposerChip
                      lead={REPLY_RULE}
                      label={`Replying to ${replyChipLabel}`}
                      detail={replyChipDetail(replyTarget)}
                      onCancel={cancelReply}
                    />
                  )}
                  {editing && (
                    <ComposerChip
                      lead={<svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>}
                      label="Editing message"
                      onCancel={cancelEdit}
                    />
                  )}
                  <div style={COMPOSER_ROW}>
                    {/* $ — ONE NOTCH ABOVE its neighbours; see COMPOSER_BTN for why it is not flat
                        with them the way the design draws it. Disabled while editing, and now it
                        LOOKS disabled: it used to keep the full accent fill and an 18px glow. */}
                    <button
                      onClick={toggleTari}
                      disabled={payBusy || !!editing}
                      title={editing ? 'Finish editing first' : 'Attach a payment'}
                      aria-label={editing ? 'Finish editing first' : 'Attach a payment'}
                      style={{
                        ...COMPOSER_ICON_BTN,
                        ...(payBusy || editing
                          ? { background: 'var(--surface-inset)', border: '1px solid var(--border)', color: 'var(--text-disabled)', cursor: 'default' }
                          : { background: 'var(--accent-wash)', border: '1px solid var(--accent-400)', color: 'var(--accent-ink)' }),
                      }}
                    >
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                    </button>
                    {/* accept="image/*" and NEVER image/heic: iOS converts a picked HEIC to JPEG for
                        us, but Safari 17+ inverts that if heic is listed explicitly — it then converts
                        JPEGs TO heic, which no desktop browser can decode. */}
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const picked = e.target.files?.[0]
                        if (picked) setAttachment(picked)
                        // Reset so picking the SAME file again still fires a change event.
                        e.target.value = ''
                      }}
                    />
                    {/* A PICTURE, NOT THE DESIGN'S PAPERCLIP. §5 draws a generic attachment clip;
                        this picker only accepts images and the button says so, and a clip would
                        promise file types it will refuse. */}
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      disabled={imageBusy}
                      title="Attach an image"
                      aria-label="Attach an image"
                      className="cv-composer-btn"
                      style={{ ...COMPOSER_ICON_BTN, opacity: imageBusy ? 0.5 : 1, cursor: imageBusy ? 'default' : 'pointer' }}
                    >
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={3} width={18} height={18} rx={2} /><circle cx={8.5} cy={8.5} r={1.5} /><path d="M21 15l-5-5L5 21" /></svg>
                    </button>
                    {/* `position: relative` is load-bearing — it is the picker's offsetParent. The
                        offset now comes from COMPOSER_POPOVER_OFFSET so it tracks the button's
                        size; the literal it replaced was tied to the old 46px button.

                        LEFT ENABLED WHILE EDITING: putting an emoji into a correction is exactly as
                        reasonable as putting one into a new message, unlike the payment toggle
                        beside it, which an edit has no use for. */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        onClick={() => setEmojiOpen(o => !o)}
                        disabled={inputsDisabled}
                        title="Insert emoji"
                        aria-label="Insert emoji"
                        aria-expanded={emojiOpen}
                        className="cv-composer-btn"
                        style={{ ...COMPOSER_ICON_BTN, background: emojiOpen ? 'var(--surface-inset)' : 'transparent', opacity: inputsDisabled ? 0.5 : 1, cursor: inputsDisabled ? 'default' : 'pointer' }}
                      >
                        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round"><circle cx={12} cy={12} r={9} /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><path d="M9 9h.01M15 9h.01" /></svg>
                      </button>
                      {emojiOpen && (
                        // Stays OPEN after a pick, and insertEmoji hands focus back to the textarea —
                        // so several emoji can go in without reopening, and Enter still sends.
                        <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} offset={COMPOSER_POPOVER_OFFSET} />
                      )}
                    </div>
                    <textarea
                      ref={composerRef}
                      className="cv-composer"
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Escape' && editing) { e.preventDefault(); cancelEdit(); return }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          if (editing) void saveEdit(); else onComposerSend()
                        }
                      }}
                      placeholder={editing ? 'Edit your message…' : attachment ? 'Add a caption…' : 'Write an encrypted message…'}
                      rows={1}
                      maxLength={MAX_MESSAGE_LEN}
                      disabled={inputsDisabled}
                      style={{ flex: 1, minWidth: 0, resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 14, fontFamily: 'inherit', lineHeight: 1.45, maxHeight: COMPOSER_MAX_H, overflowY: 'auto', padding: '6px 4px', display: 'block' }}
                    />
                    <button
                      onClick={() => (editing ? void saveEdit() : onComposerSend())}
                      disabled={!canSend}
                      title={editing ? 'Save edit' : 'Send message'}
                      aria-label={editing ? 'Save edit' : 'Send message'}
                      className={canSend ? 'cv-btn-primary' : undefined}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: COMPOSER_SEND, height: COMPOSER_SEND, flexShrink: 0, padding: 0,
                        borderRadius: 10, border: 'none',
                        background: canSend ? 'var(--accent-400)' : 'var(--surface-inset)',
                        color: canSend ? 'var(--ink-on-accent)' : 'var(--text-disabled)',
                        cursor: canSend ? 'pointer' : 'default',
                      }}
                    >
                      {sending ? (
                        <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid var(--border-strong)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />
                      ) : editing ? (
                        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
                      ) : (
                        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></svg>
                      )}
                    </button>
                  </div>
                </div>
              )}
              {!paymentMode && !confirming && showCounter && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: draft.length >= MAX_MESSAGE_LEN ? 'var(--danger-500)' : 'var(--text-muted-dim)' }}>{draft.length}/{MAX_MESSAGE_LEN}</span>
                </div>
              )}
            </div>
            )
          })()}
          </>
          )}
        </div>

      </div>
    </div>

    {reinviteFor && (
      <ReinviteModal
        groupName={groups.find(g => g.id === reinviteFor)?.name?.trim() || 'this group'}
        members={reinviteMembers}
        /* Only the fan-out targets are narrowed — reinviteGroup always builds the def from the
           group's full roster. Never pass the selection as the roster. */
        onConfirm={hexes => reinviteGroup(reinviteFor, hexes)}
        onClose={() => setReinviteFor(null)}
      />
    )}

    {cnsOpen && <CnsOverlay onClose={() => setCnsOpen(false)} />}

    {createGroupOpen && (
      <CreateGroupModal
        contacts={groupContactOptions}
        onCreate={(name, memberHexes) => { void createGroup(name, memberHexes).then(g => selectGroup(g.id)) }}
        onClose={() => setCreateGroupOpen(false)}
      />
    )}

    {/* ── New conversation ──────────────────────────────────────────────────────────────────
        Built to the design's §6A, which draws all nine variants of this one modal.

        THE INPUT NO LONGER CARRIES THE STATE. It used to: a leading icon that tinted four ways, a
        trailing spinner/check/cross, and a border that went red or amber. Three indicators saying
        one thing, and on a failure the field turned red about text that was perfectly well typed.
        Now the border says only "is this being worked on" (accent while resolving or resolved,
        danger only when the TEXT itself is wrong), and everything else is said once, underneath.

        NO CANCEL BUTTON. ModalCard's ×, Escape and the backdrop all close this, and in six of the
        nine states the primary is disabled — so Cancel beside it was a second inert button. One
        full-width CTA instead.

        Everything here is presentational. The debounced resolver fills composeRes, the input feeds
        composeNpub, and Start/Open call startWith(hex); this reads all of it and writes none of
        it except composeRetry, which the "Try again" link carries. */}
    {composeOpen && (() => {
      const r = composeRes
      const okHex = r.s === 'ok' ? r.hex : null
      const existing = okHex ? conversations.some(c => c.peerHex === okHex) : false
      const canStart = r.s === 'ok'
      // The field is accent while something is happening to it, danger only when the TYPED TEXT is
      // the problem, and neutral otherwise — including on a resolution failure, where the card below
      // carries the news and the text is not at fault.
      const typedIsWrong = r.s === 'invalid'
      const fieldActive = r.s === 'resolving' || r.s === 'ok'
      const av = okHex ? avatarFor(okHex) : null
      return (
      <ModalCard title="New conversation" onClose={() => setComposeOpen(false)} maxWidth={420}>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', marginTop: -6 }}>Enter an npub or an @name</div>

        <div style={{
          display: 'flex', alignItems: 'center', padding: '11px 13px', borderRadius: 11,
          border: `1px solid ${typedIsWrong ? 'var(--danger-500)' : fieldActive ? 'var(--accent-400)' : 'var(--border)'}`,
          boxShadow: fieldActive ? '0 0 0 3px rgba(var(--accent-400-rgb),0.14)' : 'none',
        }}>
          <input
            autoFocus
            value={composeNpub}
            onChange={e => setComposeNpub(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { if (canStart) startWith(okHex!) } else if (e.key === 'Escape') setComposeOpen(false) }}
            placeholder="npub or @name"
            spellCheck={false}
            className="cv-composer"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-body)', fontSize: 13.5, fontFamily: composeNpub.startsWith('npub') ? MONO : 'inherit', padding: 0 }}
          />
        </div>

        {/* The text itself is malformed — the one case the field is right to go red about. */}
        {r.s === 'invalid' && (
          <div style={{ fontSize: 12, color: 'var(--danger-500)', marginTop: -4 }}>
            {r.kind === 'not-npub' ? 'That is not an npub or an @name' : 'Invalid npub. The checksum doesn’t match.'}
          </div>
        )}

        {r.s === 'resolving' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: 'var(--text-body-dim)' }}>
            <span style={{ width: 13, height: 13, borderRadius: 99, border: '2px solid var(--border)', borderTopColor: 'var(--accent-400)', animation: 'cv-spin 0.8s linear infinite', flexShrink: 0 }} />
            Resolving @{r.name} on the Tari network…
          </div>
        )}

        {r.s === 'ok' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 13px', borderRadius: 12, background: 'var(--accent-wash)' }}>
            {/* THE GENERATED COLOUR, not the design's flat blue. The avatar's job here is the same
                as everywhere else in chat: telling you which person this is. */}
            <span style={{ width: 32, height: 32, borderRadius: 99, flexShrink: 0, background: av!.grad, color: av!.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>
              {/* r.name WITHOUT its @ — initialsFor takes the first two characters, so "@haci" would
                  render "@H" where "haci" gives "HA". */}
              {initialsFor(nicknames[okHex!] ?? r.name ?? undefined)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {nicknames[okHex!] ?? (r.name ? `@${r.name}` : truncNpub(okHex!))}
              </div>
              {/* THE KEY AN @NAME RESOLVED TO, in mono, not the design's flat "Ready to message".
                  This is the one moment before you message someone where you can check that the
                  name you typed points at the key you were given out of band — the same reason the
                  unreachable copy stays ours. A raw npub needs no such check: you already have the
                  key, so that case says "Ready to message" as the design draws it.
                  `existing` still wins the line, and is said twice over: the CTA below reads
                  "Open conversation" rather than "Start conversation". */}
              <div style={{ fontFamily: existing || !r.name ? undefined : MONO, fontSize: 11.5, color: 'var(--text-body-dim)', marginTop: 1, lineHeight: 1.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {existing ? 'You already have a conversation' : r.name ? truncNpub(okHex!) : 'Ready to message'}
              </div>
            </div>
          </div>
        )}

        {r.s === 'fail' && (() => {
          const bad = r.kind === 'not-found'
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 13px', borderRadius: 12, background: bad ? 'var(--card-danger)' : 'var(--card-warn)' }}>
              <span style={{ width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: bad ? 'var(--danger-500)' : 'var(--warn)' }}>
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <circle cx={12} cy={12} r={9} />
                  {bad ? <path d="M15 9l-6 6M9 9l6 6" /> : <path d="M12 8v4M12 16h.01" />}
                </svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: bad ? 'var(--danger-500)' : 'var(--warn)' }}>
                  {bad ? `@${r.name} was not found` : r.kind === 'unreachable' ? `Could not check @${r.name}` : `@${r.name} cannot receive messages yet`}
                </div>
                {/* UNREACHABLE KEEPS OUR WORDING, against the design's "The network is unreachable
                    right now." A lookup that failed is not a name that is missing, and letting a
                    reader conclude the second from the first is the one wrong belief this screen
                    can leave behind. */}
                <div style={{ fontSize: 11.5, color: 'var(--text-body-dim)', marginTop: 1, lineHeight: 1.45, textWrap: 'pretty' }}>
                  {bad ? 'No one has registered this name.'
                    : r.kind === 'unreachable' ? `This is a network problem, not a missing name. @${r.name} may well exist.`
                    : 'The name is registered but has no messaging key. Ask them to open Caravel Chat once.'}
                </div>
              </div>
              {r.kind === 'unreachable' && (
                <button
                  onClick={() => setComposeRetry(n => n + 1)}
                  style={{ flexShrink: 0, padding: 0, border: 'none', background: 'transparent', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', cursor: 'pointer', fontFamily: 'inherit' }}
                >Try again</button>
              )}
            </div>
          )
        })()}

        <button
          onClick={() => { if (canStart) startWith(okHex!) }}
          disabled={!canStart}
          className={canStart ? 'cv-btn-primary' : undefined}
          style={{
            width: '100%', padding: 11, borderRadius: 11, border: 'none',
            background: canStart ? 'var(--accent-400)' : 'var(--msg-received)',
            color: canStart ? 'var(--ink-on-accent)' : 'var(--text-muted-dim)',
            fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit',
            cursor: canStart ? 'pointer' : 'default',
          }}
        >
          {canStart ? (existing ? 'Open conversation' : 'Start conversation') : 'Start'}
        </button>
      </ModalCard>
      )
    })()}

    {/* Delete-conversation confirmation — destructive, localStorage is the only copy.
        §7A·1 draws this on the SHARED modal frame, not as a bespoke danger card: the warning-icon
        tile and the danger-tinted border are gone, and a peer identity row does that work instead —
        it says WHICH conversation and how much of it, which a red triangle never did.
        THE BODY COPY IS OURS, DELIBERATELY. The design's own draft reads "Messages are end-to-end
        encrypted, so they cannot be recovered" — encryption is not why: this device holds the only
        copy. Ours names what actually goes (messages, nickname, payment history) and why. */}
    {confirmDelete && selectedConvo && (
      <ModalCard title="Delete conversation" onClose={() => setConfirmDelete(false)} maxWidth={420}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 13px', borderRadius: 12, background: 'var(--surface-base)', border: '1px solid var(--border)' }}>
          {/* Our generated per-peer tile, not the design's flat blue swatch — the identity system
              stage 2 settled is the whole point of an avatar appearing here at all. */}
          <Avatar hex={selectedConvo.peerHex} nickname={nicknames[selectedConvo.peerHex]} size={32} radius={99} fontSize={12} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(selectedConvo.peerHex)}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 1 }}>
              Direct conversation · {selectedConvo.messages.length} message{selectedConvo.messages.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-body-dim)', lineHeight: 1.55, textWrap: 'pretty' }}>
          All messages, the nickname, and payment history with <b style={{ color: 'var(--text-name)' }}>{displayName(selectedConvo.peerHex)}</b> will be permanently removed from this device and <b style={{ color: 'var(--danger-300)' }}>cannot be recovered</b>. The other person keeps their copy.
        </div>
        <div style={{ display: 'flex', gap: 9, marginTop: 2 }}>
          <button
            onClick={() => setConfirmDelete(false)}
            style={{ flex: 1, padding: 11, borderRadius: 11, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-body-dim)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Cancel
          </button>
          <button
            onClick={performDelete}
            style={{ flex: 1, padding: 11, borderRadius: 11, border: 'none', background: 'var(--danger-500)', color: 'var(--ink-on-accent)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Delete
          </button>
        </div>
      </ModalCard>
    )}
    </>
  )
}
