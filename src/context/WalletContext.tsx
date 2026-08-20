import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode, type Dispatch, type SetStateAction } from 'react'
import { type SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import {
  createMnemonic,
  seedFromMnemonic,
  walletFromSeed,
  encryptMnemonic,
  decryptMnemonic,
  hasStoredWallet,
  loadStoredWallet,
  saveStoredWallet,
} from '../crypto/walletCrypto'
import { deriveNostrKeyFromSeed } from '../crypto/nostrCrypto'
import { scanWallet, type ScannedUtxo, type ScanProgress } from '../crypto/walletScanner'
import { loadHistory, addSent, type SentEntry, type NewSentParams } from '../crypto/txHistory'
import { NostrMessagingProvider } from '../messaging/NostrMessagingProvider'
import type { MessagingProvider, MessagingConnectionStatus, CaravelMessage, RelayState } from '../messaging/types'
import { loadMessages, addReceivedMessage, addSentMessage, deletePeerMessages, deleteGroupMessages, applyEditByLogicalId, editReachOk, targetsLeftGroup, nextRevision, applyReactionByLogicalId, nextReactionSeq, isReactableTarget, liveReactionCountBy, MAX_LIVE_REACTIONS_PER_REACTOR } from '../messaging/messageStore'
import { loadGroups, addOrUpdateGroup, ensureGroup, setGroupState, hasGroup, getGroupState, deleteGroup as removeGroupFromStore } from '../messaging/groupStore'
import { loadDeletedGroupIdSet, recordDeletedGroup, clearDeletedGroup } from '../messaging/deletedGroupStore'
import { loadSeenDefIdSet, recordSeenDef } from '../messaging/seenDefStore'
import type { Group } from '../messaging/types'
import { loadTombstoneIdSet, recordTombstones } from '../messaging/tombstoneStore'
import { removeResolvedAmounts } from '../messaging/paymentResolutionStore'
import { deleteBlobs } from '../messaging/blobCache'
import { mediaBlobKeys } from '../messaging/sendMedia'
import { loadContacts, setContactState, removeContact, type ContactMap } from '../messaging/contactStore'
import { loadTariAddresses, setTariAddress, type TariAddressMap } from '../messaging/tariAddressStore'
import { DEFAULT_RELAYS } from '../config/relays'

// ── Scan state ────────────────────────────────────────────────────────────────

export interface ScanState {
  status: 'idle' | 'scanning' | 'done' | 'error'
  balance: bigint | null
  utxos: ScannedUtxo[]
  progress: ScanProgress
  totalScanned: number
  /** True when the indexer capped the returned set at its limit — balance may be understated. */
  incomplete: boolean
  error: string
}

const SCAN_IDLE: ScanState = {
  status: 'idle',
  balance: null,
  utxos: [],
  progress: { scanned: 0, found: 0 },
  totalScanned: 0,
  incomplete: false,
  error: '',
}

// ── Types ─────────────────────────────────────────────────────────────────────

// The outcome of editMessage (M4). Widened from a bare boolean when group editing landed: a group
// edit is a FAN-OUT, so "it worked" is not one bit of information — reaching 1 of 5 members and
// reaching 5 of 5 are both `ok`, and collapsing them would leave the sender's UI quietly implying
// full delivery. The counts let the caller report the shortfall honestly.
//
// memberCount/membersReached are GROUP-ONLY and absent on a DM result: a DM has a single recipient,
// so there is no partial reach to describe (`ok` already says whether a relay accepted).
// Both counts are RELAY ACCEPTANCE, never delivery — same caveat as GroupSendResult.
export interface EditResult {
  ok: boolean
  memberCount?: number
  membersReached?: number
}

// The outcome of reactMessage (reactions v1). Structurally identical to EditResult and kept as its
// own name rather than aliased: the two describe different acts, and a later divergence (a reason
// code for "you already have two") should not have to unpick a shared type first.
export interface ReactResult {
  ok: boolean
  memberCount?: number
  membersReached?: number
}

export interface WalletCtx {
  walletExists: boolean
  wallet: SecretKeyWallet | null
  address: string | null
  nostrNpub: string | null
  /** x-only secp256k1 pubkey hex (32 bytes). Stored alongside nostrNpub for callers that
   *  need raw hex without re-decoding bech32 — derivation already computes it for free. */
  nostrPubkeyHex: string | null
  scan: ScanState
  txHistory: SentEntry[]
  /** Generate a fresh BIP-39 mnemonic (sync, call before showing step 2). */
  generateMnemonic: () => string
  /** Encrypt mnemonic with password, save to localStorage, unlock in memory. */
  createWallet: (mnemonic: string, password: string) => Promise<void>
  /** Decrypt stored wallet with password, load into memory. */
  unlock: (password: string) => Promise<void>
  /** Overwrite stored wallet from an existing phrase + new password, then unlock. */
  restore: (mnemonic: string, password: string) => Promise<void>
  /** Clear wallet from memory (wallet remains in localStorage; returns to unlock screen). */
  lock: () => void
  /** Decrypt and return the stored mnemonic — requires the user's password. */
  getMnemonic: (password: string) => Promise<string>
  /** Re-run the UTXO scan (cancels any in-progress scan). */
  rescan: () => void
  /** Record a sent transaction in persisted history. */
  recordSent: (params: NewSentParams) => void
  /** Auto-managed messaging status, updated as relay connections change. */
  messagingStatus: MessagingConnectionStatus
  /** Sent + received messages for the current identity, persisted per-pubkey in localStorage
   *  and reloaded on unlock. React state is cleared on lock; the stored copy survives. */
  messages: CaravelMessage[]
  /** Persist + surface a message we just sent (the CaravelMessage returned by sendMessage). */
  recordSentMessage: (msg: CaravelMessage) => void
  /** Groups the current identity participates in (Phase 1: fan-out, in-message roster). Persisted
   *  per-pubkey; reloaded on unlock; cleared on lock (stored copy survives). */
  groups: Group[]
  /** Create a group locally (id generated, self included in the roster) and fan its definition out
   *  to the other members so their clients learn it. Returns the new Group. */
  createGroup: (name: string, memberHexes: string[]) => Promise<Group>
  /** Delete a group locally: remove it + its groupId-keyed messages (Phase 1 cleanup). */
  deleteGroup: (groupId: string) => void
  /** Accept a pending group invite (Phase A): pending → active, releasing its held messages. */
  acceptGroup: (groupId: string) => void
  /** Decline a pending group invite (Phase A): pending → 'left', a permanent local suppression. */
  declineGroup: (groupId: string) => void
  /** Leave a group I'm active in (Phase B): active → 'left', the same permanent local suppression
   *  as decline. Non-destructive — history and roster are kept, hidden by state. */
  leaveGroup: (groupId: string) => void
  /** Re-invite (Phase C): re-send this group's definition, marked as a deliberate re-invite, so a
   *  member who LEFT gets a fresh invite card. `memberHexes` selects who receives it (C-M2's
   *  picker); omit for the whole roster. The def always carries the FULL roster either way.
   *  Best-effort; never throws. */
  reinviteGroup: (groupId: string, memberHexes?: string[]) => void
  /** Per-peer contact state (M9.0b). No record + has messages ⇒ treat as 'accepted' (lazy). */
  contacts: ContactMap
  /** Accept a pending peer (M9.0c request UI). */
  acceptContact: (peerHex: string) => void
  /** Per-contact Tari addresses (M9.0d), each tagged 'manual' or verified 'exchanged'. */
  contactAddresses: TariAddressMap
  /** Set/clear a manually-entered Tari address for a peer (won't overwrite a verified one). */
  setManualTariAddress: (peerHex: string, addr: string) => void
  /** Delete a conversation locally: tombstone its message ids (so the relay backfill can't
   *  resurrect them), then clear its messages + resolved payment amounts + contact record. Also
   *  the decline path — local-only. */
  deleteConversation: (peerHex: string) => void
  /** Edit an already-sent message — DM or group (M4): publish the edit, then apply it locally IF it
   *  got far enough (a relay accepted for a DM; at least one member was reached for a group).
   *  `ok` is false when the message can't be edited (not ours, no logicalId, a system row, empty
   *  text, a group that is gone or not active) or nothing accepted at all.
   *  The counts are GROUP-ONLY and absent for a DM, which has no such thing as partial reach.
   *  Best-effort throughout — see MessagingProvider.sendEdit / sendGroupEdit. */
  editMessage: (logicalId: string, newText: string) => Promise<EditResult>
  /** Add or remove one of MY emoji reactions on any message in a live thread (reactions v1).
   *  Anyone-to-anyone — unlike editMessage this is not restricted to my own messages — but always
   *  MY reaction: the reactor is this identity, taken from the authenticated seal on receipt and
   *  from `nostrPubkeyHex` here, never from a caller-supplied value.
   *  `ok` is false when the message can't be reacted to (unknown, a system/payment/media row, no
   *  logicalId, a group that is gone or not active), when adding would exceed the two-reaction
   *  allowance, or when nothing was accepted at all. Counts are GROUP-ONLY, as for editMessage.
   *  Best-effort throughout — see MessagingProvider.sendReaction / sendGroupReaction. */
  reactMessage: (logicalId: string, emoji: string, action: 'add' | 'remove') => Promise<ReactResult>
  /** Factory: returns a ready-to-use MessagingProvider backed by the current identity,
   *  or null if the wallet is locked. The secret key stays inside the closure — callers
   *  receive a working provider but never see the raw key. */
  createMessagingProvider: () => MessagingProvider | null
  /** Snapshot of per-relay health from the live provider (empty when locked). Not reactive — poll. */
  getRelayStates: () => RelayState[]
  /** Force-reconnect all down relays on the live provider (relay-health panel "Reconnect all"). */
  reconnectAll: () => void
  /** Shared "hide balance" toggle — one source for the sidebar chip and the wallet modal. */
  balanceHidden: boolean
  setBalanceHidden: Dispatch<SetStateAction<boolean>>
}

// ── Context ───────────────────────────────────────────────────────────────────

const Ctx = createContext<WalletCtx | null>(null)

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider')
  return ctx
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<SecretKeyWallet | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [nostrNpub, setNostrNpub] = useState<string | null>(null)
  const [nostrPubkeyHex, setNostrPubkeyHex] = useState<string | null>(null)
  const [walletExists, setWalletExists] = useState(() => hasStoredWallet())
  const [scan, setScan] = useState<ScanState>(SCAN_IDLE)
  const [txHistory, setTxHistory] = useState<SentEntry[]>([])

  // Ref holds the AbortController for the active scan — replaced each run
  const scanAbortRef = useRef<AbortController | null>(null)
  // Nostr private key: held in a ref, never in state, wiped on lock
  const nostrSecretKeyRef = useRef<string | null>(null)
  // Persistent messaging provider — held in a ref so it survives re-renders without
  // triggering them; state below is what actually drives UI updates.
  const messagingProviderRef = useRef<NostrMessagingProvider | null>(null)
  // In-memory tombstone set (deleted gift-wrap event ids) — loaded once per unlock so a backfill
  // burst checks memory, not localStorage per message. Kept in sync on delete.
  const tombstonesRef = useRef<Set<string>>(new Set())
  // In-memory set of deleted group ids — the def-suppression counterpart to tombstonesRef (which is
  // per-message-id). Rehydrated from localStorage on unlock BEFORE the subscription replays.
  const deletedGroupsRef = useRef<Set<string>>(new Set())
  // In-memory set of peers we have ANY message with — burst-safe "is this a brand-new peer?" test
  // for the pending-contact rule (React `messages` state is stale mid-burst). Seeded on unlock.
  const knownPeersRef = useRef<Set<string>>(new Set())
  const [groups, setGroups] = useState<Group[]>([])
  // Fresh-in-callback set of contact pubkeys (any state) for the group-sender gate — React
  // `contacts` state is stale inside the subscribe closure. Kept in sync via the effect below.
  const contactsRef = useRef<Set<string>>(new Set())
  // Fresh-in-callback set of group ids I have LEFT (state === 'left'), for the drop-at-ingest gate
  // (B-M2). Deliberately its OWN ref, not deletedGroupsRef: that set also holds deleteGroup's ids,
  // whose contract is "forget UNTIL RE-INVITED" (a new message must re-materialise the group), and
  // it is age-pruned at 3 days. Only `state: 'left'` is the durable, permanent suppression.
  const leftGroupsRef = useRef<Set<string>>(new Set())
  // In-memory set of RE-INVITE def event ids already acted on (Phase C). Makes the 'left' lift
  // exactly-once against the relay's ~2-day replay window. Rehydrated on unlock before subscribing.
  const seenDefsRef = useRef<Set<string>>(new Set())
  const [messagingStatus, setMessagingStatus] = useState<MessagingConnectionStatus>('disconnected')
  const [balanceHidden, setBalanceHidden] = useState(false)
  const [messages, setMessages] = useState<CaravelMessage[]>([])
  const [contacts, setContacts] = useState<ContactMap>({})
  // Per-contact Tari addresses (manual or verified-exchanged). Owned here because the inbound
  // exchanged address arrives in the subscription callback (M9.0d).
  const [contactAddresses, setContactAddresses] = useState<TariAddressMap>({})

  // Keep the gate ref in sync so the subscribe closure sees current contacts (state would be stale).
  useEffect(() => { contactsRef.current = new Set(Object.keys(contacts)) }, [contacts])
  useEffect(() => { leftGroupsRef.current = new Set(groups.filter(g => g.state === 'left').map(g => g.id)) }, [groups])

  const startScan = useCallback((w: SecretKeyWallet) => {
    // Cancel any prior scan
    scanAbortRef.current?.abort()
    const ctrl = new AbortController()
    scanAbortRef.current = ctrl

    const viewSecret = w.getViewOnlySecret()
    if (!viewSecret) return  // no view key — can't scan

    // Clean slate — do NOT carry over the previous scan's balance/utxos. Carrying them produced the
    // misleading "N owned" against a stale/zero balance; a fresh scan starts blank and fills in.
    setScan({ ...SCAN_IDLE, status: 'scanning' })

    scanWallet(
      viewSecret,
      (progress) => {
        if (ctrl.signal.aborted) return
        setScan(prev => ({ ...prev, progress }))
      },
      ctrl.signal,
    ).then(result => {
      if (ctrl.signal.aborted) return
      setScan({
        status: 'done',
        balance: result.balance,
        utxos: result.utxos,
        progress: { scanned: result.totalScanned, found: result.utxos.length },
        totalScanned: result.totalScanned,
        incomplete: result.incomplete,
        error: '',
      })
      // Note: the scan feeds BALANCE only. Activity is derived from message-linked payments
      // (see buildActivity) — the scan can't tell an incoming payment from our own change output.
    }).catch((err: unknown) => {
      if (ctrl.signal.aborted) return
      // A real (post-retry) failure — clear stale balance/utxos so we show an honest error + Retry,
      // never a leftover count against a failed scan.
      setScan({
        ...SCAN_IDLE,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, [])

  // Materialize a wallet object + resolve its address into state, then auto-scan
  const materialize = useCallback(async (w: SecretKeyWallet) => {
    const addr = await w.getAddress()
    setWallet(w)
    setAddress(addr)
    setTxHistory(loadHistory(addr))
    startScan(w)
  }, [startScan])

  const generateMnemonic = useCallback(() => createMnemonic(), [])

  // Tears down any existing provider, starts a new one with the given identity, and
  // wires status + message callbacks into React state. Returns immediately — relay
  // connections happen in the background so unlock never waits for the network.
  const startMessaging = useCallback((secretHex: string, pubkeyHex: string) => {
    messagingProviderRef.current?.disconnect()
    // Load persisted history for this identity before subscribing, so it's visible
    // immediately on unlock without waiting for a relay round-trip.
    const loaded = loadMessages(pubkeyHex)
    setMessages(loaded)
    setContacts(loadContacts(pubkeyHex))
    setContactAddresses(loadTariAddresses(pubkeyHex))
    const loadedGroups = loadGroups(pubkeyHex)
    setGroups(loadedGroups)
    // Seed the "known peers" set from persisted history — anyone we already have a message with is
    // NOT a new peer (so their next inbound never gets mis-flagged as a pending request).
    knownPeersRef.current = new Set(
      loaded.map(m => (m.direction === 'received' ? m.senderPubkeyHex : m.recipientPubkeyHex)).filter(Boolean)
    )
    // Load deleted-message tombstones (pruned) so the relay's 2-day backfill can't resurrect them.
    tombstonesRef.current = loadTombstoneIdSet(pubkeyHex)
    // Load deleted-group ids so onGroupDefinition can suppress a deleted group's replayed def.
    deletedGroupsRef.current = loadDeletedGroupIdSet(pubkeyHex)
    // Seed the group gate refs EAGERLY from the same load (B-M2). setGroups above only schedules a
    // state update, so the [groups] effect that maintains these would not run until after the commit
    // — strictly after subscribe() below. Relay backfill arrives well after a WebSocket handshake, so
    // the effect normally wins, but that is timing luck, not a guarantee. Seeding here puts this on
    // the same footing as tombstonesRef/deletedGroupsRef: correct before the subscription replays.
    leftGroupsRef.current = new Set(loadedGroups.filter(g => g.state === 'left').map(g => g.id))
    // Re-invite def ids already acted on, so a replayed re-invite can't re-open the card on reload.
    seenDefsRef.current = loadSeenDefIdSet(pubkeyHex)
    const provider = new NostrMessagingProvider(secretHex, pubkeyHex, DEFAULT_RELAYS)
    messagingProviderRef.current = provider
    setMessagingStatus('connecting')
    provider.subscribe(
      // Merge-and-persist each arrival. Mirrors txHistory's setTxHistory(prev => addSent(...))
      // pattern: the store helper dedups, writes localStorage, and returns the next array.
      // Tombstoned ids (deleted conversations) are dropped silently before they hit the store.
      (msg) => {
        if (tombstonesRef.current.has(msg.id)) return
        // GROUP message (Phase 1): gate to KNOWN CONTACTS (sender is someone we already know), and
        // deliberately DO NOT run the DM pending-contact logic — group membership isn't a DM request.
        // Drop group messages from strangers. A known group message ensures its (lazy) group entry.
        if (msg.groupId) {
          const sender = msg.senderPubkeyHex
          if (!knownPeersRef.current.has(sender) && !contactsRef.current.has(sender)) return
          // DROP-AT-INGEST for a group I have LEFT (B-M2). 'left' is permanent local suppression, so
          // nothing about this group should touch the store again — otherwise a left group keeps
          // accumulating invisible messages in localStorage forever (peers still hold me in their
          // roster and keep fanning out). This STRENGTHENS the guarantee: suppression moves from
          // derivation-time to ingest-time, with the state filters in ChatApp as a second layer.
          // Only 'left' matches — 'pending' (held) and 'active' are untouched.
          // PHASE C: re-invite therefore resumes FRESH — messages sent while I was left were never
          // stored and cannot be back-filled. Deliberate, and the honest semantic for a re-invite
          // (the relay's ~2-day window made "keep them all" unachievable anyway).
          if (leftGroupsRef.current.has(msg.groupId)) return
          // A system NOTICE must NEVER call ensureGroup — that is what stops a leave notice for an
          // unknown group from minting a phantom 'pending' placeholder, i.e. an invite card conjured
          // out of someone LEAVING. Presence is a SEPARATE concern, tested against the persisted
          // store (authoritative at call time) rather than a ref snapshot, so this has no dependency
          // on React commit timing: a group learned earlier in the same backfill burst is already
          // saved and answers true. Dropping an unknown group's notice also keeps a stale "X has
          // left" from surfacing later if that group re-materialises via deleteGroup's
          // forget-until-re-invited path — the row is never stored in the first place.
          if (msg.system) {
            if (!hasGroup(pubkeyHex, msg.groupId)) return
            setMessages(prev => addReceivedMessage(pubkeyHex, prev, msg))
            return
          }
          setGroups(prev => ensureGroup(pubkeyHex, prev, msg.groupId!))
          setMessages(prev => addReceivedMessage(pubkeyHex, prev, msg))
          return
        }
        const peerHex = msg.senderPubkeyHex
        // Brand-new peer (no message with them ever) → a PENDING request. Write the pending record
        // FIRST (before the message is added), so when the list re-derives in the same batched
        // commit the pending record is already present and the peer can't leak in as lazy-accepted.
        if (peerHex && !knownPeersRef.current.has(peerHex)) {
          knownPeersRef.current.add(peerHex)
          setContacts(prev => (prev[peerHex] ? prev : setContactState(pubkeyHex, prev, peerHex, 'pending')))
        }
        setMessages(prev => addReceivedMessage(pubkeyHex, prev, msg))
      },
      (status) => {
        // Guard against stale callbacks firing after lock() replaces or clears the provider
        if (messagingProviderRef.current !== provider) return
        setMessagingStatus(status)
      },
      // Inbound Tari address (M9.0d): authenticated (seal.pubkey === rumor.pubkey enforced in
      // unwrapMessage), so it is bound to senderPubkeyHex. Store as 'exchanged' (verified). A
      // basic otl_ shape check guards against a malformed tag. Exchanged beats manual in the store.
      (senderPubkeyHex, tariAddress) => {
        if (!senderPubkeyHex || !tariAddress.startsWith('otl_')) return
        setContactAddresses(prev => setTariAddress(pubkeyHex, prev, senderPubkeyHex, tariAddress, 'exchanged'))
      },
      // Inbound group definition. Same KNOWN-CONTACT gate as group messages: only a sender we already
      // know can introduce a group. first-def-wins is enforced inside addOrUpdateGroup.
      (senderPubkeyHex, def, defEventId, reinvite) => {
        if (!knownPeersRef.current.has(senderPubkeyHex) && !contactsRef.current.has(senderPubkeyHex)) return
        // RE-INVITE LIFT (Phase C). A def may lift a locally 'left' group only if it is MARKED as a
        // re-invite and its gift-wrap event id has not been acted on before. The marker rules out
        // every def sent before Phase C existed (so upgrading can't spuriously resurrect a left
        // group from a replay of its ORIGINAL def); the event id rules out the relay replaying the
        // re-invite itself for ~2 days, which would otherwise re-open the card on every reload and
        // after every decline. Both checks run BEFORE any state change, and the id is recorded
        // first, so a duplicate arriving in the same burst finds it already seen.
        // The 'left' test reads PERSISTED state, not leftGroupsRef: the ref is a snapshot the
        // [groups] effect maintains, so a group left moments earlier in this same session may not be
        // in it yet. Same reasoning as B-M2's notice gate — a def is rare enough to afford the read.
        const lifting = reinvite && !seenDefsRef.current.has(defEventId) && getGroupState(pubkeyHex, def.id) === 'left'
        if (lifting) {
          seenDefsRef.current.add(defEventId)
          recordSeenDef(pubkeyHex, defEventId)
          // Drop the tombstone with the state, or a later replay would find a stale entry and
          // suppress the group again. Both the persisted record and the in-memory set.
          deletedGroupsRef.current.delete(def.id)
          clearDeletedGroup(pubkeyHex, def.id)
          // Clear the ingest drop EAGERLY — the [groups] effect would not catch up until after the
          // commit, and an inbound message for the newly-lifted group in that window would be
          // dropped (the same commit-window hazard as B-M2's gate refs).
          leftGroupsRef.current.delete(def.id)
        }
        setGroups(prev => {
          // Present-check: drop a def that would RESURRECT a deleted group — one that is absent
          // locally AND whose id is in the deleted-groups set (a stale backfill replay). A genuine
          // new message re-materialises the group (ungated, in the onMessage branch); once the group
          // is present again, a replayed def flows through here and re-names/re-rosters it.
          //
          // UNTOUCHED BY PHASE C, deliberately: this guards the DELETED case, where the record is
          // ABSENT. A 'left' group's record is PRESENT, so this line never fires for one — the lift
          // above and first-def-wins in addOrUpdateGroup cover that disjoint case. Keeping the two
          // separate is what stops re-invite from reopening the delete-suppression bug d3baa8b fixed.
          if (!prev.some(g => g.id === def.id) && deletedGroupsRef.current.has(def.id)) return prev
          // Invite-gating (Phase A): a def for a BRAND-NEW group lands as 'pending' (held until the
          // user accepts). A def for an existing group is ignored by first-def-wins / preserves its
          // state (a placeholder upgrade keeps 'pending'/'left'), so initialState only bites on new ids.
          // `reinvite` (Phase C) is the one exception, and only for state === 'left' → 'pending'.
          return addOrUpdateGroup(pubkeyHex, prev, def, 'pending', { reinvite: lifting })
        })
      },
      // Inbound EDIT (M2/M4). Almost every check lives in the store, and the one that matters most is
      // AUTHORSHIP — applyEdit refuses unless this authenticated sender (seal.pubkey, verified against
      // the rumor pubkey in unwrapMessage) is the original message's sender. So an edit naming a
      // message we don't have, one we deleted, one from someone else, or one carrying a stale revision
      // all resolve to the same thing: the array comes back unchanged, by reference.
      //
      // That authorship guard is also what makes a GROUP edit safe (M4): every member legitimately
      // learns the logicalId of every group message, so a member CAN address an edit at another
      // member's message — and every recipient, including the original author, rejects it here.
      //
      // The ONE gate the store cannot make is the group-lifecycle one, added in M4. An edit carries no
      // group tag on the wire, so this is keyed on the target row we already hold — see
      // targetsLeftGroup. Without it a LEFT group would keep mutating: leave/decline are
      // non-destructive, so its rows are still here, and an edit would rewrite hidden history in a
      // group whose contract (B-M2) is that nothing about it touches the store again. A DELETED
      // group's rows are gone, so that case is already the unknown-logicalId no-op.
      (senderPubkeyHex, targetLogicalId, newText, revision) => {
        setMessages(prev => {
          if (targetsLeftGroup(prev, targetLogicalId, leftGroupsRef.current)) return prev
          return applyEditByLogicalId(pubkeyHex, prev, targetLogicalId, newText, revision, senderPubkeyHex)
        })
      },
      // Inbound REACTION (reactions v1). Deliberately the same two-line shape as the edit handler
      // above, and for the same division of labour: every check that can be made from stored state
      // lives in applyReactionByLogicalId (target exists, target is a text row, ordering by seq, the
      // per-person allowance, the per-message row cap), so an unknown, deleted, stale or replayed
      // reaction all resolve to the array coming back unchanged, by reference.
      //
      // The one gate the store cannot make is the group-lifecycle one, exactly as for edits: a
      // reaction carries no group tag on the wire, so it is keyed on the target row we already hold.
      // Without it a LEFT group would keep mutating — leave/decline are non-destructive, so its rows
      // are still here — and reactions would accumulate on hidden history in a group whose contract
      // (B-M2) is that nothing about it touches the store again. A DELETED group's rows are gone, so
      // that case is already the unknown-logicalId no-op.
      //
      // NO AUTHORSHIP GATE, unlike the edit handler, and nothing here needs to add one: `senderPubkeyHex`
      // is the authenticated seal pubkey and the applier keys the row on it, so this can only ever
      // create or flip the sender's OWN reaction — never anyone else's, in a group or a DM.
      (senderPubkeyHex, targetLogicalId, emoji, action, seq) => {
        setMessages(prev => {
          if (targetsLeftGroup(prev, targetLogicalId, leftGroupsRef.current)) return prev
          return applyReactionByLogicalId(pubkeyHex, prev, targetLogicalId, emoji, action, seq, senderPubkeyHex)
        })
      }
    )
  }, [])

  const createWallet = useCallback(async (mnemonic: string, password: string) => {
    const stored = await encryptMnemonic(mnemonic, password)
    saveStoredWallet(stored)
    setWalletExists(true)
    const seed = await seedFromMnemonic(mnemonic)
    const nostr = deriveNostrKeyFromSeed(seed)
    nostrSecretKeyRef.current = nostr.privateKeyHex
    setNostrNpub(nostr.npub)
    setNostrPubkeyHex(nostr.publicKeyHex)
    const w = await walletFromSeed(seed)
    await materialize(w)
    startMessaging(nostr.privateKeyHex, nostr.publicKeyHex)
  }, [materialize, startMessaging])

  const unlock = useCallback(async (password: string) => {
    const stored = loadStoredWallet()
    if (!stored) throw new Error('No wallet stored')
    const mnemonic = await decryptMnemonic(stored, password)
    const seed = await seedFromMnemonic(mnemonic)
    const nostr = deriveNostrKeyFromSeed(seed)
    nostrSecretKeyRef.current = nostr.privateKeyHex
    setNostrNpub(nostr.npub)
    setNostrPubkeyHex(nostr.publicKeyHex)
    const w = await walletFromSeed(seed)
    await materialize(w)
    startMessaging(nostr.privateKeyHex, nostr.publicKeyHex)
  }, [materialize, startMessaging])

  const restore = useCallback(async (mnemonic: string, password: string) => {
    const stored = await encryptMnemonic(mnemonic, password)
    saveStoredWallet(stored)
    setWalletExists(true)
    const seed = await seedFromMnemonic(mnemonic)
    const nostr = deriveNostrKeyFromSeed(seed)
    nostrSecretKeyRef.current = nostr.privateKeyHex
    setNostrNpub(nostr.npub)
    setNostrPubkeyHex(nostr.publicKeyHex)
    const w = await walletFromSeed(seed)
    await materialize(w)
    startMessaging(nostr.privateKeyHex, nostr.publicKeyHex)
  }, [materialize, startMessaging])

  const lock = useCallback(() => {
    scanAbortRef.current?.abort()
    scanAbortRef.current = null
    messagingProviderRef.current?.disconnect()
    messagingProviderRef.current = null
    tombstonesRef.current = new Set()
    deletedGroupsRef.current = new Set()
    knownPeersRef.current = new Set()
    setMessagingStatus('disconnected')
    setMessages([])
    setGroups([])
    // Cleared eagerly, like contactsRef below: the [groups] effect would also clear this, but not
    // until after the commit, and the subscribe closure must not see another identity's ids.
    leftGroupsRef.current = new Set()
    seenDefsRef.current = new Set()
    contactsRef.current = new Set()
    setContacts({})
    setContactAddresses({})
    setScan(SCAN_IDLE)
    setWallet(null)
    setAddress(null)
    setTxHistory([])
    setNostrNpub(null)
    setNostrPubkeyHex(null)
    nostrSecretKeyRef.current = null
  }, [])

  const getMnemonic = useCallback(async (password: string) => {
    const stored = loadStoredWallet()
    if (!stored) throw new Error('No wallet stored')
    return decryptMnemonic(stored, password)
  }, [])

  const rescan = useCallback(() => {
    if (wallet && address) startScan(wallet)
  }, [wallet, address, startScan])

  const recordSent = useCallback((params: NewSentParams) => {
    if (!address) return
    setTxHistory(prev => addSent(address, prev, params))
  }, [address])

  // Record a message we just sent (the CaravelMessage returned by provider.sendMessage),
  // persisting it under the current identity. Mirrors recordSent above.
  const recordSentMessage = useCallback((msg: CaravelMessage) => {
    if (!nostrPubkeyHex) return
    // Initiating (or replying to) a peer accepts them — I chose to message them. Mark accepted
    // BEFORE adding the message, and record them as known so a later inbound never flips them to
    // pending. Accepted is never downgraded by a later inbound (the inbound guard skips existing).
    const peerHex = msg.recipientPubkeyHex
    if (peerHex) {
      knownPeersRef.current.add(peerHex)
      setContacts(prev => setContactState(nostrPubkeyHex, prev, peerHex, 'accepted'))
    }
    setMessages(prev => addSentMessage(nostrPubkeyHex, prev, msg))
  }, [nostrPubkeyHex])

  // Accept a peer (M9.0c): the request-UI Accept, and also Compose (initiating a conversation
  // accepts them). Idempotent. Marking them known means a racing inbound can't re-flag them
  // pending — belt-and-suspenders on top of the inbound handler's existing "already decided" guard.
  const acceptContact = useCallback((peerHex: string) => {
    if (!nostrPubkeyHex || !peerHex) return
    knownPeersRef.current.add(peerHex)
    setContacts(prev => setContactState(nostrPubkeyHex, prev, peerHex, 'accepted'))
  }, [nostrPubkeyHex])

  // Set (or clear, when addr is blank) a MANUALLY-entered Tari address for a peer (M10.1 composer).
  // A verified 'exchanged' address is not overwritten by a manual one (guarded in the store).
  const setManualTariAddress = useCallback((peerHex: string, addr: string) => {
    if (!nostrPubkeyHex || !peerHex) return
    setContactAddresses(prev => setTariAddress(nostrPubkeyHex, prev, peerHex, addr, 'manual'))
  }, [nostrPubkeyHex])

  // Delete a conversation and everything tied to it (M9.0a), LOCAL-ONLY — nothing is sent to the
  // relays or the peer. ORDER MATTERS: tombstone the deleted ids FIRST (and update the in-memory
  // set) so a relay backfill arriving in the gap can't repopulate the conversation, THEN clear the
  // stores. The nickname is cleared by ChatApp (which owns its React state).
  const deleteConversation = useCallback((peerHex: string) => {
    const pubkeyHex = nostrPubkeyHex
    if (!pubkeyHex) return
    const inConvo = messages.filter(m =>
      (m.direction === 'received' ? m.senderPubkeyHex : m.recipientPubkeyHex) === peerHex
    )
    const ids = inConvo.map(m => m.id)
    const utxoIds = inConvo.map(m => m.payment?.utxoId).filter((x): x is string => !!x)
    // Cached image blobs for this conversation (images M3, closing the M1 deferral). Harvested from
    // the doomed rows BEFORE they are removed, exactly as utxoIds are.
    const blobKeys = mediaBlobKeys(inConvo)

    // 1) Tombstone FIRST — persist + block the live subscription immediately.
    recordTombstones(pubkeyHex, ids)
    for (const id of ids) tombstonesRef.current.add(id)

    // 2) THEN clear the stores this context owns. Also forget the peer entirely (contact record +
    //    known-peers set) so a later message from them arrives as a FRESH pending request — this
    //    unifies delete and decline (hide-and-forget).
    removeResolvedAmounts(pubkeyHex, utxoIds)
    // FIRE-AND-FORGET: the blob cache is async (IndexedDB) while this function is synchronous, and it
    // is non-authoritative anyway — a purge that fails leaves unreachable bytes the browser evicts,
    // never a broken delete. So delete returns before the blobs are gone, deliberately.
    void deleteBlobs(pubkeyHex, blobKeys)
    knownPeersRef.current.delete(peerHex)
    setContacts(prev => removeContact(pubkeyHex, prev, peerHex))
    setContactAddresses(prev => setTariAddress(pubkeyHex, prev, peerHex, '', 'manual'))  // blank → clear
    setMessages(prev => deletePeerMessages(pubkeyHex, prev, peerHex))
  }, [nostrPubkeyHex, messages])

  // Factory: constructs a MessagingProvider backed by the current Nostr identity.
  // The secret key is captured from the ref at call time — it never appears on the
  // context value, and callers receive a working provider without ever seeing the key.
  const createMessagingProvider = useCallback((): MessagingProvider | null => {
    const secretHex = nostrSecretKeyRef.current
    if (!secretHex || !nostrPubkeyHex) return null
    return new NostrMessagingProvider(secretHex, nostrPubkeyHex, DEFAULT_RELAYS)
  }, [nostrPubkeyHex])

  // Edit an already-sent message — DM (M2) or GROUP (M4). SEND FIRST, apply locally only once the
  // edit got far enough, so a send that went nowhere never leaves this device reading text nobody
  // else will ever see. (M3's UI is optimistic ON TOP of this: the bubble shows the new text while
  // the publish is outstanding and snaps back if this resolves !ok. The STORE is still only written
  // here, on success.)
  //
  // The destination is DERIVED from stored state rather than passed in, so this can't be called with
  // a mismatched (message, recipient) pair: a DM takes the row's recipient, a group takes the CURRENT
  // roster of the row's group. Both refuse rather than guess when that state is missing.
  //
  // Group editing needed no data migration — sendGroupMessage has minted and carried a shared
  // logicalId on every copy since M2; M4 only added the fan-out that names it.
  const editMessage = useCallback(async (logicalId: string, newText: string): Promise<EditResult> => {
    const pubkeyHex = nostrPubkeyHex
    if (!pubkeyHex || !logicalId) return { ok: false }
    const text = newText.trim()
    if (!text) return { ok: false }

    const row = messages.find(m => m.logicalId === logicalId)
    if (!row) return { ok: false }
    if (row.direction !== 'sent') return { ok: false }   // only my own message — see canEditMessage
    if (row.system) return { ok: false }                 // never a system notice

    // One past whatever has been applied. Derived from stored state, so a failed send that is
    // retried recomputes the SAME number rather than drifting; a stale read is a benign no-op
    // because the recipient's strictly-newer guard rejects a duplicate revision.
    const revision = nextRevision(messages, logicalId)

    // GROUP: fan the edit out to the roster, exactly as the message itself was fanned out.
    if (row.groupId) {
      // Gated to an ACTIVE group, matching leaveGroup/reinviteGroup: a group that is gone, declined
      // or left has no roster to address and is not a thread you should be editing into. (No UI can
      // reach this — a non-active group renders no thread — but the context must not depend on that.)
      const group = groups.find(g => g.id === row.groupId)
      if (!group || group.state !== 'active') return { ok: false }

      const provider = createMessagingProvider()
      if (!provider) return { ok: false }
      try {
        const { memberCount, membersReached } = await provider.sendGroupEdit(group.id, group.members, logicalId, text, revision)
        // TOTAL failure only. Reaching some members is the same best-effort outcome a group message
        // has: those members are already showing the new text, so refusing to apply locally would
        // put THIS device out of step with them. The shortfall is reported by the caller instead.
        const ok = editReachOk(memberCount, membersReached)
        if (!ok) return { ok, memberCount, membersReached }
        setMessages(prev => applyEditByLogicalId(pubkeyHex, prev, logicalId, text, revision, pubkeyHex))
        return { ok, memberCount, membersReached }
      } finally {
        provider.disconnect()
      }
    }

    // DM: single recipient, single relay-acceptance bit.
    const recipient = row.recipientPubkeyHex
    if (!recipient) return { ok: false }

    const provider = createMessagingProvider()
    if (!provider) return { ok: false }
    try {
      const ok = await provider.sendEdit(recipient, logicalId, text, revision)
      if (!ok) return { ok: false }
      setMessages(prev => applyEditByLogicalId(pubkeyHex, prev, logicalId, text, revision, pubkeyHex))
      return { ok: true }
    } finally {
      provider.disconnect()
    }
  }, [nostrPubkeyHex, messages, groups, createMessagingProvider])

  // Add or remove one of MY reactions on a message — DM or GROUP (reactions v1). SEND FIRST, apply
  // locally only once it got far enough, exactly as editMessage does and for the same reason: a
  // send that went nowhere must never leave this device showing a reaction nobody else will see.
  //
  // The destination is DERIVED from the stored row rather than passed in, so this cannot be called
  // with a mismatched (message, recipient) pair. Two differences from editMessage, both deliberate:
  //
  //   1. NOT MINE-ONLY. A reaction to a peer's message is the normal case, so there is no
  //      `direction === 'sent'` check. For a DM that means the wire destination is the OTHER party,
  //      whichever side of the row they sit on — hence the direction-aware recipient below rather
  //      than editMessage's flat `row.recipientPubkeyHex` (which is blank on a received row).
  //   2. A MAX-2 CHECK. The allowance is about stored state, so it belongs here; every receiving
  //      device enforces it again in applyReactionByLogicalId, which is the backstop for a peer
  //      that ignores it. A `remove` is never capped — it can only ever free an allowance slot.
  const reactMessage = useCallback(async (logicalId: string, emoji: string, action: 'add' | 'remove'): Promise<ReactResult> => {
    const pubkeyHex = nostrPubkeyHex
    if (!pubkeyHex || !logicalId || !emoji) return { ok: false }

    const row = messages.find(m => m.logicalId === logicalId)
    if (!row) return { ok: false }
    if (!isReactableTarget(row)) return { ok: false }    // text only in v1 — see isReactableTarget

    // Adding a third live reaction is refused before anything is published. Re-adding an emoji I
    // already hold is not a third: it costs no new slot, so it is allowed through as a seq bump.
    if (action === 'add') {
      const alreadyHeld = (row.reactions ?? []).some(r => r.by === pubkeyHex && r.emoji === emoji && !r.removed)
      if (!alreadyHeld && liveReactionCountBy(row, pubkeyHex) >= MAX_LIVE_REACTIONS_PER_REACTOR) return { ok: false }
    }

    // One past whatever has been applied for THIS (me, emoji) pair. Derived from stored state, so a
    // failed send that is retried recomputes the SAME number rather than drifting; a duplicate is a
    // benign no-op because every receiver's strictly-newer guard rejects it.
    const seq = nextReactionSeq(messages, logicalId, pubkeyHex, emoji)

    // GROUP: fan out to the roster, exactly as the message itself was fanned out.
    if (row.groupId) {
      // Gated to an ACTIVE group, matching editMessage/leaveGroup/reinviteGroup: a group that is
      // gone, declined or left has no roster to address and is not a thread you should be reacting
      // into. (No UI can reach this — a non-active group renders no thread — but the context must
      // not depend on that.)
      const group = groups.find(g => g.id === row.groupId)
      if (!group || group.state !== 'active') return { ok: false }

      const provider = createMessagingProvider()
      if (!provider) return { ok: false }
      try {
        const { memberCount, membersReached } = await provider.sendGroupReaction(group.id, group.members, logicalId, emoji, action, seq)
        // TOTAL failure only, on the same reasoning editReachOk was written for: reaching some
        // members is the ordinary best-effort outcome, and refusing locally would put this device
        // out of step with the members who did receive it.
        const ok = editReachOk(memberCount, membersReached)
        if (!ok) return { ok, memberCount, membersReached }
        setMessages(prev => applyReactionByLogicalId(pubkeyHex, prev, logicalId, emoji, action, seq, pubkeyHex))
        return { ok, memberCount, membersReached }
      } finally {
        provider.disconnect()
      }
    }

    // DM: the other party is the sender on a RECEIVED row and the recipient on a sent one. Reacting
    // to my own message in a notes-to-self thread addresses myself, which resolves to no recipient
    // and is refused — there is no second device to tell, and the local apply alone would be a lie
    // about what was published.
    const recipient = row.direction === 'received' ? row.senderPubkeyHex : row.recipientPubkeyHex
    if (!recipient || recipient === pubkeyHex) return { ok: false }

    const provider = createMessagingProvider()
    if (!provider) return { ok: false }
    try {
      const ok = await provider.sendReaction(recipient, logicalId, emoji, action, seq)
      if (!ok) return { ok: false }
      setMessages(prev => applyReactionByLogicalId(pubkeyHex, prev, logicalId, emoji, action, seq, pubkeyHex))
      return { ok: true }
    } finally {
      provider.disconnect()
    }
  }, [nostrPubkeyHex, messages, groups, createMessagingProvider])

  // Create a group locally (random 32-byte id, self included in the roster) and fan its definition
  // out to the other members so their clients learn it. Delivery is best-effort (relays-reached, not
  // a receipt) and never blocks creation. Members are already my contacts, so their gate accepts me.
  const createGroup = useCallback(async (name: string, memberHexes: string[]): Promise<Group> => {
    if (!nostrPubkeyHex) throw new Error('Wallet locked')
    const idBytes = crypto.getRandomValues(new Uint8Array(32))
    let id = ''
    for (const b of idBytes) id += b.toString(16).padStart(2, '0')
    // Roster includes me; dedup; drop blanks.
    const members = Array.from(new Set([nostrPubkeyHex, ...memberHexes].filter(Boolean)))
    // I created it → 'active' immediately, no self-gating. addOrUpdateGroup defaults new groups to
    // 'active', but set it on the literal too so the Group is well-formed at the call site.
    const group: Group = { id, name: name.trim(), members, createdAt: Date.now(), state: 'active' }
    setGroups(prev => addOrUpdateGroup(nostrPubkeyHex, prev, group, 'active'))
    const provider = createMessagingProvider()
    if (provider) {
      provider.sendGroupDefinition(group)
        .catch(() => { /* best-effort — members can also learn the group from the first message */ })
        .finally(() => provider.disconnect())
    }
    return group
  }, [nostrPubkeyHex, createMessagingProvider])

  // Delete a group locally (Phase 1 cleanup). Mirrors deleteConversation: tombstone the group's
  // message ids FIRST — persisted + in-memory — so the relay's backfill replay can't resurrect the
  // group via ensureGroup on the next unlock. Semantics are "forget until re-invited": a genuinely
  // NEW message (new event id, not tombstoned) later re-materialises the group.
  const deleteGroup = useCallback((groupId: string) => {
    const pubkeyHex = nostrPubkeyHex
    if (!pubkeyHex) return
    // Tombstone the group's MESSAGE ids so the backfill replay can't re-add them.
    const inGroup = messages.filter(m => m.groupId === groupId)
    const ids = inGroup.map(m => m.id)
    recordTombstones(pubkeyHex, ids)
    for (const id of ids) tombstonesRef.current.add(id)
    // Purge this group's cached image blobs (images M3). DELETE ONLY — leaveGroup and declineGroup
    // are non-destructive (they KEEP the messages, hidden by state, so a re-invite reads as old
    // thread + gap + new), and purging there would leave that preserved history with permanently
    // broken images.
    void deleteBlobs(pubkeyHex, mediaBlobKeys(inGroup))
    // A DEFINITION creates no stored message, so message-id tombstones can't cover it — suppress by
    // GROUP ID instead: onGroupDefinition drops a replayed def for a deleted, still-absent group.
    // Works for every group (legacy included); a genuine new message still re-materialises it.
    recordDeletedGroup(pubkeyHex, groupId)
    deletedGroupsRef.current.add(groupId)
    setGroups(prev => removeGroupFromStore(pubkeyHex, prev, groupId))
    setMessages(prev => deleteGroupMessages(pubkeyHex, prev, groupId))
  }, [nostrPubkeyHex, messages])

  // Accept a pending group invite (Phase A). pending → active. Its messages are already stored
  // (held only by derivation — active-group lists filter state === 'active'), so flipping the state
  // RELEASES them with no message mutation. Mirrors acceptContact for DMs. (M2 wires the UI button.)
  const acceptGroup = useCallback((groupId: string) => {
    const pubkeyHex = nostrPubkeyHex
    if (!pubkeyHex) return
    setGroups(prev => setGroupState(pubkeyHex, prev, groupId, 'active'))
  }, [nostrPubkeyHex])

  // Decline a pending group invite (Phase A). pending → 'left', a PERMANENT local suppression that is
  // stronger than deleteGroup's forget-until-re-invited: the 'left' record is KEPT (not removed), so
  // a new message stays held and a replayed def is ignored by first-def-wins. We ALSO reuse the
  // deletedGroups mechanism (not a duplicate of it) as belt-and-suspenders for the edge where the
  // record is a placeholder or otherwise absent — same suppression the delete fix relies on.
  // PHASE C (re-invite) TOUCHES THIS pairing — see the first-def-wins note in groupStore.
  const declineGroup = useCallback((groupId: string) => {
    const pubkeyHex = nostrPubkeyHex
    if (!pubkeyHex) return
    recordDeletedGroup(pubkeyHex, groupId)
    deletedGroupsRef.current.add(groupId)
    setGroups(prev => setGroupState(pubkeyHex, prev, groupId, 'left'))
  }, [nostrPubkeyHex])

  // Leave a group I'm actively in (Phase B). active → 'left', via declineGroup's EXACT three-step
  // suppression (persisted group-id record + in-memory set + kept-record state flip) — the same
  // "gone stays gone" guarantee, differing only in the entry state. Deliberately a sibling of
  // declineGroup rather than a shared helper: B-M2 adds a network side-effect to leave only, and
  // Phase C's re-invite lift will treat the two entry paths differently.
  //
  // NON-DESTRUCTIVE (like decline, unlike deleteGroup): the record and the group's messages are
  // KEPT — history is hidden by state at derivation, not erased — which also preserves `members`,
  // the roster B-M2's leave notice has to fan out to. deleteGroup would throw that roster away.
  //
  // B-M2 LAYERS HERE: (1) send the leave control message BEFORE calling this, while the provider
  // and roster are in hand, so other members render "X has left the chat"; (2) add a drop-at-ingest
  // check for 'left' groups in the onMessage group branch — peers still hold me in their roster, so
  // today a left group keeps accumulating invisible messages in localStorage.
  const leaveGroup = useCallback((groupId: string) => {
    const pubkeyHex = nostrPubkeyHex
    if (!pubkeyHex) return
    // Guarded to an ACTIVE entry state: leave is the active-group action, so it can't double as a
    // back-door state jump out of 'pending' (that path is declineGroup) or re-fire on a left group.
    // Read off `groups` (not inside the updater) to keep the updater pure, as deleteGroup does.
    if (groups.find(g => g.id === groupId)?.state !== 'active') return
    recordDeletedGroup(pubkeyHex, groupId)
    deletedGroupsRef.current.add(groupId)
    setGroups(prev => setGroupState(pubkeyHex, prev, groupId, 'left'))
  }, [nostrPubkeyHex, groups])

  // Re-invite (Phase C): fan the group's definition out again, marked. Members who still hold the
  // group ignore it (first-def-wins); a member in 'left' lifts to 'pending' and sees an invite card.
  // Best-effort and fire-and-forget, exactly like createGroup's original fan-out — the sender learns
  // nothing about who was actually re-invited, since relays-reached is not a delivery receipt.
  const reinviteGroup = useCallback((groupId: string, memberHexes?: string[]) => {
    const group = groups.find(g => g.id === groupId)
    if (!group || group.state !== 'active') return
    if (memberHexes && memberHexes.length === 0) return  // nothing selected — nothing to send
    const provider = createMessagingProvider()
    if (!provider) return
    // The def carries the FULL roster (group.members) in every case; memberHexes only narrows who it
    // is sent to. Never build the def from the selection — see sendGroupReinvite's contract.
    provider.sendGroupReinvite({ id: group.id, name: group.name, members: group.members }, memberHexes)
      .catch(() => { /* best-effort — same contract as the original definition fan-out */ })
      .finally(() => provider.disconnect())
  }, [groups, createMessagingProvider])

  // Read-only accessors onto the live provider for the connection/relay-health UI.
  const getRelayStates = useCallback((): RelayState[] => messagingProviderRef.current?.getRelayStates() ?? [], [])
  const reconnectAll = useCallback((): void => { messagingProviderRef.current?.reconnectAll() }, [])

  return (
    <Ctx.Provider value={{
      walletExists, wallet, address, nostrNpub, nostrPubkeyHex, scan, txHistory,
      messagingStatus, messages,
      generateMnemonic, createWallet, unlock, restore, lock, getMnemonic, rescan, recordSent,
      recordSentMessage, contacts, acceptContact, contactAddresses, setManualTariAddress,
      deleteConversation, editMessage, reactMessage, createMessagingProvider, getRelayStates, reconnectAll,
      balanceHidden, setBalanceHidden,
      groups, createGroup, deleteGroup, acceptGroup, declineGroup, leaveGroup, reinviteGroup,
    }}>
      {children}
    </Ctx.Provider>
  )
}
