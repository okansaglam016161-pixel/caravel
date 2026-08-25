// The wallet modal — M4 (v2) presentation over the proven fund logic.
//
// ── WHAT THIS FILE IS, AND IS NOT ─────────────────────────────────────────────
//
// It is a RESKIN. Every handler below is the one that shipped: handlePrepareMove still calls
// prepareConceal / prepareReveal and holds the built envelope, handleConfirmMove still submits that
// exact envelope and hands off to useBalanceSettle with the direction-dependent balance,
// handleConfirmSend still calls sendConfidential and records the outcome. Nothing under src/crypto
// changed, and neither did useBalanceSettle. What changed is that the states now render through the
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
import { useBalanceSettle } from './useBalanceSettle'
import OnsRegisterPanel from './OnsRegisterPanel'
import FaucetClaimPanel from './FaucetClaimPanel'
import { sendConfidential, tariToMicrotari, MAX_FEE, type SendOutcome } from '../../crypto/confidentialSend'
import { buildActivity, type ActivityRow } from '../../crypto/activity'
import { usePaymentResolution } from '../../hooks/usePaymentResolution'
import WalletModalV2, { type MoveView, type Resulting, type WalletTab } from './v2/WalletModalV2'
import type { BalanceView } from './v2/balances'
import type { Dir, EntryProps } from './v2/move'
import { ActivityRowShell, type ActivityStatus, type SendView } from './v2/panels'
import { plainError } from './v2/plainError'
import { toInput } from './v2/format'

// The PUBLIC ↔ PRIVATE move. Its own state machine rather than SendStep's: a move has no recipient,
// prices itself before review, and its terminal states carry different information.
type MoveStep = 'idle' | 'form' | 'pricing' | 'review' | 'moving' | 'settling' | 'success' | 'error'
type SendStep = 'form' | 'review' | 'sending' | 'success' | 'error'

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

export default function WalletModal({ onClose }: { onClose: () => void }) {
  const { wallet, address, scan, revealed, rescan, txHistory, messages, recordSent, balanceHidden, setBalanceHidden } = useWallet()

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
  /** The balance being watched, captured BEFORE submitting so the settle loop can see it rise. */
  const movePreBalance = useRef<bigint>(0n)
  const moveDeadline = useRef<number>(0)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { status, balance } = scan

  // A committed move is not a visible move: the balances are read from an indexer that trails
  // consensus by 60–90s. Firing one rescan() on commit reads state without the new output, reports
  // the old balance, and stops — so a successful conversion looks like nothing happened.
  //
  // WHICH BALANCE RISES DEPENDS ON THE DIRECTION, and watching the wrong one would report a lag
  // that is not there: a conceal raises the PRIVATE balance, a reveal raises the PUBLIC one. Both
  // also make the other side fall, but a fall is the weaker signal — the private side falls by the
  // whole input, not by the amount — so the rise is what is polled for, in both cases.
  //
  // `null` while the read is loading or unavailable is deliberate: "not known yet" never counts as
  // movement, so a failed read cannot be mistaken for a balance that stayed put.
  const settleBalance = moveDir === 'reveal'
    ? (revealed.status === 'done' ? revealed.amount : null)
    : balance

  useBalanceSettle({
    active: moveStep === 'settling',
    balance: settleBalance,
    before: movePreBalance.current,
    deadlineAt: moveDeadline.current,
    rescan,
    onRose: () => { setMoveStep('success') },
    onDeadline: () => {
      // NOT an error. The transaction committed; only the index is behind. Saying otherwise would
      // tell someone their funds did not move when they demonstrably did.
      setMoveLagging(true)
      setMoveStep('success')
    },
  })

  // ── Refresh feedback ────────────────────────────────────────────────────────
  //
  // REFRESHING AND LOADING ARE DIFFERENT FACTS, and conflating them produces a false empty state.
  // `loading` means we have never had a value. `refreshing` means we have one and are re-reading
  // it. A rescan genuinely restarts the stealth scan, so the private figure really does blank —
  // that is honest. The revealed read is two short GETs and blanking a known public balance for
  // them would be a flash of "you have nothing" that is not true, so the last known figure is held
  // while it re-reads and the press is acknowledged by the header and footer instead.
  const [refreshing, setRefreshing] = useState(false)
  const lastRevealed = useRef<bigint | null>(null)
  useEffect(() => {
    if (revealed.status === 'done' && revealed.amount !== null) lastRevealed.current = revealed.amount
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
    if (!sendRecipient.startsWith('otl_esm_')) return 'That doesn’t look like a Tari address — it should start with otl_esm_.'
    const amountTari = parseFloat(sendAmount)
    if (!isFinite(amountTari) || amountTari <= 0) return 'Enter an amount greater than zero.'
    const amountMicrotari = tariToMicrotari(amountTari)
    if (balance !== null && amountMicrotari + MAX_FEE > balance) {
      return `Not enough private balance — this needs ${toInput(amountMicrotari + MAX_FEE)} TARI including the fee, and you have ${toInput(balance)} TARI.`
    }
    return null
  }

  function handleReview() {
    const err = validateSendForm()
    if (err) { setSendValidationError(err); return }
    setSendValidationError('')
    setSendStep('review')
  }

  function resetSend() {
    setSendRecipient(''); setSendAmount(''); setSendNote('')
    setSendStep('form'); setSendValidationError(''); setSendProgress('')
    setSendTxId(''); setSendError(''); setSendFee(null); setSendOutcome(null)
  }

  function resetMove() {
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
      setMovePrepared(prepared)
      setMoveStep('review')
    } catch (e) {
      // Back to the form, with the reason: nothing has been sent, so the user can adjust and retry
      // without any on-chain consequence.
      setMoveError(plainError(e instanceof Error ? e.message : String(e)))
      setMoveStep('form')
    }
  }

  async function handleConfirmMove() {
    if (!movePrepared) return
    setMoveStep('moving')
    setMoveProgress('')
    setMoveError('')
    try {
      const result = await movePrepared.p.submit(setMoveProgress)
      setMoveTxId(result.txId)
      if (result.outcome === 'Commit') {
        setMoveLanded('revealedAmount' in result ? result.revealedAmount : result.concealedAmount)
        // Committed, but not yet VISIBLE — hand off to the settle loop rather than declaring success
        // against a balance the indexer has not caught up to. The "before" reading has to be the
        // balance the loop will WATCH, which is direction-dependent.
        movePreBalance.current = (movePrepared.dir === 'reveal'
          ? (revealed.status === 'done' ? revealed.amount : null)
          : balance) ?? 0n
        moveDeadline.current = Date.now() + MOVE_SETTLE_MS
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
      setMoveError(plainError(e instanceof Error ? e.message : String(e)))
      setMoveStep('error')
    }
  }

  async function handleConfirmSend() {
    if (!wallet || !address) return
    setSendStep('sending')
    setSendProgress('Connecting…')
    setSendTxId('')
    setSendError('')
    try {
      const result = await sendConfidential(wallet, address, {
        recipient: sendRecipient,
        amountMicrotari: tariToMicrotari(parseFloat(sendAmount)),
        memo: sendNote || undefined,
        onProgress: setSendProgress,
      })
      setSendTxId(result.txId)
      setSendFee(result.feeMicrotari ?? null)
      setSendOutcome(result.outcome)
      recordSent({
        recipient: sendRecipient,
        amountMicrotari: tariToMicrotari(parseFloat(sendAmount)),
        note: sendNote || '',
        txHash: result.txId,
        outcome: result.outcome,
      })
      if (result.outcome === 'Commit') {
        setSendStep('success')
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
      setSendError(plainError(e instanceof Error ? e.message : String(e)))
      setSendStep('error')
    }
  }

  // ══ DERIVATION — the shipped state, as the v2 components want it ═════════════

  const revealedAmount = revealed.status === 'done' ? (revealed.amount ?? 0n) : 0n
  const privateAmount = balance ?? 0n

  const privateBalance: BalanceView =
    status === 'error' ? { status: 'unavailable' }
    : balance === null ? { status: 'loading' }          // also covers the never-scanned case (M4 B0)
    : { status: 'ready', microtari: balance }

  const publicBalance: BalanceView =
    revealed.status === 'done' ? { status: 'ready', microtari: revealed.amount ?? 0n }
    : revealed.status === 'unavailable' ? { status: 'unavailable' }
    : lastRevealed.current !== null ? { status: 'ready', microtari: lastRevealed.current }
    : { status: 'loading' }

  // The amount the form is currently asking for, and the guards around it. `ceiling` differs by
  // direction because the fee comes from different places: a conceal carves it out of the amount
  // leaving the vault, a reveal pays it from the private side ON TOP — which is what maxRevealable
  // accounts for, along with the small stealth reserve.
  const enteredMicro = moveExact ?? (moveAmount === '' ? 0n : tariToMicrotari(parseFloat(moveAmount) || 0))
  const ceiling = moveDir === 'conceal' ? revealedAmount : maxRevealable(privateAmount)
  const minAmount = moveDir === 'conceal' ? MIN_CONCEAL_MICROTARI : MIN_REVEAL_MICROTARI
  const belowMin = moveAmount !== '' && enteredMicro < minAmount
  const overCeiling = moveAmount !== '' && enteredMicro > ceiling

  /** Balances after this move lands. The M4 report's gap #10 — the number users actually want. */
  function resultingFor(m: PreparedMove): Resulting | null {
    if (balance === null || revealed.status !== 'done') return null
    return m.dir === 'reveal'
      ? { privateAfter: privateAmount - m.p.revealedOutput, publicAfter: revealedAmount + m.p.revealedAmount }
      : { privateAfter: privateAmount + m.p.concealedAmount, publicAfter: revealedAmount - m.p.withdrawAmount }
  }

  const moveView: MoveView =
    moveStep === 'form' ? {
      step: 'form', dir: moveDir, amount: moveAmount, maxUsed: moveExact !== null,
      available: moveDir === 'conceal' ? revealedAmount : privateAmount,
      canReview: moveAmount !== '' && !belowMin && !overCeiling,
      error: belowMin ? `The smallest amount you can move is ${toInput(minAmount)} TARI.`
        : overCeiling ? (moveDir === 'reveal'
            ? `More than you can make public — the fee comes out of your private balance too. Most you can move now: ${toInput(ceiling)} TARI.`
            : 'More than your public balance.')
          : moveError || undefined,
      // Said BEFORE they notice it: a private balance that stops just short of zero after "move
      // everything" reads as a bug, or as funds gone astray on an irreversible action.
      leftoverNote: moveDir === 'reveal' && moveExact !== null && privateAmount > ceiling
        ? `About ${toInput(privateAmount - ceiling)} TARI stays private to cover the fee. It’s still yours and still spendable.`
        : undefined,
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
      // The amber arrow, label and confirm button carry the signal; no three-facts block.
      showPermanenceNote: false,
    }
    : moveStep === 'moving' ? {
      step: 'moving', dir: moveDir,
      amountMicrotari: movePrepared
        ? (movePrepared.dir === 'reveal' ? movePrepared.p.revealedAmount : movePrepared.p.concealedAmount)
        : enteredMicro,
      progress: moveProgress || 'Submitting to the network — a few seconds.',
    }
    : moveStep === 'settling' ? {
      step: 'settling', dir: moveDir, amountMicrotari: moveLanded ?? 0n, txId: moveTxId,
    }
    : moveStep === 'success' ? {
      step: 'success', dir: moveDir, amountMicrotari: moveLanded ?? 0n, txId: moveTxId,
      lagged: moveLagging,
      resulting: movePrepared ? resultingFor(movePrepared) : null,
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
        : revealedAmount <= 0n ? 'Nothing public to move'
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
        : maxRevealable(privateAmount) < MIN_REVEAL_MICROTARI ? 'Not enough private balance to cover an amount plus the fee'
        : undefined,
      onClick: () => { setMoveDir('reveal'); setMoveStep('form'); setMoveAmount(''); setMoveExact(null); setMoveError('') },
    },
  ]

  const sendView: SendView =
    sendStep === 'review' ? {
      step: 'review', recipient: sendRecipient,
      amountMicrotari: tariToMicrotari(parseFloat(sendAmount) || 0),
      note: sendNote,
      // A CEILING, not a measurement. sendConfidential dry-runs inside submission and has no
      // prepare/submit split, so before confirming this is the only honest figure. The success
      // screen then shows what was actually paid.
      feeMicrotari: MAX_FEE, feeIsCeiling: true,
    }
    : sendStep === 'sending' ? {
      step: 'sending', amountMicrotari: tariToMicrotari(parseFloat(sendAmount) || 0),
      progress: sendProgress || 'Building the private proof and broadcasting. Don’t close this window.',
    }
    : sendStep === 'success' ? {
      step: 'success', recipient: sendRecipient,
      amountMicrotari: tariToMicrotari(parseFloat(sendAmount) || 0),
      feeMicrotari: sendFee ?? MAX_FEE, txId: sendTxId,
    }
    // A TIMEOUT IS NOT A FAILURE. It was broadcast and may still land, so it must not wear the
    // red card that says nothing left the wallet.
    : sendStep === 'error' && sendOutcome === 'Timeout' ? {
      step: 'unconfirmed', message: sendError, txId: sendTxId,
    }
    : sendStep === 'error' ? { step: 'error', message: sendError || 'Unknown error.' }
    : {
      step: 'form', recipient: sendRecipient, amount: sendAmount, note: sendNote,
      available: balance, canReview: !!sendRecipient && !!sendAmount,
      error: sendValidationError || undefined,
    }

  const activity = buildActivity(txHistory, messages)

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,14,0.78)', backdropFilter: 'blur(3px)', zIndex: 200 }} />
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 201, display: 'flex' }}>
        <WalletModalV2
          privateBalance={privateBalance}
          publicBalance={publicBalance}
          hidden={balanceHidden}
          networkChip="Esmeralda testnet"
          refreshing={refreshing}
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
          faucet={undefined}
          overviewExtras={<><FaucetClaimPanel /><OnsRegisterPanel /></>}
          send={{
            view: sendView, hidden: balanceHidden,
            onRecipient: v => { setSendRecipient(v); setSendValidationError('') },
            onAmount: v => { setSendAmount(v); setSendValidationError('') },
            onNote: setSendNote,
            onMax: () => { if (balance !== null) setSendAmount(toInput(balance > MAX_FEE ? balance - MAX_FEE : 0n)) },
            onReview: handleReview,
            onBack: () => setSendStep('form'),
            onConfirm: () => void handleConfirmSend(),
            onDone: resetSend,
            onRetry: resetSend,
            onCopyTx: t => { navigator.clipboard.writeText(t).catch(() => {}) },
            onViewActivity: () => { resetSend(); setTab('activity') },
          }}
          receive={{ address, copied: addrCopied, onCopy: copyAddr }}
          activityEmpty={activity.length === 0}
          activity={activity.map(row => row.kind === 'sent'
            ? <SentRowV2 key={row.id} row={row} hidden={balanceHidden} />
            : <ReceivedRowV2 key={row.id} row={row} hidden={balanceHidden} />)}
        />
      </div>
    </>
  )
}
