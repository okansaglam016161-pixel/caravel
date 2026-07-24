import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react'
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
import { loadHistory, addSent, mergeReceived, type TxEntry, type NewSentParams } from '../crypto/txHistory'
import { NostrMessagingProvider } from '../messaging/NostrMessagingProvider'
import type { MessagingProvider, MessagingConnectionStatus, CaravelMessage, RelayState } from '../messaging/types'
import { DEFAULT_RELAYS } from '../config/relays'

// ── Scan state ────────────────────────────────────────────────────────────────

export interface ScanState {
  status: 'idle' | 'scanning' | 'done' | 'error'
  balance: bigint | null
  utxos: ScannedUtxo[]
  progress: ScanProgress
  totalScanned: number
  capped: boolean
  error: string
}

const SCAN_IDLE: ScanState = {
  status: 'idle',
  balance: null,
  utxos: [],
  progress: { scanned: 0, found: 0 },
  totalScanned: 0,
  capped: false,
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
  txHistory: TxEntry[]
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
  /** Per-relay connection state for dev/debug display. */
  relayStates: RelayState[]
  /** In-memory received messages, cleared on lock. */
  messages: CaravelMessage[]
  /** Factory: returns a ready-to-use MessagingProvider backed by the current identity,
   *  or null if the wallet is locked. The secret key stays inside the closure — callers
   *  receive a working provider but never see the raw key. */
  createMessagingProvider: () => MessagingProvider | null
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
  const [txHistory, setTxHistory] = useState<TxEntry[]>([])

  // Ref holds the AbortController for the active scan — replaced each run
  const scanAbortRef = useRef<AbortController | null>(null)
  // Nostr private key: held in a ref, never in state, wiped on lock
  const nostrSecretKeyRef = useRef<string | null>(null)
  // Persistent messaging provider — held in a ref so it survives re-renders without
  // triggering them; state below is what actually drives UI updates.
  const messagingProviderRef = useRef<NostrMessagingProvider | null>(null)
  const [messagingStatus, setMessagingStatus] = useState<MessagingConnectionStatus>('disconnected')
  const [messages, setMessages] = useState<CaravelMessage[]>([])
  const [relayStates, setRelayStates] = useState<RelayState[]>([])

  const startScan = useCallback((w: SecretKeyWallet, addr: string) => {
    // Cancel any prior scan
    scanAbortRef.current?.abort()
    const ctrl = new AbortController()
    scanAbortRef.current = ctrl

    const viewSecret = w.getViewOnlySecret()
    if (!viewSecret) return  // no view key — can't scan

    setScan(prev => ({
      ...SCAN_IDLE,
      status: 'scanning',
      // Carry over previous balance while re-scanning so UI doesn't blank
      balance: prev.balance,
      utxos: prev.utxos,
    }))

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
        capped: result.capped,
        error: '',
      })
      setTxHistory(prev => mergeReceived(addr, prev, result.utxos))
    }).catch((err: unknown) => {
      if (ctrl.signal.aborted) return
      setScan(prev => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }))
    })
  }, [])

  // Materialize a wallet object + resolve its address into state, then auto-scan
  const materialize = useCallback(async (w: SecretKeyWallet) => {
    const addr = await w.getAddress()
    setWallet(w)
    setAddress(addr)
    setTxHistory(loadHistory(addr))
    startScan(w, addr)
  }, [startScan])

  const generateMnemonic = useCallback(() => createMnemonic(), [])

  // Tears down any existing provider, starts a new one with the given identity, and
  // wires status + message callbacks into React state. Returns immediately — relay
  // connections happen in the background so unlock never waits for the network.
  const startMessaging = useCallback((secretHex: string, pubkeyHex: string) => {
    messagingProviderRef.current?.disconnect()
    const provider = new NostrMessagingProvider(secretHex, pubkeyHex, DEFAULT_RELAYS)
    messagingProviderRef.current = provider
    setMessagingStatus('connecting')
    provider.subscribe(
      (msg) => setMessages(prev => [...prev, msg]),
      (status) => {
        // Guard against stale callbacks firing after lock() replaces or clears the provider
        if (messagingProviderRef.current !== provider) return
        setMessagingStatus(status)
        setRelayStates(provider.getRelayStates())
      }
    )
    // Set initial relay states synchronously — subscribe() already set status to 'connecting'
    setRelayStates(provider.getRelayStates())
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
    setMessagingStatus('disconnected')
    setMessages([])
    setRelayStates([])
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
    if (wallet && address) startScan(wallet, address)
  }, [wallet, address, startScan])

  const recordSent = useCallback((params: NewSentParams) => {
    if (!address) return
    setTxHistory(prev => addSent(address, prev, params))
  }, [address])

  // Factory: constructs a MessagingProvider backed by the current Nostr identity.
  // The secret key is captured from the ref at call time — it never appears on the
  // context value, and callers receive a working provider without ever seeing the key.
  const createMessagingProvider = useCallback((): MessagingProvider | null => {
    const secretHex = nostrSecretKeyRef.current
    if (!secretHex || !nostrPubkeyHex) return null
    return new NostrMessagingProvider(secretHex, nostrPubkeyHex, DEFAULT_RELAYS)
  }, [nostrPubkeyHex])

  return (
    <Ctx.Provider value={{
      walletExists, wallet, address, nostrNpub, nostrPubkeyHex, scan, txHistory,
      messagingStatus, messages, relayStates,
      generateMnemonic, createWallet, unlock, restore, lock, getMnemonic, rescan, recordSent,
      createMessagingProvider,
    }}>
      {children}
    </Ctx.Provider>
  )
}
