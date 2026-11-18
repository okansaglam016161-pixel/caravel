import { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect, type ReactNode, type Dispatch, type SetStateAction } from 'react'
import { type SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import {
  encryptMnemonic,
  decryptMnemonic,
  hasStoredWallet,
  loadStoredWallet,
  markScheme,
  saveStoredWallet,
} from '../crypto/walletCrypto'
import { clearStoreKey, setStoreKey } from '../crypto/sessionKey'
import {
  type DerivationScheme,
  type WalletIdentity,
  deriveIdentity,
  resolveScheme,
} from '../crypto/derivation'
import { createWalletSeed } from 'tari-cipherseed'
import { scanWallet, type ScannedUtxo, type ScanProgress } from '../crypto/walletScanner'
import { loadExcludedIds, loadSpentOutputs, heldOutOfBalance, type ExcludedValue, type HeldSummary } from '../crypto/spentOutputs'
import { sweepLocks } from '../crypto/lockSweep'
import { repairShapeBreakSpends } from '../crypto/spentRepair'
import { loadHistory, addSent, type SentEntry, type NewSentParams } from '../crypto/txHistory'
import { recoverAccountAddress } from '../crypto/accountRecovery'
import { fetchRevealedBalance } from '../crypto/revealedBalance'
import {
  advanceAll, anySettling, acknowledged, isAccountedFor, withSettle,
  type PendingSettle, type SettleEvidence, type SideBalances,
} from './settle'

// ── Scan state ────────────────────────────────────────────────────────────────

export interface ScanState {
  status: 'idle' | 'scanning' | 'done' | 'error'
  balance: bigint | null
  utxos: ScannedUtxo[]
  progress: ScanProgress
  totalScanned: number
  /** True when the indexer capped the returned set at its limit — balance may be understated. */
  incomplete: boolean
  /**
   * Our own already-spent outputs that `/utxos` was STILL listing on this scan, with their value.
   *
   * Evidence about the INDEXER rather than about the balance — these are deliberately absent from
   * `utxos` and from `balance`. Two consumers: reconciliation (useSpentOutputs) and the held-back
   * total below.
   */
  excludedPresent: ExcludedValue[]
  error: string
  /** Which refresh produced `balance`. Preserved while a newer scan runs. See READ GENERATIONS. */
  generation: number
}

/**
 * How often to rescan while a settle is waiting.
 *
 * Unchanged from the per-view loops this replaces. The indexer lag is 60–90s and the deadline is
 * 150s, so this is roughly twenty chances to observe the change — frequent enough that the balance
 * appears promptly, slow enough that a full stealth scan has time to finish before the next starts.
 */
const SETTLE_POLL_MS = 8_000

// ── READ GENERATIONS ─────────────────────────────────────────────────────────
//
// A number identifying WHICH REFRESH produced a balance, stamped onto each reading when its read
// completes. It exists so the two balances can be compared for FRESHNESS, not just for value.
//
// The two reads are wildly different in cost and are not always even started together. The public
// balance is two keyed substate lookups, consensus-fresh, back in milliseconds. The private balance
// is a global /utxos listing that trails consensus by 60–90 seconds, then trial-decrypts every row.
// And on unlock they are deliberately staggered: the scan starts at once, while the revealed read
// waits for account recovery to resolve first.
//
// So "both balances are ready" has never meant "both balances describe the same moment".
//
// BE PRECISE ABOUT WHAT THIS CATCHES. A generation identifies the REFRESH a figure was requested
// by, not the chain state it came back with. Two reads from one rescan share a stamp even when
// their data is a minute apart in ledger time, because the difference between them is LAG, not
// latency. It therefore does NOT catch the fresh-public/stale-private pair right after a move —
// that is handled by the settle watches, and by `settling` carrying no number at all.
//
// What it does catch is the held-value window: the public row goes on showing its previous figure
// while a newer read is in flight, and that figure keeps the generation it was actually read at,
// so a scan completing one generation later cannot be added to it. No transaction need be pending
// for that to happen, which is why nothing else covers it. See computeTotal.

const SCAN_IDLE: ScanState = {
  status: 'idle',
  balance: null,
  utxos: [],
  progress: { scanned: 0, found: 0 },
  totalScanned: 0,
  incomplete: false,
  excludedPresent: [],
  error: '',
  generation: 0,
}

// ── Revealed (public) balance state ───────────────────────────────────────────

/**
 * The REVEALED balance is tracked SEPARATELY from the scan, not folded into ScanState, for two
 * reasons that both matter to the user:
 *
 *   1. It must never delay the private balance. They are different reads against different
 *      substates; the hero number renders as soon as the scan finishes regardless of what the
 *      revealed read is doing.
 *   2. It has its own failure mode. A revealed read that fails must not put the scan into 'error'
 *      and blank a perfectly good private balance.
 *
 * 'unavailable' is deliberately NOT 'zero'. The read throws only on a network/indexer failure —
 * every structural absence already resolves to 0n inside readRevealedBalance — so reaching this
 * state means we genuinely do not know, and the UI must say so rather than draw a confident 0.
 */
export interface RevealedState {
  status: 'idle' | 'loading' | 'done' | 'unavailable'
  amount: bigint | null
  /** Which refresh produced `amount`. Preserved while a newer read runs. See READ GENERATIONS. */
  generation: number
}

const REVEALED_IDLE: RevealedState = { status: 'idle', amount: null, generation: 0 }

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletCtx {
  walletExists: boolean
  wallet: SecretKeyWallet | null
  address: string | null
  scan: ScanState
  /**
   * What this wallet's own spend record is currently holding out of the displayed private balance.
   *
   * ZERO IS THE NORMAL STATE, and a non-zero `totalMicrotari` is usually normal too — a spend in
   * flight holds its inputs back for a minute or so, which is correct and needs no explanation.
   *
   * `unresolved` IS THE ONE TO SHOW. It is the subset that can no longer be explained as a
   * transaction in flight: locks the sweep has repeatedly failed to settle against the chain. That
   * is the state that silently understated a real wallet by 1110 tTARI, and the whole reason this
   * figure is computed rather than left implicit. See crypto/spentOutputs.heldOutOfBalance.
   */
  held: HeldSummary
  /** The REVEALED (public) balance — read-only in M1. Independent of `scan`; see RevealedState. */
  revealed: RevealedState
  txHistory: SentEntry[]
  /**
   * Committed transactions whose effect has not shown up in the balances yet.
   *
   * WALLET STATE, NOT SCREEN STATE. It outlives the modal that started it — that is the entire
   * point. See src/context/settle.ts for why it moved here.
   */
  settles: PendingSettle[]
  /** Any settle still waiting. What the total consults before claiming a figure is fact. */
  isSettling: boolean
  /**
   * A committed transaction of ours passed its deadline and the balances STILL do not reflect it.
   *
   * Nothing is polling for it any more, so this is not "in flight" — it is "we know a figure is
   * missing and only a Refresh will find it". The total reports it as unreadable rather than
   * summing a pair it knows is incomplete. Clears by itself as soon as a read shows both sides
   * caught up.
   */
  settleLagged: boolean
  /** Start watching a committed transaction. Replaces any entry for the same txId. */
  beginSettle: (entry: Omit<PendingSettle, 'status' | 'delta'>) => void
  /**
   * The user has seen this transaction's outcome; stop tracking it.
   *
   * A STILL-SETTLING entry is deliberately NOT dropped — pressing Done finishes the screen, not
   * the transaction, and the overview behind it needs the poll to carry on correcting itself.
   */
  acknowledgeSettle: (txId: string) => void
  /**
   * Generate a fresh 24-word Tari CipherSeed recovery phrase, for a new wallet.
   * ASYNC — enciphering runs Argon2d, so show a busy state over it.
   */
  createRecoveryPhrase: () => Promise<string>
  /** Encrypt phrase with password, save to localStorage, unlock in memory. Always CipherSeed. */
  createWallet: (mnemonic: string, password: string) => Promise<void>
  /** Decrypt stored wallet with password, load into memory. Scheme comes from the stored marker. */
  unlock: (password: string) => Promise<void>
  /**
   * Overwrite stored wallet from an existing phrase + new password, then unlock.
   * `scheme` must come from detectScheme() in the restore UI — see restore() for why.
   */
  restore: (mnemonic: string, password: string, scheme: DerivationScheme) => Promise<void>
  /** Clear wallet from memory (wallet remains in localStorage; returns to unlock screen). */
  lock: () => void
  /** Decrypt and return the stored mnemonic — requires the user's password. */
  getMnemonic: (password: string) => Promise<string>
  /** Re-run the UTXO scan (cancels any in-progress scan). */
  /** The full wallet scan: TARI private and public. Resolves once both have settled. */
  rescan: () => Promise<void>
  /** Record a sent transaction in persisted history. */
  recordSent: (params: NewSentParams) => void
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
  const [walletExists, setWalletExists] = useState(() => hasStoredWallet())
  const [scan, setScan] = useState<ScanState>(SCAN_IDLE)
  const [revealed, setRevealed] = useState<RevealedState>(REVEALED_IDLE)
  // Generation counter, the revealed-read equivalent of scanAbortRef: a read that resolves after a
  // lock or a newer read must not write its result into state.
  const revealedGenRef = useRef(0)
  /**
   * The shared read generation — see READ GENERATIONS above.
   *
   * Distinct from `revealedGenRef`, which exists to DISCARD a superseded revealed read. This one is
   * never used to discard anything; it only labels which refresh a surviving reading belongs to.
   */
  const readGenRef = useRef(0)
  const [txHistory, setTxHistory] = useState<SentEntry[]>([])

  // Ref holds the AbortController for the active scan — replaced each run
  const scanAbortRef = useRef<AbortController | null>(null)
  const [balanceHidden, setBalanceHidden] = useState(false)

  // `walletAddress` is passed in rather than awaited from `w` — the spend record is keyed per
  // identity and this must not become async, since it runs synchronously from unlock and refresh.
  const startScan = useCallback((w: SecretKeyWallet, walletAddress: string, generation: number) => {
    // Cancel any prior scan
    scanAbortRef.current?.abort()
    const ctrl = new AbortController()
    scanAbortRef.current = ctrl

    const viewSecret = w.getViewOnlySecret()
    if (!viewSecret) return Promise.resolve()  // no view key — can't scan

    // Clean slate — do NOT carry over the previous scan's balance/utxos. Carrying them produced the
    // misleading "N owned" against a stale/zero balance; a fresh scan starts blank and fills in.
    //
    // The GENERATION is the exception, and carrying it is deliberate: it describes the last reading
    // we actually have, and there is no reading at all until this scan finishes. Stamping the new
    // generation here would claim this scan's freshness for a balance of `null`.
    setScan(prev => ({ ...SCAN_IDLE, status: 'scanning', generation: prev.generation }))

    // WHAT THIS WALLET HAS ALREADY SPENT, read fresh on every scan so a spend that happened since
    // the last one is excluded immediately rather than at the next unlock. See crypto/spentOutputs.
    const excluded = loadExcludedIds(walletAddress)

    // Returned so a caller can wait for the whole refresh (rescan's promise); nothing else awaits it.
    return scanWallet(
      viewSecret,
      (progress) => {
        if (ctrl.signal.aborted) return
        setScan(prev => ({ ...prev, progress }))
      },
      ctrl.signal,
      // `walletAddress` enables by-id recovery of our own outputs that no listing returned —
      // see crypto/ownedFeed. Without it the scan is blind to a coin the indexers dropped.
      { excluded, walletAddress },
    ).then(result => {
      if (ctrl.signal.aborted) return
      setScan({
        status: 'done',
        balance: result.balance,
        utxos: result.utxos,
        progress: { scanned: result.totalScanned, found: result.utxos.length },
        totalScanned: result.totalScanned,
        incomplete: result.incomplete,
        excludedPresent: result.excludedPresent,
        error: '',
        generation,
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

  /**
   * Read the REVEALED (public) balance. Runs alongside startScan on the same triggers, but entirely
   * independently — it never blocks the private balance and never fails it.
   *
   * Not aborted, generation-guarded: the read is two short GETs with nothing to cancel meaningfully,
   * so a superseded one is simply not allowed to write its result.
   */
  const startRevealedRead = useCallback((walletAddress: string, generation: number) => {
    const gen = ++revealedGenRef.current
    // Same rule as the scan: the previous reading's generation is kept while a newer read runs,
    // because until it resolves there is no reading of this generation to describe.
    setRevealed(prev => ({ status: 'loading', amount: null, generation: prev.generation }))
    return fetchRevealedBalance(walletAddress)
      .then(amount => {
        if (revealedGenRef.current !== gen) return
        setRevealed({ status: 'done', amount, generation })
      })
      .catch(() => {
        if (revealedGenRef.current !== gen) return
        // Network/indexer failure only — structural absence already resolved to 0n upstream. We do
        // not know the balance, so we say so; drawing 0 here would be a confident lie.
        setRevealed({ status: 'unavailable', amount: null, generation })
      })
  }, [])

  // Materialize a wallet object + resolve its address into state, then auto-scan
  const materialize = useCallback(async (w: SecretKeyWallet) => {
    const addr = await w.getAddress()
    setWallet(w)
    setAddress(addr)
    setTxHistory(loadHistory(addr))
    // ONE generation for both reads, even though they start at different moments — they are two
    // halves of the same refresh, and that is exactly what the stamp has to express. Staggering
    // them under separate generations would make an unlock permanently mismatched.
    // ── RESOLVE STRANDED LOCKS BEFORE THE FIRST BALANCE IS READ ──────────────
    //
    // A previous session can end mid-spend: the poll gives up at ~30s against a 60-90s listing
    // lag, so a transaction that committed normally reports Timeout, and Stage 1 leaves its
    // inputs locked. Nothing used to revisit them, so the balance came back understated by
    // whatever those coins were worth and stayed that way.
    //
    // Awaited, not fired and forgotten, so the FIRST figure the user sees is already correct
    // rather than being quietly wrong and then jumping. It costs nothing in the ordinary case —
    // no locks means no requests at all — and crypto/lockSweep carries its own per-request
    // timeout, so a dead indexer cannot hang an unlock. A failure here must never block one:
    // an unresolved lock is a wrong number, and a thrown unlock is no wallet.
    await sweepLocks(addr).catch(() => undefined)
    // Then give back any live coin the 0.47 shape change made the sweep condemn as spent (once per
    // wallet; crypto/spentRepair). Before the balance, for the same reason as the sweep above.
    await repairShapeBreakSpends(addr).catch(() => undefined)

    const generation = ++readGenRef.current
    startScan(w, addr, generation)
    // Recover the account address BEFORE reading the revealed balance — the read needs it, and a
    // wallet that claimed before M1 (or was restored on another device) has none stored. The probe
    // short-circuits without touching the network when an address is already known, so this is a
    // no-op for every wallet after its first unlock. It cannot fail the read: recovery resolving to
    // null simply leaves the balance at 0, which is what it would have been anyway.
    void recoverAccountAddress(w, addr).finally(() => {
      startRevealedRead(addr, generation)
    })
  }, [startScan, startRevealedRead])

  // Async now: CipherSeed encipherment runs Argon2d before the words exist. Callers show a busy
  // state over it — the phrase-reveal screen cannot render until this resolves.
  const createRecoveryPhrase = useCallback(async () => (await createWalletSeed()).mnemonic, [])

  // The one place a derived identity becomes the live session. All three entry points below
  // (create, unlock, restore) differ only in where the phrase came from and how its scheme was
  // established; from here on they are identical, so they share this.
  const adoptIdentity = useCallback(async (identity: WalletIdentity) => {
    await materialize(identity.wallet)
  }, [materialize])

  // New wallets are always CipherSeed — Tari's own format, importable by official Tari wallets.
  const createWallet = useCallback(async (mnemonic: string, password: string) => {
    // ── DERIVE BEFORE OVERWRITING STORAGE, exactly as restore does ─────────────
    //
    // `saveStoredWallet` REPLACES this device's only wallet record — Caravel stores one — and this
    // used to run before anything had been derived. So a phrase that could not be derived, on the
    // path that creates a wallet, would have destroyed the record it was about to replace and left
    // the device with neither. Nothing about the old order was chosen; it was simply written before
    // creating was reachable from the unlock screen, where there is something to lose.
    //
    // The identity has to be computed anyway — the store key comes out of it, derived from this
    // wallet's own seed — so ordering it first costs nothing and makes a failed create a no-op.
    const identity = await deriveIdentity(mnemonic, 'cipherseed')
    saveStoredWallet(await encryptMnemonic(mnemonic, password, 'cipherseed'))
    // Set before adoptIdentity, which is where store reads begin; only setWalletExists sits
    // between, and it touches no store.
    setStoreKey(identity.storeKey)
    setWalletExists(true)
    await adoptIdentity(identity)
  }, [adoptIdentity])

  const unlock = useCallback(async (password: string) => {
    const stored = loadStoredWallet()
    if (!stored) throw new Error('No wallet stored')
    const mnemonic = await decryptMnemonic(stored, password)

    // Trusted lookup, not detection: we wrote this record, so we read what we recorded. An existing
    // BIP-39 wallet therefore never touches the CipherSeed path and pays none of its cost.
    const { scheme, markerWasMissing } = resolveScheme(stored, mnemonic)
    if (markerWasMissing) saveStoredWallet(markScheme(stored, scheme))

    // THE IDENTITY FIRST, and the store key falls out of it at no extra cost: the seed material it
    // hashes — CipherSeed entropy, or the 64-byte BIP-39 seed — is already computed in there.
    //
    // THE PASSWORD DOES NOT PARTICIPATE, which is the substance of the change. A store key derived
    // from the password moved whenever the password did, and restore sets a new one every time, so a
    // wallet coming back could no longer open the stores it had written itself. It also means unlock
    // now does ONE key derivation rather than two: the 600 000-iteration PBKDF2 that proved the
    // password in decryptMnemonic above is the only one left.
    //
    // Set BEFORE adoptIdentity — the invariant sessionKey states, and where store reads begin.
    // Nothing between these two lines reads a store.
    const identity = await deriveIdentity(mnemonic, scheme)
    setStoreKey(identity.storeKey)

    await adoptIdentity(identity)
  }, [adoptIdentity])

  // `scheme` comes from the restore UI, which detects it from the phrase and — in the vanishingly
  // rare ambiguous case — has the user confirm. It is passed in rather than re-derived here so the
  // decision is made once, in front of the person who knows which wallet they meant.
  const restore = useCallback(async (mnemonic: string, password: string, scheme: DerivationScheme) => {
    // Derive BEFORE overwriting storage: restore replaces the stored wallet outright, so a phrase
    // that fails to derive must not be allowed to destroy the record it was going to replace.
    const identity = await deriveIdentity(mnemonic, scheme)
    saveStoredWallet(await encryptMnemonic(mnemonic, password, scheme))
    // THE KEY COMES FROM THE PHRASE THAT WAS JUST TYPED, so restoring a wallet re-derives exactly the
    // key its own stores were sealed with, and restoring a DIFFERENT wallet cannot reach them at all —
    // two wallets on one device now have unrelated keys because their SEEDS are unrelated, with no
    // shared parameter to couple or to lose.
    //
    // THIS IS THE LINE THE OLD DESIGN GOT WRONG. It minted a fresh random salt here, which silently
    // stranded every store the previous wallet had written — undecryptable, unrecoverable, reported
    // nowhere — and did the same to THIS wallet's own stores if it had ever been restored before.
    setStoreKey(identity.storeKey)
    setWalletExists(true)
    await adoptIdentity(identity)
  }, [adoptIdentity])

  const lock = useCallback(() => {
    scanAbortRef.current?.abort()
    scanAbortRef.current = null
    setScan(SCAN_IDLE)
    // A settle belongs to the identity that committed it. Carrying one across a lock would poll
    // the next wallet's balances against the previous wallet's baselines.
    setSettles([])
    // Bump the generation so an in-flight read cannot land on the locked (or next) identity.
    revealedGenRef.current++
    setRevealed(REVEALED_IDLE)
    setWallet(null)
    setAddress(null)
    setTxHistory([])
    // The wallet's store key belongs to the unlocked session and leaves with it. (The chat key is
    // the chat identity's — see ChatContext.)
    clearStoreKey()
  }, [])

  const getMnemonic = useCallback(async (password: string) => {
    const stored = loadStoredWallet()
    if (!stored) throw new Error('No wallet stored')
    return decryptMnemonic(stored, password)
  }, [])

  const rescan = useCallback(async () => {
    if (wallet && address) {
      // Both reads carry the SAME generation. That is what lets the total tell "these two figures
      // describe one moment" from "one of them has moved on and the other has not yet".
      const generation = ++readGenRef.current
      // Resolves when both reads have settled — success or failure — so a caller can show a
      // refresh as running until it really is done. Callers that only kick it off ignore the
      // promise, as before.
      await Promise.all([
        startScan(wallet, address, generation),
        startRevealedRead(address, generation),
      ])
    }
  }, [wallet, address, startScan, startRevealedRead])

  // ══ SETTLE — one list, one loop ═════════════════════════════════════════════
  //
  // See src/context/settle.ts for why this is here rather than in the modal. In short: a committed
  // transaction is not a property of a screen, and tying the poll to a view's step meant Done
  // switched it off and closing the modal destroyed it outright.

  const [settles, setSettles] = useState<PendingSettle[]>([])

  const beginSettle = useCallback((entry: Omit<PendingSettle, 'status' | 'delta'>) => {
    setSettles(prev => withSettle(prev, { ...entry, status: 'settling', delta: null }))
  }, [])

  const acknowledgeSettle = useCallback((txId: string) => {
    setSettles(prev => acknowledged(prev, txId))
  }, [])

  /**
   * The two balances as a watch sees them.
   *
   * `null` is "not known yet" and never zero, in both directions — a loading scan and a failed
   * revealed read are the same claim here: nothing to compare against.
   */
  const settleBalances: SideBalances = useMemo(() => ({
    private: scan.balance,
    public: revealed.status === 'done' ? revealed.amount : null,
  }), [scan.balance, revealed])

  /**
   * What a settle is judged against — the balances AND the outputs this wallet can see.
   *
   * THE OWNED SET IS THE PART THAT MATTERS. A settle used to complete when a balance moved in the
   * right direction, and the spend record made that fire instantly: a send excludes its inputs on
   * submission, so the private figure drops before the change output is listed, and "did it fall?"
   * said yes while the number was short by the change. Judging on "are my new outputs here yet"
   * cannot be fooled that way. See src/context/settle.ts.
   */
  const settleEvidence: SettleEvidence = useMemo(() => ({
    balances: settleBalances,
    ownedIds: new Set(scan.utxos.map(u => u.id)),
    // A scan in flight carries an empty owned set and a truncated one carries a partial set, so
    // neither may be read as "my change has not arrived".
    scanComplete: scan.status === 'done' && !scan.incomplete,
  }), [settleBalances, scan.utxos, scan.status, scan.incomplete])

  // Evaluate on EVERY change, not only on a tick: the scan that finds the change may land between
  // ticks, and waiting up to a full interval to notice would be needless delay. advanceAll returns
  // the same array when nothing moved, so this is a no-op re-render otherwise.
  useEffect(() => {
    setSettles(prev => advanceAll(prev, settleEvidence, Date.now()))
  }, [settleEvidence])

  // Derived from the scan's own measurement, not from the store: an exclusion only subtracts from
  // a balance while the indexer is still listing the coin, and `excludedPresent` is exactly that.
  const held = useMemo(
    () => heldOutOfBalance(loadSpentOutputs(address ?? ''), scan.excludedPresent),
    [address, scan.excludedPresent],
  )

  const isSettling = anySettling(settles)
  // Deliberately measured against the BALANCES, not against the status: a lagged entry is only
  // still a problem for the total while the figures genuinely fail to reflect THAT transaction.
  // Asking `some(lagged) && anythingUnaccountedFor` would be a different, looser question — a
  // resolved lagged entry beside an unrelated settling one would answer it yes.
  const settleLagged = settles.some(e => e.status === 'lagged' && !isAccountedFor(e, settleEvidence))

  // The only poll in the app. It rescans on a fixed cadence while anything is waiting, and
  // re-evaluates on each tick so a passed deadline resolves even when no balance ever changed.
  //
  // `rescan` is held in a ref rather than listed as a dependency: it is a useCallback over `wallet`
  // and `address`, and an identity change would tear the interval down and re-create it, resetting
  // the timer. With frequent re-renders that is a poll loop that never polls.
  const rescanRef = useRef(rescan)
  rescanRef.current = rescan

  // (Chat payments used to trigger a rescan here when one arrived. They go through Sapient now and
  // never pay into this built-in wallet, so nothing here listens to chat any more.)

  // ── WHY THE POLL SKIPS A SCAN ALREADY IN FLIGHT ─────────────────────────────
  //
  // startScan ABORTS whatever is running before it begins, and an aborted scan writes nothing —
  // both its .then and its .catch return early on `signal.aborted`. So the state left behind is the
  // one the NEW scan just set: balance null, status 'scanning'.
  //
  // A scan can take far longer than this interval. The fetch alone allows FETCH_TIMEOUT_MS ×
  // FETCH_RETRIES plus backoff — around 47s against a slow indexer — before it even throws, and the
  // trial-decrypt runs after that. Polling an 8s rescan into a 47s scan aborted and restarted it
  // about six times over, so it never once finished: the balance stayed null and the wallet sat on
  // "scanning" until the deadline. Worse, the watch NEEDS that balance to settle — settleAction
  // requires `balance !== null` — so the poll was destroying the very reading it was polling for.
  //
  // This is the residue of a fix already made. settle.ts records that the hook version ran three
  // loops "each firing the global rescan() on its own timer, so scans overlapped and invalidated one
  // another"; collapsing them to one loop cut the RATE of thrashing but not the mechanism, and one
  // loop still outruns one slow scan.
  //
  // Skipping is safe because the guard can only ever be temporarily true: a scan that is not
  // aborted always leaves 'scanning' — .then sets 'done', .catch sets 'error', and the retry loop
  // terminates inside scanWallet. setScan re-renders, the ref updates, the next tick rescans.
  //
  // It also self-paces, which is why there is no backoff here: the cadence becomes scan-duration +
  // up to SETTLE_POLL_MS, so a slow indexer stretches the interval on its own. The scan's measured
  // latency is the backoff.
  //
  // READ THROUGH A REF, because neither alternative works. Reading `scan.status` directly captures
  // it in the interval's closure — if it read 'scanning' when the effect ran it reads 'scanning'
  // forever and the settle never confirms. Listing it as a dependency re-creates the interval on
  // every status change, resetting the timer: the poll loop that never polls, described above.
  const scanStatusRef = useRef(scan.status)
  scanStatusRef.current = scan.status

  useEffect(() => {
    if (!isSettling) return
    const iv = setInterval(() => {
      // UNGUARDED, deliberately: the deadline must resolve even if scans stall completely. The
      // guard below suppresses a network call, never the passage of time.
      setSettles(prev => advanceAll(prev, settleEvidence, Date.now()))
      // Only the POLL is guarded. A user's Refresh/Retry and the post-commit rescans still abort
      // and restart — those are deliberate requests for fresh state now, and silently doing nothing
      // because a slow scan happens to be running would be its own bug.
      if (scanStatusRef.current !== 'scanning') rescanRef.current()
    }, SETTLE_POLL_MS)
    return () => clearInterval(iv)
  }, [isSettling, settleEvidence])

  const recordSent = useCallback((params: NewSentParams) => {
    if (!address) return
    setTxHistory(prev => addSent(address, prev, params))
  }, [address])


  return (
    <Ctx.Provider value={{
      walletExists, wallet, address, scan, held, revealed, txHistory,
      settles, isSettling, settleLagged, beginSettle, acknowledgeSettle,
      createRecoveryPhrase, createWallet, unlock, restore, lock, getMnemonic, rescan, recordSent,
      balanceHidden, setBalanceHidden,
    }}>
      {children}
    </Ctx.Provider>
  )
}
