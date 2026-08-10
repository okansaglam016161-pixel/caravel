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
import { loadMessages, addReceivedMessage, addSentMessage, deletePeerMessages, deleteGroupMessages } from '../messaging/messageStore'
import { loadGroups, addOrUpdateGroup, ensureGroup, setGroupState, deleteGroup as removeGroupFromStore } from '../messaging/groupStore'
import { loadDeletedGroupIdSet, recordDeletedGroup } from '../messaging/deletedGroupStore'
import type { Group } from '../messaging/types'
import { loadTombstoneIdSet, recordTombstones } from '../messaging/tombstoneStore'
import { removeResolvedAmounts } from '../messaging/paymentResolutionStore'
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
  const [messagingStatus, setMessagingStatus] = useState<MessagingConnectionStatus>('disconnected')
  const [balanceHidden, setBalanceHidden] = useState(false)
  const [messages, setMessages] = useState<CaravelMessage[]>([])
  const [contacts, setContacts] = useState<ContactMap>({})
  // Per-contact Tari addresses (manual or verified-exchanged). Owned here because the inbound
  // exchanged address arrives in the subscription callback (M9.0d).
  const [contactAddresses, setContactAddresses] = useState<TariAddressMap>({})

  // Keep the gate ref in sync so the subscribe closure sees current contacts (state would be stale).
  useEffect(() => { contactsRef.current = new Set(Object.keys(contacts)) }, [contacts])

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
    setGroups(loadGroups(pubkeyHex))
    // Seed the "known peers" set from persisted history — anyone we already have a message with is
    // NOT a new peer (so their next inbound never gets mis-flagged as a pending request).
    knownPeersRef.current = new Set(
      loaded.map(m => (m.direction === 'received' ? m.senderPubkeyHex : m.recipientPubkeyHex)).filter(Boolean)
    )
    // Load deleted-message tombstones (pruned) so the relay's 2-day backfill can't resurrect them.
    tombstonesRef.current = loadTombstoneIdSet(pubkeyHex)
    // Load deleted-group ids so onGroupDefinition can suppress a deleted group's replayed def.
    deletedGroupsRef.current = loadDeletedGroupIdSet(pubkeyHex)
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
      (senderPubkeyHex, def) => {
        if (!knownPeersRef.current.has(senderPubkeyHex) && !contactsRef.current.has(senderPubkeyHex)) return
        setGroups(prev => {
          // Present-check: drop a def that would RESURRECT a deleted group — one that is absent
          // locally AND whose id is in the deleted-groups set (a stale backfill replay). A genuine
          // new message re-materialises the group (ungated, in the onMessage branch); once the group
          // is present again, a replayed def flows through here and re-names/re-rosters it.
          if (!prev.some(g => g.id === def.id) && deletedGroupsRef.current.has(def.id)) return prev
          // Invite-gating (Phase A): a def for a BRAND-NEW group lands as 'pending' (held until the
          // user accepts). A def for an existing group is ignored by first-def-wins / preserves its
          // state (a placeholder upgrade keeps 'pending'/'left'), so initialState only bites on new ids.
          return addOrUpdateGroup(pubkeyHex, prev, def, 'pending')
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

    // 1) Tombstone FIRST — persist + block the live subscription immediately.
    recordTombstones(pubkeyHex, ids)
    for (const id of ids) tombstonesRef.current.add(id)

    // 2) THEN clear the stores this context owns. Also forget the peer entirely (contact record +
    //    known-peers set) so a later message from them arrives as a FRESH pending request — this
    //    unifies delete and decline (hide-and-forget).
    removeResolvedAmounts(pubkeyHex, utxoIds)
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
    const ids = messages.filter(m => m.groupId === groupId).map(m => m.id)
    recordTombstones(pubkeyHex, ids)
    for (const id of ids) tombstonesRef.current.add(id)
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

  // Read-only accessors onto the live provider for the connection/relay-health UI.
  const getRelayStates = useCallback((): RelayState[] => messagingProviderRef.current?.getRelayStates() ?? [], [])
  const reconnectAll = useCallback((): void => { messagingProviderRef.current?.reconnectAll() }, [])

  return (
    <Ctx.Provider value={{
      walletExists, wallet, address, nostrNpub, nostrPubkeyHex, scan, txHistory,
      messagingStatus, messages,
      generateMnemonic, createWallet, unlock, restore, lock, getMnemonic, rescan, recordSent,
      recordSentMessage, contacts, acceptContact, contactAddresses, setManualTariAddress,
      deleteConversation, createMessagingProvider, getRelayStates, reconnectAll,
      balanceHidden, setBalanceHidden,
      groups, createGroup, deleteGroup, acceptGroup, declineGroup, leaveGroup,
    }}>
      {children}
    </Ctx.Provider>
  )
}
