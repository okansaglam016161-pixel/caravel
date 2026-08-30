// The wallet modal — M4 (v2) presentation over the proven fund logic.
//
// ── WHAT THIS FILE IS, AND IS NOT ─────────────────────────────────────────────
//
// It is a RESKIN. Every handler below is the one that shipped: handlePrepareMove still calls
// prepareConceal / prepareReveal and holds the built envelope, handleConfirmMove still submits that
// exact envelope and hands the committed transaction to WalletContext's settle loop,
// handleConfirmSend still calls sendConfidential and records the outcome. Nothing under src/crypto
// changed, and neither did the settle rules. What changed is that the states now render through the
// v2 components in ./v2, so the modal matches the approved design.
//
// The one genuinely new piece of logic is the DERIVATION at the bottom — turning the shipped state
// machine into the props those components take. It computes no amounts of its own beyond
// presentation; every figure it displays comes from a prepared envelope or a balance read.
//
// ── THE FOUR M4 GAPS, FIXED HERE ──────────────────────────────────────────────
//
//   E2  "Make public" is disabled WITH A REASON when the account address has not been recovered,
//       rather than being offered and then failing at pricing — on the irreversible direction,
//       after the user has typed an amount. See `entries`.
//   E5  The hide toggle reaches the move amounts, not just the balance cards. See `hidden` on the
//       amount card; the review screen is the deliberate exception, noted there.
//   #10 Review shows the RESULTING balances. See `resultingFor`.
//   #3  No base units reach the screen. Fund-module errors pass through plainError at this
//       boundary; the modules keep their exact wording for logs and tests. See ./v2/plainError.

import { useState, useEffect, useRef } from 'react'
import { useWallet } from '../../context/WalletContext'
import { MIN_CONCEAL_MICROTARI, prepareConceal, type PreparedConceal } from '../../crypto/conceal'
import { MIN_REVEAL_MICROTARI, maxRevealable, prepareReveal, type PreparedReveal } from '../../crypto/reveal'
import { loadAccountAddress } from '../../crypto/accountStore'
import FaucetClaimPanel from './FaucetClaimPanel'
import { sendConfidential, tariToMicrotari, maxStealthSend, MAX_FEE, type SendOutcome } from '../../crypto/confidentialSend'
import {
  MIN_PUBLIC_SEND_MICROTARI, assertValidRecipient, maxPublicSend, preparePublicSend,
  type PreparedPublicSend,
} from '../../crypto/publicSend'
import { parseOotleAddress } from '@tari-project/ootle-wasm'
import { buildActivity, type ActivityRow } from '../../crypto/activity'
import { beginEntry, settleEntry } from '../../crypto/journalStore'
import type { JournalOutcome } from '../../crypto/journal'
import { usePaymentResolution } from '../../hooks/usePaymentResolution'
import WalletModalV2, { type MoveView, type Resulting, type WalletTab } from './v2/WalletModalV2'
import { computeTotal, incompleteAvailableNote } from './v2/total'
import type { BalanceView } from './v2/balances'
import type { EntryProps } from './v2/move'
import type { Dir } from './v2/moveCopy'
import { ActivityRowShell, type ActivityStatus, type SendSource, type SendView } from './v2/panels'
import { plainError } from './v2/plainError'
import { resolveSendPath } from './v2/sendPath'
import { GenerationGuard } from './v2/generation'
import { toInput } from './v2/format'

// The PUBLIC ↔ PRIVATE move. Its own state machine rather than SendStep's: a move has no recipient,
// prices itself before review, and its terminal states carry different information.
type MoveStep = 'idle' | 'form' | 'pricing' | 'review' | 'moving' | 'settling' | 'success' | 'error'
type SendStep = 'form' | 'review' | 'sending' | 'settling' | 'success' | 'error'

/** A priced envelope, tagged with the direction that built it. */
type PreparedMove =
  | { dir: 'conceal'; p: PreparedConceal }
  | { dir: 'reveal'; p: PreparedReveal }

/**
 * How long to wait for a committed move to appear in the balance it should raise.
 *
 * The indexer trails consensus by 60–90s, so this is the faucet's 150s for the same reason: long
 * enough to cover the observed lag, short enough that a stuck index does not spin forever. Passing
 * it is NOT a failure — see the settle loop's onDeadline.
 */
const MOVE_SETTLE_MS = 150_000

/**
 * The builders' outcome vocabulary, mapped to the journal's.
 *
 * One table so the three call sites cannot disagree — and so a 'Timeout' can never be recorded as
 * a failure. A timed-out broadcast may still land; calling it failed in a permanent record is the
 * same lie the send flow's `unconfirmed` state exists to avoid.
 */
const JOURNAL_OUTCOME: Record<'Commit' | 'Reject' | 'Timeout', JournalOutcome> = {
  Commit: 'committed',
  Reject: 'rejected',
  Timeout: 'timeout',
}

// ── Activity rows ─────────────────────────────────────────────────────────────
//
// The source rule is unchanged and load-bearing: rows come from buildActivity, which merges wallet
// sends with message-linked payments and deliberately ignores the balance scan — a private output
// carries no sender, so the scan cannot tell an incoming payment from our own change.

function SentRowV2({ row, hidden }: { row: Extract<ActivityRow, { kind: 'sent' }>; hidden: boolean }) {
  const status: ActivityStatus =
    row.outcome === 'Reject' ? 'failed'
    : row.outcome === 'Timeout' ? 'unconfirmed'
    : row.outcome === null ? 'sent'      // a chat send — outcome not tracked
    : 'confirmed'
  return <ActivityRowShell hidden={hidden} row={{
    id: row.id, direction: 'out', title: row.counterparty, note: row.note,
    status, amountMicrotari: row.amountMicrotari,
  }} />
}

/**
 * An inflow. Its amount is resolved lazily and cache-first — which is why this is a component
 * rather than a mapped object: the hook is per row, exactly as it was before.
 */
function ReceivedRowV2({ row, hidden }: { row: Extract<ActivityRow, { kind: 'received' }>; hidden: boolean }) {
  const { state } = usePaymentResolution(row.utxoId)
  const status: ActivityStatus =
    state.kind === 'resolved' ? 'received'
    : state.kind === 'loading' || state.kind === 'retrying' ? 'checking'
    : state.reason === 'spent' ? 'spent'
    : state.reason === 'unreadable' ? 'unreadable'
    : 'pending'   // not_found / network — indexer lag, may still resolve
  return <ActivityRowShell hidden={hidden} row={{
    id: row.id, direction: 'in', title: row.counterparty, note: row.note, status,
    amountMicrotari: state.kind === 'resolved' ? BigInt(state.amountMicrotari) : null,
  }} />
}

// ══════════════════════════════════════════════════════════════════════════════

/**
 * `modal` wraps the body in a backdrop and centres it over whatever is behind — the in-chat wallet.
 * `page` hands the body back bare, for the service shell to place. THE ONLY DIFFERENCE IS CHROME:
 * every step machine, guard and settle reaction below is shared, so the two surfaces cannot drift.
 */
type Chrome = 'modal' | 'page'

export default function WalletModal({ onClose, chrome = 'modal' }: { onClose?: () => void; chrome?: Chrome }) {
  const {
    wallet, address, scan, revealed, rescan, txHistory, messages, recordSent,
    balanceHidden, setBalanceHidden,
    settles, isSettling, settleLagged, beginSettle, acknowledgeSettle,
  } = useWallet()

  const [tab, setTab] = useState<WalletTab>('overview')
  const [addrCopied, setAddrCopied] = useState(false)

  const [sendRecipient, setSendRecipient] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [sendNote, setSendNote] = useState('')
  const [sendStep, setSendStep] = useState<SendStep>('form')
  const [sendValidationError, setSendValidationError] = useState('')
  const [sendProgress, setSendProgress] = useState('')
  const [sendTxId, setSendTxId] = useState('')
  const [sendError, setSendError] = useState('')
  const [sendFee, setSendFee] = useState<bigint | null>(null)
  const [sendOutcome, setSendOutcome] = useState<SendOutcome | null>(null)
  /**
   * Which balance the payment is spent from. The destination is always the recipient's stealth
   * address, so this only changes the sender's side: which transaction is built, what it costs,
   * and what is publicly visible.
   *
   * Defaults to private — the wallet's primary balance, and the one with nothing to disclose.
   */
  const [sendSource, setSendSource] = useState<SendSource>('private')
  /** A priced, built public send, held between review and confirm. Null on the private path. */
  const [sendPrepared, setSendPrepared] = useState<PreparedPublicSend | null>(null)
  /**
   * The exact µtTARI MAX asked for, when MAX was used — the M2 lesson, applied to Send.
   *
   * MAX must mean the whole spendable balance to the last microtari. Deriving it back out of the
   * text field is a float round-trip through a lossy formatter, so the precise figure lives here
   * and the string is only what the user sees. Cleared the moment they type, because then the
   * string IS the intent.
   */
  const [sendExact, setSendExact] = useState<bigint | null>(null)
  const [sendLagging, setSendLagging] = useState(false)

  const [moveStep, setMoveStep] = useState<MoveStep>('idle')
  const [moveDir, setMoveDir] = useState<Dir>('conceal')
  const [moveAmount, setMoveAmount] = useState('')
  const [moveError, setMoveError] = useState('')
  const [moveProgress, setMoveProgress] = useState('')
  const [movePrepared, setMovePrepared] = useState<PreparedMove | null>(null)
  const [moveTxId, setMoveTxId] = useState('')
  const [moveLanded, setMoveLanded] = useState<bigint | null>(null)
  /**
   * The exact µtTARI MAX asked for, when MAX was used.
   *
   * MAX must mean the whole available balance to the last microtari. Deriving it back out of the
   * text field means a float round-trip and the field's formatting is lossy — so the precise figure
   * is kept here and the string is only what the user sees. Cleared the moment they type, because
   * then the string IS the intent.
   */
  const [moveExact, setMoveExact] = useState<bigint | null>(null)
  const [moveLagging, setMoveLagging] = useState(false)
  /**
   * Discards a pricing result the user has already walked away from.
   *
   * Back is live while a move is being priced, so the probe can resolve after the screen is gone.
   * Without this it writes anyway and the dismissed review card returns holding a signed envelope —
   * on the reveal path, a cancelled irreversible action reappearing armed.
   */
  const moveGen = useRef(new GenerationGuard())
  const sendGen = useRef(new GenerationGuard())

  // Escape closes the MODAL. A page has nothing to close, and binding a global key handler that
  // did nothing would still swallow Escape from anything inside it.
  useEffect(() => {
    if (chrome !== 'modal' || !onClose) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose!() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, chrome])

  const { status, balance } = scan
  /**
   * The public balance as a settle baseline: the reading, or `null` when there isn't one.
   *
   * NOT `revealedAmount`, which is a gating number that collapses unavailable to zero. A zero
   * baseline on a RISE watch settles on the first poll; on a FALL watch it can never settle at all.
   */
  const publicNow = revealed.status === 'done' ? revealed.amount : null

  // A committed move is not a visible move: the balances are read from an indexer that trails
  // consensus by 60–90s. Firing one rescan() on commit reads state without the new output, reports
  // the old balance, and stops — so a successful conversion looks like nothing happened.
  //
  // BOTH SIDES ARE WATCHED, in both directions. A conceal raises the private balance and lowers the
  // public one; a reveal does the reverse. The fall used to be dismissed as "the weaker signal"
  // because the private side falls by the whole input rather than by the amount — true of its
  // MAGNITUDE, and irrelevant to its DIRECTION, which is all a watch tests. Treating it as weak is
  // what let a reveal settle on the fast public side alone while the private side was still
  // counting spent funds. See handleConfirmMove for the failure that came out of that.
  //
  // `null` while the read is loading or unavailable is deliberate: "not known yet" never counts as
  // movement, so a failed read cannot be mistaken for a balance that stayed put.
  // ── Reacting to the settles the CONTEXT is running ──────────────────────────
  //
  // The loops themselves moved to WalletContext; see src/context/settle.ts. What is left here is
  // the screen's reaction to an outcome it did not compute — which is the whole improvement. The
  // poll no longer depends on this component being mounted, on which tab is showing, or on the
  // step machine below still being in 'settling'. Pressing Done, switching tabs and closing the
  // modal are now all things that happen AROUND a settle rather than to it.
  const moveSettle = settles.find(e => e.txId === moveTxId && e.kind === 'move')
  const sendSettle = settles.find(e => e.txId === sendTxId && e.kind === 'send')

  useEffect(() => {
    if (!moveSettle || moveSettle.status === 'settling') return
    // A passed deadline is STILL A SUCCESS — the transaction committed, only the index is behind.
    setMoveLagging(moveSettle.status === 'lagged')
    setMoveStep(step => (step === 'settling' ? 'success' : step))
  }, [moveSettle])

  useEffect(() => {
    if (!sendSettle || sendSettle.status === 'settling') return
    setSendLagging(sendSettle.status === 'lagged')
    setSendStep(step => (step === 'settling' ? 'success' : step))
  }, [sendSettle])

  // ── Refresh feedback ────────────────────────────────────────────────────────
  //
  // REFRESHING AND LOADING ARE DIFFERENT FACTS, and conflating them produces a false empty state.
  // `loading` means we have never had a value. `refreshing` means we have one and are re-reading
  // it. A rescan genuinely restarts the stealth scan, so the private figure really does blank —
  // that is honest. The revealed read is two short GETs and blanking a known public balance for
  // them would be a flash of "you have nothing" that is not true, so the last known figure is held
  // while it re-reads and the press is acknowledged by the header and footer instead.
  const [refreshing, setRefreshing] = useState(false)
  /**
   * The last public figure we actually read, WITH the refresh that produced it.
   *
   * The generation travels with the number because this ref exists precisely to show a figure that
   * is no longer current — holding a known balance on screen while it re-reads, rather than
   * flashing "you have nothing". That is a deliberate, honest staleness for the BREAKDOWN row, and
   * it is exactly the staleness the total must refuse to add. A bare amount here would be stamped
   * with whatever generation the live read had reached and would make the guard lie.
   */
  const lastRevealed = useRef<{ amount: bigint; generation: number } | null>(null)
  useEffect(() => {
    if (revealed.status === 'done' && revealed.amount !== null) {
      lastRevealed.current = { amount: revealed.amount, generation: revealed.generation }
    }
  }, [revealed])
  useEffect(() => {
    if (!refreshing) return
    const scanSettled = status === 'done' || status === 'error'
    const revealedSettled = revealed.status === 'done' || revealed.status === 'unavailable'
    if (scanSettled && revealedSettled) setRefreshing(false)
  }, [refreshing, status, revealed.status])

  function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    rescan()
  }

  // ── E2: is there an account to deposit into? ────────────────────────────────
  //
  // A reveal must deposit into a specific account component and must declare it as a transaction
  // input. The address is recovered in the background on unlock and that recovery can fail, so this
  // is a real condition rather than a theoretical one. Re-read when the identity changes, when the
  // revealed read settles (recovery precedes it), and when a move ends — a committed move captures
  // the address for free.
  const [hasAccount, setHasAccount] = useState(false)
  useEffect(() => {
    setHasAccount(!!address && !!loadAccountAddress(address))
  }, [address, revealed.status, moveStep])

  function copyAddr() {
    if (!address) return
    navigator.clipboard.writeText(address).catch(() => {})
    setAddrCopied(true)
    setTimeout(() => setAddrCopied(false), 1800)
  }

  function validateSendForm(): string | null {
    if (!wallet) return 'Your wallet is locked — unlock it before sending.'
    // The SAME recipient check on both paths. It is strictly better than the old prefix test: a
    // mainnet address is well-formed and passes `startsWith`, and paying one would commit to keys
    // nobody on this chain is watching. Unrecoverable either way, so it is checked either way.
    try {
      assertValidRecipient(sendRecipient, parseOotleAddress)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    const amountTari = parseFloat(sendAmount)
    if (!isFinite(amountTari) || amountTari <= 0) return 'Enter an amount greater than zero.'
    const amountMicrotari = sendExact ?? tariToMicrotari(amountTari)

    if (sendSource === 'public') {
      if (amountMicrotari < MIN_PUBLIC_SEND_MICROTARI) {
        return `The smallest amount you can send from your public balance is ${toInput(MIN_PUBLIC_SEND_MICROTARI)} XTR.`
      }
      if (amountMicrotari > publicSendCeiling) {
        return `Not enough public balance — the fee comes out of it too. Most you can send now: ${toInput(publicSendCeiling)} XTR.`
      }
      return null
    }

    // Against the REACHABLE ceiling, not the balance. A stealth send spends up to
    // MAX_STEALTH_INPUTS outputs, so a balance spread across more than that — or across dust the
    // selector cannot reach — is not all sendable in one payment. Saying so here beats an
    // "Insufficient funds" failure after the user has confirmed.
    if (amountMicrotari > privateSendCeiling) {
      return privateSendCeiling === 0n
        ? 'You have no private funds to send yet.'
        : `The most you can send in one private payment is ${toInput(privateSendCeiling)} XTR.`
    }
    return null
  }

  /**
   * Review.
   *
   * The two sources reach it differently, and the difference is honest rather than incidental. A
   * PUBLIC send has a prepare/submit split, so it is priced here by dry run and the review shows an
   * EXACT fee. A PRIVATE send has no such split — confidentialSend dry-runs inside submission — so
   * its review can only show a ceiling. Neither is dressed up as the other.
   */
  async function handleReview() {
    const err = validateSendForm()
    // Through the translator like every other error on this screen: most of what this returns is
    // already plain, but assertValidRecipient's message comes from a fund module and a future check
    // added here would arrive in µtTARI by default. plainError leaves plain text alone.
    if (err) { setSendValidationError(plainError(err)); return }
    setSendValidationError('')
    setSendPrepared(null)

    if (sendSource !== 'public') { setSendStep('review'); return }

    // Priced in place: review renders with a spinner on the fee row until this resolves.
    const token = sendGen.current.begin()
    setSendStep('review')
    setSendProgress('')
    try {
      if (!wallet || !address) return
      const prepared = await preparePublicSend(wallet, address, parseOotleAddress, {
        recipient: sendRecipient.trim(),
        amountMicrotari: sendExact ?? tariToMicrotari(parseFloat(sendAmount)),
        onProgress: setSendProgress,
      })
      if (sendGen.current.isStale(token)) return
      setSendPrepared(prepared)
    } catch (e) {
      if (sendGen.current.isStale(token)) return
      // Nothing has been sent, so the user can adjust and retry with no on-chain consequence.
      setSendValidationError(plainError(e instanceof Error ? e.message : String(e)))
      setSendStep('form')
    }
  }

  function resetSend() {
    sendGen.current.cancel()
    setSendRecipient(''); setSendAmount(''); setSendNote('')
    setSendStep('form'); setSendValidationError(''); setSendProgress('')
    setSendTxId(''); setSendError(''); setSendFee(null); setSendOutcome(null)
    if (sendTxId) acknowledgeSettle(sendTxId)
    setSendPrepared(null); setSendExact(null); setSendLagging(false)
    // `sendSource` is deliberately NOT reset — it is the user's standing preference for this
    // session, and silently flipping it back after every payment would be its own surprise.
  }

  function resetMove() {
    moveGen.current.cancel()
    // Tells the context the user has SEEN this outcome. A still-settling entry is deliberately not
    // dropped by this — Done finishes the screen, not the transaction, and the overview behind it
    // needs the poll to carry on so it can correct itself without a manual Refresh.
    if (moveTxId) acknowledgeSettle(moveTxId)
    setMoveStep('idle')
    // `moveDir` is deliberately NOT reset — it is set fresh by whichever entry is pressed.
    setMoveAmount(''); setMoveError(''); setMoveProgress('')
    setMovePrepared(null); setMoveExact(null); setMoveLagging(false)
    setMoveTxId(''); setMoveLanded(null)
  }

  /**
   * Price the move: dry-run it and hold onto the built envelope.
   *
   * Everything that can fail for a boring reason happens here rather than after the user has
   * confirmed — a dead indexer, an unresolvable account, a rejected simulation. Confirm only submits.
   */
  async function handlePrepareMove() {
    if (!wallet || !address) return
    const token = moveGen.current.begin()
    setMoveStep('pricing')
    setMoveProgress('')
    setMoveError('')
    try {
      // The exact figure when MAX was used; the typed value otherwise. NEVER a re-parse of a
      // rounded display string — and on the reveal side that rail is load-bearing rather than
      // merely tidy: this number is deposited into a public vault and stays readable forever, so a
      // float round-trip would publish a figure the user did not choose.
      const amountMicrotari = moveExact ?? tariToMicrotari(parseFloat(moveAmount))
      const prepared: PreparedMove = moveDir === 'reveal'
        ? { dir: 'reveal', p: await prepareReveal(wallet, address, { amountMicrotari, onProgress: setMoveProgress }) }
        : { dir: 'conceal', p: await prepareConceal(wallet, address, { amountMicrotari, onProgress: setMoveProgress }) }
      // The user may have pressed Back while this was on the wire. Drop it rather than re-arming
      // a screen they dismissed.
      if (moveGen.current.isStale(token)) return
      setMovePrepared(prepared)
      setMoveStep('review')
    } catch (e) {
      if (moveGen.current.isStale(token)) return
      // Back to the form, with the reason: nothing has been sent, so the user can adjust and retry
      // without any on-chain consequence.
      setMoveError(plainError(e instanceof Error ? e.message : String(e)))
      setMoveStep('form')
    }
  }

  async function handleConfirmMove() {
    if (!movePrepared || !address) return
    setMoveStep('moving')
    setMoveProgress('')
    setMoveError('')

    // The move flow journalled NOTHING before this — not the direction, not the amount, not the
    // fee, and not the output it creates for us, which is the one a later scan cannot tell apart
    // from a stranger's payment. Written before submission, for the same reason the send is.
    const isReveal = movePrepared.dir === 'reveal'
    const journalId = beginEntry(address, {
      kind: isReveal ? 'make-public' : 'make-private',
      amountMicrotari: isReveal ? movePrepared.p.revealedAmount : movePrepared.p.concealedAmount,
      feeMicrotari: movePrepared.p.feeMicrotari,   // priced at review; known before submitting
      from: isReveal ? 'private' : 'public',
      to: isReveal ? 'public' : 'private',
      counterparty: { kind: 'self', value: address },
      note: null,
      source: 'local-journal',
      selfOutputIds: null,
    }).entry.id

    try {
      const result = await movePrepared.p.submit(setMoveProgress)
      settleEntry(address, journalId, {
        outcome: JOURNAL_OUTCOME[result.outcome],
        txId: result.txId,
        feeMicrotari: result.feeMicrotari,
        selfOutputIds: result.selfOutputIds ?? null,
      })
      setMoveTxId(result.txId)
      if (result.outcome === 'Commit') {
        setMoveLanded('revealedAmount' in result ? result.revealedAmount : result.concealedAmount)
        // Committed, but not yet VISIBLE — hand the transaction to the context's settle loop rather
        // than declaring success against a balance the indexer has not caught up to. The baselines
        // are the readings taken RIGHT NOW, before the change can appear.
        //
        // ── BOTH SIDES, BECAUSE A MOVE CHANGES BOTH ──────────────────────────────────
        //
        // A move is one transaction with two visible effects, and they do not arrive together. The
        // public balance is two keyed substate lookups and is consensus-fresh; the private balance
        // is a global /utxos listing that trails by 60–90 seconds. So there is a window where one
        // side has updated and the other has not, and the pair is genuinely inconsistent.
        //
        // Watching only ONE side declared the move settled in the middle of that window. On a
        // reveal — which watched the FAST side — the public balance rose, the settle ended, the
        // total dropped out of "updating…", and the private side was still counting the amount it
        // had already spent. The hero then showed a confident figure that double-counted the move:
        // reveal 74 out of 974 private, and the total read 974 + 149 = 1123 instead of 1050. It did
        // not correct itself either, because ending the settle also stopped the poll.
        //
        // Conceal never showed this, and the reason is the whole diagnosis: it happened to watch
        // the SLOW side, so it was still waiting through the same inconsistency. It was protected
        // by luck, not by design. Waiting for both sides protects both directions on purpose.
        //
        // No `?? 0n` on either baseline. An unknown baseline stays unknown, so the loop cannot
        // manufacture a verdict from a number nobody measured — see settle.ts's `before`.
        //
        // The RISING side is listed first: `delta` is measured from watches[0], and the amount that
        // arrived is the meaningful one to report.
        beginSettle({
          txId: result.txId,
          kind: 'move',
          deadlineAt: Date.now() + MOVE_SETTLE_MS,
          watches: movePrepared.dir === 'reveal'
            ? [
                { side: 'public', direction: 'rise', before: publicNow },
                { side: 'private', direction: 'fall', before: balance },
              ]
            : [
                { side: 'private', direction: 'rise', before: balance },
                { side: 'public', direction: 'fall', before: publicNow },
              ],
        })
        setMoveLagging(false)
        setMoveStep('settling')
        // Kick both reads now — each side lags differently and neither is worth waiting a poll for.
        rescan()
      } else {
        setMoveError(
          result.outcome === 'Reject'
            ? `The network rejected the transaction. Nothing was ${movePrepared.dir === 'reveal' ? 'made public' : 'moved'}, and no fee was taken.`
            : 'The transaction didn’t reach a decision in time. It may still land — refresh your balances in a moment before trying again.',
        )
        setMoveStep('error')
      }
    } catch (e) {
      settleEntry(address, journalId, { outcome: 'failed' })
      setMoveError(plainError(e instanceof Error ? e.message : String(e)))
      setMoveStep('error')
    }
  }

  async function handleConfirmSend() {
    if (!wallet || !address) return
    const amountMicrotari = sendExact ?? tariToMicrotari(parseFloat(sendAmount))
    setSendStep('sending')
    setSendProgress('Connecting…')
    setSendTxId('')
    setSendError('')

    // ── THE JOURNAL, WRITTEN BEFORE ANYTHING IS SUBMITTED ──
    //
    // This is the half that closes the hole. `recordSent` below still runs on the paths it always
    // ran on, but it sits AFTER the await — so a send that threw, or a tab closed mid-broadcast,
    // left no trace at all of real money possibly moving. The journal row exists from the moment
    // the user commits to the action and is patched with whatever the network turns out to say.
    const journalId = beginEntry(address, {
      kind: 'send',
      amountMicrotari,
      feeMicrotari: null,               // not known until the receipt comes back
      from: sendSource === 'public' ? 'public' : 'private',
      to: 'external',
      counterparty: { kind: 'address', value: sendRecipient },   // FULL address, never truncated
      note: sendNote || null,
      source: 'local-journal',
      selfOutputIds: null,              // not known until the outputs statement is built
    }).entry.id

    try {
      // NO FALLBACK. resolveSendPath refuses rather than quietly spending the other balance — see
      // v2/sendPath.ts for why this is a function and not a ternary.
      const path = resolveSendPath(sendSource, sendPrepared)
      if (path.kind === 'refuse') {
        setSendError(path.reason)
        setSendStep('error')
        return
      }
      const result = path.kind === 'public'
        ? await path.prepared.submit(setSendProgress)
        : await sendConfidential(wallet, address, {
            recipient: sendRecipient,
            amountMicrotari,
            memo: sendNote || undefined,
            onProgress: setSendProgress,
          })
      setSendTxId(result.txId)
      setSendFee(result.feeMicrotari ?? null)
      setSendOutcome(result.outcome)
      settleEntry(address, journalId, {
        outcome: JOURNAL_OUTCOME[result.outcome],
        txId: result.txId,
        feeMicrotari: result.feeMicrotari ?? null,
        // A PUBLIC send provably creates no output for us: it withdraws from the vault and puts a
        // single stealth output at the RECIPIENT's address (see publicSend.ts). `[]` is a positive
        // claim of "none", which reconciliation may subtract; `null` would be a hole.
        selfOutputIds: path.kind === 'public'
          ? []
          : 'selfOutputIds' in result ? result.selfOutputIds ?? null : null,
      })
      recordSent({
        recipient: sendRecipient,
        amountMicrotari,
        note: sendNote || '',
        txHash: result.txId,
        outcome: result.outcome,
      })
      if (result.outcome === 'Commit') {
        // Committed, but the spend is not VISIBLE until the index catches up — the same 60–90s lag
        // the move flow has. A send has no rise to watch, so the watch is on the spent-from balance
        // FALLING instead. It stays SINGLE-SIDED because a send genuinely moves one balance: the
        // recipient's output is theirs, not ours, so there is no second side to wait for.
        beginSettle({
          txId: result.txId,
          kind: 'send',
          deadlineAt: Date.now() + MOVE_SETTLE_MS,
          watches: [sendSource === 'public'
            ? { side: 'public', direction: 'fall', before: publicNow }
            : { side: 'private', direction: 'fall', before: balance }],
        })
        setSendLagging(false)
        setSendStep('settling')
        rescan()
      } else {
        setSendError(
          result.outcome === 'Reject'
            ? 'The network rejected this payment. Nothing left your wallet and no fee was taken.'
            : 'Broadcast, but the network hasn’t confirmed it yet. Don’t resend — it will appear in Activity.',
        )
        setSendStep('error')
      }
    } catch (e) {
      // The throw path. Previously this recorded NOTHING — the user saw an error over a history
      // that said nothing had been attempted. The row already exists; this closes it honestly.
      settleEntry(address, journalId, { outcome: 'failed' })
      setSendError(plainError(e instanceof Error ? e.message : String(e)))
      setSendStep('error')
    }
  }

  // ══ DERIVATION — the shipped state, as the v2 components want it ═════════════

  const revealedAmount = revealed.status === 'done' ? (revealed.amount ?? 0n) : 0n
  const privateAmount = balance ?? 0n
  /**
   * The private outputs themselves, not just their sum.
   *
   * Both private-side ceilings depend on the SHAPE of the balance rather than its total: a stealth
   * send and a reveal each spend at most MAX_STEALTH_INPUTS of them. Passing the total to either
   * offers amounts the builder cannot honour — the bug the M9 integration pass found on both.
   */
  const outputValues = scan.utxos.map(u => u.amount)

  const privateBalance: BalanceView =
    status === 'error' ? { status: 'unavailable' }
    : balance === null ? { status: 'loading' }          // also covers the never-scanned case (M4 B0)
    : { status: 'ready', microtari: balance }

  const publicBalance: BalanceView =
    revealed.status === 'done' ? { status: 'ready', microtari: revealed.amount ?? 0n }
    : revealed.status === 'unavailable' ? { status: 'unavailable' }
    : lastRevealed.current !== null ? { status: 'ready', microtari: lastRevealed.current.amount }
    : { status: 'loading' }

  /**
   * The generation of the figure `publicBalance` is ACTUALLY SHOWING — which is not always the
   * live read's generation, because of the held-value fallback above.
   */
  const publicShownGeneration =
    revealed.status === 'done' ? revealed.generation
    : lastRevealed.current?.generation ?? revealed.generation

  /**
   * The combined balance.
   *
   * Fed from the SAME flags the two reads already expose — `scan.incomplete` (the private figure is
   * a lower bound, so a sum would be quietly too small) and `revealed.status` (unavailable is "we
   * do not know", not zero). computeTotal owns the precedence; this only supplies the facts.
   *
   * `settling` is EITHER write path's settle window, not a refresh. A refresh is a re-read and the
   * total simply goes back to loading; a settle means a committed transaction is working its way
   * through the index, which is a different claim — "a correct number is coming on its own".
   *
   * A SEND COUNTS AS MUCH AS A MOVE. Only the move was wired here at first, so during a send's
   * settle window the hero kept rendering its pre-send figure as fact — stale, confident, and
   * specifically wrong by the amount just sent, which is the number the user is looking at the hero
   * to check. M7's rule does not distinguish between the two: what matters is that something
   * committed and the index is behind.
   *
   * It now reads the CONTEXT's flag rather than this screen's step, so it stays true after Done and
   * after the modal is closed and reopened. The step machines below are how a transaction is
   * presented; `isSettling` is whether one is actually outstanding.
   */
  const total = computeTotal({
    privateBalance,
    privateIncomplete: scan.incomplete,
    publicBalance,
    settling: isSettling,
    settleLagged,
    // The freshness pair. Two `ready` figures from different refreshes describe different moments
    // and must not be added — see computeTotal. This is what makes the residual flash after a
    // reveal (new public, still-stale private) structurally unreachable rather than merely
    // covered by the settle watches.
    privateGeneration: scan.generation,
    publicGeneration: publicShownGeneration,
  })


  // The amount the form is currently asking for, and the guards around it. `ceiling` differs by
  // direction because the fee comes from different places: a conceal carves it out of the amount
  // leaving the vault, a reveal pays it from the private side ON TOP — which is what maxRevealable
  // accounts for, along with the small stealth reserve.
  /**
   * Set when the private figures — and therefore the private MAX — came from a truncated scan.
   *
   * PRIVATE ONLY. The public balance is a single substate read: it is either known exactly or
   * unavailable, never partial, so a public MAX is never a lower bound and must not carry a caveat
   * that would be simply untrue.
   */
  const privateFiguresIncomplete = scan.incomplete && status === 'done'

  const enteredMicro = moveExact ?? (moveAmount === '' ? 0n : tariToMicrotari(parseFloat(moveAmount) || 0))
  const ceiling = moveDir === 'conceal' ? revealedAmount : maxRevealable(outputValues)
  const minAmount = moveDir === 'conceal' ? MIN_CONCEAL_MICROTARI : MIN_REVEAL_MICROTARI
  const belowMin = moveAmount !== '' && enteredMicro < minAmount
  const overCeiling = moveAmount !== '' && enteredMicro > ceiling

  /**
   * Balances after this move lands. The M4 report's gap #10 — the number users actually want.
   *
   * Every input must be a real reading, never a gating zero. `balance === null` and a non-'done'
   * revealed read are both refused below, which is what makes `privateAmount`/`revealedAmount` safe
   * to use past this point — their `?? 0n` fallbacks cannot be reached here.
   *
   * AN INCOMPLETE SCAN IS REFUSED TOO (M9 CP3). It is not a missing reading, it is a LOWER BOUND
   * one, so the arithmetic still runs and still produces a specific, plausible, too-small "Private
   * after". That is the same confident-wrong-number this modal refuses in the hero and now
   * qualifies at MAX; a projection is no place to make an exception. No projection is shown, and
   * the amount and fee above it are unaffected.
   */
  /**
   * The post-move split, PREDICTED — live balances plus the move's delta.
   *
   * REVIEW ONLY. It is a prediction, and it is only correct while the balances are still pre-move.
   * The success step is reached after the settle loop has seen BOTH sides move, so calling this
   * there double-counts the transaction — which it did, until the success variant of MoveView
   * stopped having anywhere to put the answer.
   */
  function resultingFor(m: PreparedMove): Resulting | null {
    if (balance === null || revealed.status !== 'done' || scan.incomplete) return null
    return m.dir === 'reveal'
      ? { privateAfter: privateAmount - m.p.revealedOutput, publicAfter: revealedAmount + m.p.revealedAmount }
      : { privateAfter: privateAmount + m.p.concealedAmount, publicAfter: revealedAmount - m.p.withdrawAmount }
  }

  // ── Send: what each source can spend ──
  //
  // The ceilings differ because the fee comes from different places. A private send reserves the
  // MAX_FEE ceiling out of the same balance; a public send withdraws `amount + fee` from the vault,
  // which is what maxPublicSend accounts for.
  const sendAvailable = sendSource === 'public' ? revealedAmount : balance
  const publicSendCeiling = maxPublicSend(revealedAmount)
  const privateSendCeiling = maxStealthSend(outputValues)
  const sendCeiling = sendSource === 'public' ? publicSendCeiling : privateSendCeiling
  /** Both sides can actually fund a payment, so the choice is real. */
  const canChooseSource =
    privateSendCeiling > 0n && publicSendCeiling >= MIN_PUBLIC_SEND_MICROTARI

  // The amount to SHOW for a move that has been broadcast. Never `?? 0n`: these two steps run
  // after the transaction is on the wire, so "0 tTARI moved" is a claim the wallet is in no
  // position to make — and it is the one number a person reads to decide whether to send again.
  // The builder's own figure when we have it, otherwise the amount the move was prepared with,
  // otherwise what was typed. Same ladder the 'moving' step uses, and the same one the Send path
  // has always used — no branch of it invents a zero.
  const moveSettledAmount =
    moveLanded
    ?? (movePrepared
      ? (movePrepared.dir === 'reveal' ? movePrepared.p.revealedAmount : movePrepared.p.concealedAmount)
      : enteredMicro)

  /**
   * What the unshield ceiling actually held back, when it held anything back.
   *
   * ONLY WHEN IT IS TRUE. A remainder exists when MAX was used and the balance genuinely exceeds
   * what can be unshielded — the fee comes out of the shielded side, so the ceiling reserves for
   * it. Said over an ordinary partial unshield it would describe nothing that happened, and this
   * wallet does not narrate mechanics that did not occur.
   *
   * Computed once and shown on BOTH the form and the review, so the two cannot tell different
   * stories about the same move.
   */
  const moveLeftoverNote =
    moveDir === 'reveal' && moveExact !== null && privateAmount > ceiling
      ? [
          `${toInput(privateAmount - ceiling)} XTR stays private to cover the fee. It’s still yours and still spendable.`,
          privateFiguresIncomplete ? incompleteAvailableNote() : '',
        ].filter(Boolean).join(' ')
      : moveDir === 'reveal' && privateFiguresIncomplete
      ? incompleteAvailableNote()
      : undefined

  const moveView: MoveView =
    moveStep === 'form' ? {
      step: 'form', dir: moveDir, amount: moveAmount, maxUsed: moveExact !== null,
      available: moveDir === 'conceal' ? revealedAmount : privateAmount,
      // Already computed above for the validation rules — passed through so the form can STATE the
      // bounds instead of leaving them to be discovered by being refused. `ceiling`, not the
      // balance: on the unshield side the fee comes out of the shielded total, so what MAX pins is
      // less than what the breakdown shows, and the form must say the number MAX will actually use.
      minMicrotari: minAmount,
      maxMicrotari: ceiling,
      canReview: moveAmount !== '' && !belowMin && !overCeiling,
      error: belowMin ? `The smallest amount you can move is ${toInput(minAmount)} XTR.`
        : overCeiling ? (moveDir === 'reveal'
            ? `More than you can make public — the fee comes out of your private balance too. Most you can move now: ${toInput(ceiling)} XTR.`
            : 'More than your public balance.')
          : moveError || undefined,
      // Said BEFORE they notice it: a private balance that stops just short of zero after "move
      // everything" reads as a bug, or as funds gone astray on an irreversible action.
      // Both notes can be true at once and both matter, so they are joined rather than ranked —
      // the leftover explains the number, the incompleteness qualifies it.
      leftoverNote: moveLeftoverNote,
    }
    // PRICING IS NOT ITS OWN SCREEN. The design prices inside review: the fee row spins and the
    // confirm button stays inert, so the user reads the amount and direction while it resolves
    // instead of watching a blank card.
    : moveStep === 'pricing' ? {
      step: 'review', dir: moveDir, amountMicrotari: enteredMicro, feeMicrotari: null, resulting: null,
    }
    : moveStep === 'review' && movePrepared ? {
      step: 'review', dir: movePrepared.dir,
      amountMicrotari: movePrepared.dir === 'reveal' ? movePrepared.p.revealedAmount : movePrepared.p.concealedAmount,
      feeMicrotari: movePrepared.p.feeMicrotari,
      resulting: resultingFor(movePrepared),
      leftoverNote: moveLeftoverNote,
    }
    : moveStep === 'moving' ? {
      step: 'moving', dir: moveDir,
      amountMicrotari: movePrepared
        ? (movePrepared.dir === 'reveal' ? movePrepared.p.revealedAmount : movePrepared.p.concealedAmount)
        : enteredMicro,
      progress: moveProgress || 'Submitting to the network — a few seconds.',
    }
    : moveStep === 'settling' ? {
      step: 'settling', dir: moveDir, amountMicrotari: moveSettledAmount, txId: moveTxId,
    }
    // NO `resulting` — the type no longer has the field. See MoveView's success variant: this
    // step is reached only after both balances have moved, so `resultingFor` would be adding the
    // move to figures that already contain it.
    : moveStep === 'success' ? {
      step: 'success', dir: moveDir, amountMicrotari: moveSettledAmount, txId: moveTxId,
      lagged: moveLagging,
    }
    : moveStep === 'error' ? {
      step: 'error', dir: moveDir, message: moveError || 'Unknown error.', txId: moveTxId || undefined,
    }
    : { step: 'idle' }

  // ── Entry availability. An absent control cannot explain itself, so nothing here hides. ──
  const balancesUnknown = status === 'error' && revealed.status === 'unavailable'
  const entries: EntryProps[] = [
    {
      dir: 'conceal',
      disabledReason:
        !wallet ? 'Unlock your wallet to move funds'
        : revealed.status === 'unavailable' ? 'Your public balance is unavailable right now'
        : revealed.status !== 'done' ? 'Checking your public balance…'
        : revealedAmount <= 0n ? 'Nothing public to make private'
        : undefined,
      onClick: () => { setMoveDir('conceal'); setMoveStep('form'); setMoveAmount(''); setMoveExact(null); setMoveError('') },
    },
    {
      dir: 'reveal',
      disabledReason:
        !wallet ? 'Unlock your wallet to move funds'
        : status === 'error' ? 'Your private balance is unavailable right now'
        : balance === null ? 'Checking your private balance…'
        // E2 — the trap the M4 report found. Named before an amount is typed, not after.
        : !hasAccount ? 'Still identifying this wallet’s account — try again in a moment'
        : maxRevealable(outputValues) < MIN_REVEAL_MICROTARI ? 'Not enough private balance to cover an amount plus the fee'
        : undefined,
      onClick: () => { setMoveDir('reveal'); setMoveStep('form'); setMoveAmount(''); setMoveExact(null); setMoveError('') },
    },
  ]

  const sendAmountMicro = sendExact ?? tariToMicrotari(parseFloat(sendAmount) || 0)

  const sendView: SendView =
    sendStep === 'review' ? {
      step: 'review', recipient: sendRecipient, source: sendSource,
      amountMicrotari: sendPrepared?.recipientAmount ?? sendAmountMicro,
      note: sendNote,
      // PUBLIC prices itself before review, so this is an exact measured fee. PRIVATE cannot —
      // sendConfidential dry-runs inside submission — so it can only offer a ceiling, and says so.
      ...(sendSource === 'public'
        ? { feeMicrotari: sendPrepared?.feeMicrotari ?? null }
        : { feeMicrotari: MAX_FEE, feeIsCeiling: true }),
    }
    : sendStep === 'sending' ? {
      step: 'sending', source: sendSource, recipient: sendRecipient, amountMicrotari: sendAmountMicro,
      progress: sendProgress || 'Building the payment and broadcasting. Don’t close this window.',
    }
    // Its OWN step now, not a success card shown early (M9 F6). The payment is finished either
    // way; what differs is that the balance behind this screen has not moved yet, and saying
    // nothing about that left the user comparing a "Sent" with a stale figure.
    : sendStep === 'settling' ? {
      step: 'settling', recipient: sendRecipient,
      amountMicrotari: sendAmountMicro,
      feeMicrotari: sendFee ?? (sendSource === 'public' ? (sendPrepared?.feeMicrotari ?? MAX_FEE) : MAX_FEE),
      txId: sendTxId,
    }
    : sendStep === 'success' ? {
      step: 'success', recipient: sendRecipient,
      amountMicrotari: sendAmountMicro,
      feeMicrotari: sendFee ?? (sendSource === 'public' ? (sendPrepared?.feeMicrotari ?? MAX_FEE) : MAX_FEE),
      txId: sendTxId,
      // A passed deadline is still a success — the payment committed, only the index is behind.
      lagged: sendLagging,
    }
    // A TIMEOUT IS NOT A FAILURE. It was broadcast and may still land, so it must not wear the
    // red card that says nothing left the wallet.
    : sendStep === 'error' && sendOutcome === 'Timeout' ? {
      step: 'unconfirmed', message: sendError, txId: sendTxId,
    }
    : sendStep === 'error' ? { step: 'error', message: sendError || 'Unknown error.' }
    : {
      step: 'form', recipient: sendRecipient, amount: sendAmount, note: sendNote,
      source: sendSource, canChooseSource,
      available: sendAvailable,
      availabilityNote: sendSource === 'private' && privateFiguresIncomplete ? incompleteAvailableNote() : undefined,
      canReview: !!sendRecipient && !!sendAmount,
      error: sendValidationError || undefined,
    }

  const activity = buildActivity(txHistory, messages)

  const body = (
    <WalletModalV2
      chrome={chrome}
      privateBalance={privateBalance}
      publicBalance={publicBalance}
      total={total}
      hidden={balanceHidden}
      networkChip="Esmeralda testnet"
      refreshing={refreshing}
      // The literal scan diagnostic, restored beside Refresh. Private scan only — the public
      // balance is a vault read with nothing to enumerate.
      scanSummary={{
        status,
        scanned: scan.totalScanned,
        owned: scan.utxos.length,
        progressScanned: scan.progress.scanned,
      }}
      move={moveView}
      entries={entries}
      lockedText={balancesUnknown ? 'Unavailable while balances are unknown' : undefined}
      tab={tab}
      onTab={setTab}
      onToggleHidden={() => setBalanceHidden(v => !v)}
      onRefresh={handleRefresh}
      onClose={onClose}
      onBack={resetMove}
      onAmountChange={v => { setMoveAmount(v); setMoveExact(null); setMoveError('') }}
      onMax={() => { setMoveExact(ceiling); setMoveAmount(toInput(ceiling)); setMoveError('') }}
      onReview={() => void handlePrepareMove()}
      onConfirm={() => void handleConfirmMove()}
      onDone={resetMove}
      onRetryMove={() => { setMoveStep('form'); setMoveError('') }}
      onCopyTx={t => { navigator.clipboard.writeText(t).catch(() => {}) }}
      onRetryBalance={handleRefresh}
      // ── THE ASSET PAGE IS DELIBERATELY NOT WIRED ────────────────────────────
      //
      // `assetOpen`, `onOpenAsset` and `onCloseAsset` are all still on WalletModalV2 and
      // AssetDetail is still built and still rendered by the preview harness. Passing these three
      // props again is the whole of turning it back on.
      //
      // WHY IT IS OFF. The page exists to answer questions a single-asset testnet wallet does not
      // have: what else do I hold, and what has this one been doing. There is one asset, and its
      // price is a fixed rate with no history — the chart is honestly a flat line, which is the
      // best available drawing of a constant and still reads as a broken chart to anyone who has
      // seen a price page before. A destination that restates the overview is worse than no
      // destination.
      //
      // WHAT TURNS IT BACK ON: a real price feed, or a second asset. Either gives the page
      // something to say that the row above it cannot.
      //
      // THE ROW GOES INERT BY ITSELF. AssetsPanel keys its chevron, pointer, hover, focus and
      // click on whether `onOpen` was passed, so withholding it removes every affordance at once
      // rather than leaving a control that looks live and does nothing.
      // The faucet is a quiet card in the extras slot. The @name card left the overview entirely —
      // ONS lives on the Name page, which is where OnsRegisterPanel is mounted and where its state
      // machine is untouched.
      overviewExtras={<FaucetClaimPanel />}
      send={{
        view: sendView, hidden: balanceHidden,
        onSource: s => { setSendSource(s); setSendExact(null); setSendValidationError('') },
        onRecipient: v => { setSendRecipient(v); setSendValidationError('') },
        onAmount: v => { setSendAmount(v); setSendExact(null); setSendValidationError('') },
        onNote: setSendNote,
        // EXACT BIGINT per source. The string is only what the user sees; the precise figure
        // rides in sendExact so nothing round-trips through a lossy formatter.
        onMax: () => { setSendExact(sendCeiling); setSendAmount(toInput(sendCeiling)); setSendValidationError('') },
        onReview: () => void handleReview(),
        // Back out of review: whatever is being priced must not come back and re-arm it.
        onBack: () => { sendGen.current.cancel(); setSendPrepared(null); setSendStep('form') },
        onConfirm: () => void handleConfirmSend(),
        onDone: resetSend,
        onRetry: resetSend,
        onCopyTx: t => { navigator.clipboard.writeText(t).catch(() => {}) },
        onViewActivity: () => { resetSend(); setTab('activity') },
      }}
      receive={{ address, copied: addrCopied, onCopy: copyAddr }}
      activity={activity.map(row => row.kind === 'sent'
    ? <SentRowV2 key={row.id} row={row} hidden={balanceHidden} />
    : <ReceivedRowV2 key={row.id} row={row} hidden={balanceHidden} />)}
    />
  )

  if (chrome === 'page') return body

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,14,0.78)', backdropFilter: 'blur(3px)', zIndex: 200 }} />
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 201, display: 'flex' }}>
        {body}
      </div>
    </>
  )
}
