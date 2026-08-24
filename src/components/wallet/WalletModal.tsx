//   Wallet modal — presentation transcribed element-for-element from the design file
//   "Caravel Wallet Modal (Build).dc.html" (modal frame, balance ×6, send ×8, receive ×2,
//   activity ×3, settings). Colours reference step-0 tokens (same values as the design hex).
//   ALL logic — handlers, state, context bindings, validation — is preserved verbatim from the
//   prior WalletModal; only the JSX mirrors the design markup. Dev decrypt panel removed.

import { useState, useEffect, useRef } from 'react'
import { useWallet } from '../../context/WalletContext'
import { MIN_CONCEAL_MICROTARI, prepareConceal, type PreparedConceal } from '../../crypto/conceal'
import { useBalanceSettle } from './useBalanceSettle'
import { Logo } from '../primitives'
import OnsRegisterPanel from './OnsRegisterPanel'
import FaucetClaimPanel from './FaucetClaimPanel'
import { sendConfidential, tariToMicrotari, MAX_FEE, type SendOutcome } from '../../crypto/confidentialSend'
import { buildActivity, type ActivityRow } from '../../crypto/activity'
import { usePaymentResolution } from '../../hooks/usePaymentResolution'
import { QRCodeSVG } from 'qrcode.react'

type Tab = 'overview' | 'send' | 'receive' | 'activity'
type SendStep = 'form' | 'review' | 'sending' | 'success' | 'error'

// The PUBLIC → PRIVATE move (M2). Deliberately its own little state machine rather than reusing
// SendStep: a conceal has no recipient, prices itself before review, and its terminal states carry
// different information. 'pricing' is the step SendStep has no analogue for — the dry run runs
// between the form and the review so the fee shown is the fee paid.
type MoveStep = 'idle' | 'form' | 'pricing' | 'review' | 'moving' | 'settling' | 'success' | 'error'

/**
 * How long to wait for a committed conceal to appear in the confidential balance.
 *
 * The indexer's /utxos listing lags consensus by 60–90s, so this is the faucet's 150s, for the same
 * reason: long enough to cover the observed lag, short enough that a genuinely stuck index does not
 * leave a spinner running forever. Passing it is not a failure — see the settling copy.
 */
const MOVE_SETTLE_MS = 150_000

const MONO = 'var(--font-mono)'
const HIDDEN = '••••••'
// 2dp + thousands separators (design headline / activity amounts).
const fmt2 = (µt: bigint | number) => (Number(µt) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * µtTARI → a 2dp display string, computed ENTIRELY in bigint.
 *
 * NOT a bug fix. fmt2 above divides through `Number`, and it was worth checking whether that costs
 * anything here: it does not. At 2dp the two agree for EVERY value in the u64 range and beyond —
 * Number's error only exceeds half a hundredth of a TARI past ~1e20 µtTARI, which is five orders of
 * magnitude above the whole TARI supply. The tests pin that agreement.
 *
 * This exists because the revealed-balance path is new code under a "no Number() on amounts" rail,
 * and honouring the rail literally costs one line of arithmetic: round half-up to the nearest
 * hundredth, then group the whole part. Identical output to fmt2 means the public row and the
 * private hero can never write the same figure differently.
 */
/**
 * µtTARI → a full-precision decimal string for an AMOUNT INPUT. No grouping, no rounding.
 *
 * Distinct from fmtMicrotariExact, which rounds to 2dp for DISPLAY — and must not be reused here.
 * A balance of 999_997_686 µtTARI displays as "1,000.00", and feeding that back in as an amount
 * asks the vault for 2_314 µtTARI more than it holds, which the network refuses. Display rounding
 * and amount entry are different jobs.
 */
const microtariToInput = (µt: bigint): string => {
  const whole = µt / 1_000_000n
  const frac = (µt % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

const fmtMicrotariExact = (µt: bigint): string => {
  const hundredths = (µt + 5_000n) / 10_000n     // + half a hundredth, then truncate = round half-up
  const whole = hundredths / 100n
  const cents = hundredths % 100n
  return `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`
}
// Fee: trimmed decimals (design shows "0.0042" / "0.01").
const fmtFee = (µt: bigint) => (Number(µt) / 1_000_000).toString()

// Presentational row shell — the design markup, driven by already-computed display values so both
// the sent (wallet + chat) and received (message-linked, resolved lazily) sources render identically.
type RowKind = 'confirmed' | 'received' | 'notconf' | 'failed'
function TxRowShell({ kind, title, sub, amount, amountColor, hidden, hasNote, status }: {
  kind: RowKind; title: string; sub: string; amount: string; amountColor: string; hidden: boolean; hasNote: boolean; status: { t: string; c: string }
}) {
  const iconWrap: Record<RowKind, React.CSSProperties> = {
    confirmed: { background: 'rgba(var(--teal-500-rgb),0.1)', border: '1px solid rgba(var(--teal-500-rgb),0.22)' },
    received: { background: 'rgba(var(--border-rgb),0.07)', border: '1px solid rgba(var(--border-rgb),0.16)' },
    notconf: { background: 'rgba(var(--warn-rgb),0.05)', border: '1px dashed rgba(var(--warn-rgb),0.34)' },
    failed: { background: 'rgba(var(--danger-rgb),0.07)', border: '1px solid rgba(var(--danger-rgb),0.24)' },
  }
  const icon: Record<RowKind, React.ReactNode> = {
    confirmed: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>,
    received: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>,
    notconf: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /><path d="M4.5 4.5l15 15" opacity="0.55" /></svg>,
    failed: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 13, borderRadius: 12, borderBottom: '1px solid rgba(var(--border-rgb),0.07)' }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, flexShrink: 0, ...iconWrap[kind] }}>{icon[kind]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: kind === 'failed' ? 'var(--text-muted)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
          <span style={{ fontFamily: MONO, fontSize: 13, color: hidden ? 'var(--text-teal-label)' : amountColor, letterSpacing: hidden ? '0.1em' : undefined, flexShrink: 0, marginLeft: 8 }}>{hidden ? '••••' : amount}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 3 }}>
          <span style={{ fontSize: 12, color: hasNote ? 'var(--text-teal-dim)' : 'var(--text-faint)', fontStyle: hasNote ? 'italic' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: status.c, flexShrink: 0, marginLeft: 8 }}>{status.t}</span>
        </div>
      </div>
    </div>
  )
}

// An outflow — wallet-modal send (has an outcome) or a chat send (outcome not tracked → shown "Sent").
function SentActivityRow({ row, hidden }: { row: Extract<ActivityRow, { kind: 'sent' }>; hidden: boolean }) {
  const kind: RowKind = row.outcome === 'Reject' ? 'failed' : row.outcome === 'Timeout' ? 'notconf' : 'confirmed'
  const amount = row.amountMicrotari !== null ? fmt2(row.amountMicrotari) : '—'
  const amountColor = kind === 'failed' ? 'var(--text-faint-dim)' : 'var(--text-teal-label)'
  const sub = row.note ? `“${row.note}”` : kind === 'notconf' ? 'Broadcast, never confirmed' : kind === 'failed' ? 'Nothing was taken' : 'No note'
  const status = row.outcome === null ? { t: 'Sent', c: 'var(--teal-300)' }
    : kind === 'failed' ? { t: 'Failed', c: 'var(--danger-300)' }
    : kind === 'notconf' ? { t: 'Not confirmed', c: 'var(--warn-300)' }
    : { t: 'Confirmed', c: 'var(--teal-300)' }
  return <TxRowShell kind={kind} title={row.counterparty} sub={sub} amount={amount} amountColor={amountColor} hidden={hidden} hasNote={!!row.note} status={status} />
}

// An inflow — a message-linked received payment; its confidential amount is resolved lazily (M10.2).
function ReceivedActivityRow({ row, hidden }: { row: Extract<ActivityRow, { kind: 'received' }>; hidden: boolean }) {
  const { state } = usePaymentResolution(row.utxoId)
  let amount = '—'
  let status: { t: string; c: string }
  if (state.kind === 'resolved') { amount = fmt2(BigInt(state.amountMicrotari)); status = { t: 'Received', c: 'var(--teal-300)' } }
  else if (state.kind === 'loading' || state.kind === 'retrying') { amount = '…'; status = { t: 'Resolving', c: 'var(--text-faint-dim)' } }
  else status = state.reason === 'spent' ? { t: 'Spent', c: 'var(--text-faint-dim)' }
    : state.reason === 'unreadable' ? { t: 'Unavailable', c: 'var(--text-faint-dim)' }
    : { t: 'Pending', c: 'var(--warn-300)' }   // not_found / network — indexer lag, may still resolve
  const sub = row.note ? `“${row.note}”` : 'No note'
  return <TxRowShell kind="received" title={row.counterparty} sub={sub} amount={amount} amountColor="var(--text-teal-label)" hidden={hidden} hasNote={!!row.note} status={status} />
}

export default function WalletModal({ onClose }: { onClose: () => void }) {
  const { wallet, address, scan, revealed, rescan, txHistory, messages, recordSent, balanceHidden, setBalanceHidden } = useWallet()

  const [tab, setTab] = useState<Tab>('overview')
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
  const [moveAmount, setMoveAmount] = useState('')
  const [moveError, setMoveError] = useState('')
  const [moveProgress, setMoveProgress] = useState('')
  const [movePrepared, setMovePrepared] = useState<PreparedConceal | null>(null)
  const [moveTxId, setMoveTxId] = useState('')
  const [moveLanded, setMoveLanded] = useState<bigint | null>(null)
  /**
   * The exact µtTARI MAX asked for, when MAX was used.
   *
   * MAX must mean the WHOLE revealed balance to the last microtari. Deriving it back out of the
   * text field means a float round-trip, and the field's own formatting is lossy — so the precise
   * figure is kept here and the string is only what the user sees. Cleared the moment they type,
   * because then the string IS the intent.
   */
  const [moveExact, setMoveExact] = useState<bigint | null>(null)
  const [moveLagging, setMoveLagging] = useState(false)
  /** Confidential balance captured BEFORE submitting, so the settle loop can see it rise. */
  const movePreBalance = useRef<bigint>(0n)
  const moveDeadline = useRef<number>(0)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { status, balance } = scan

  // A committed conceal is not a visible conceal: the scan reads the indexer's /utxos listing, which
  // trails consensus by 60–90s. Firing one rescan() on commit — which is what this flow did at first
  // — scans a listing without the new output, reports the old balance, and stops, so a successful
  // conversion looks like nothing happened. This waits for it properly.
  useBalanceSettle({
    active: moveStep === 'settling',
    balance,
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
  const balanceStr = balance !== null ? fmt2(balance) : null

  const shortAddr = address ? address.slice(0, 20) + '…' + address.slice(-6) : null

  function copyAddr() { if (address) { navigator.clipboard.writeText(address).catch(() => {}); setAddrCopied(true); setTimeout(() => setAddrCopied(false), 1800) } }

  function validateSendForm(): string | null {
    if (!wallet) return 'Wallet is locked — unlock before sending'
    if (!sendRecipient.startsWith('otl_esm_')) return 'Invalid address — must start with otl_esm_'
    const amountTari = parseFloat(sendAmount)
    if (!isFinite(amountTari) || amountTari <= 0) return 'Amount must be greater than 0'
    const amountMicrotari = tariToMicrotari(amountTari)
    if (balance !== null && amountMicrotari + MAX_FEE > balance) {
      const needed = (Number(amountMicrotari + MAX_FEE) / 1_000_000).toFixed(6)
      return `Insufficient balance — need ${needed} TARI (including ~0.01 TARI fee)`
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
    setSendRecipient('')
    setSendAmount('')
    setSendNote('')
    setSendStep('form')
    setSendValidationError('')
    setSendProgress('')
    setSendTxId('')
    setSendError('')
    setSendFee(null)
    setSendOutcome(null)
  }

  function resetMove() {
    setMoveStep('idle')
    setMoveAmount('')
    setMoveError('')
    setMoveProgress('')
    setMovePrepared(null)
    setMoveExact(null)
    setMoveLagging(false)
    setMoveTxId('')
    setMoveLanded(null)
  }

  /**
   * Price the move: dry-run it and hold onto the built envelope.
   *
   * Everything that can fail for a boring reason happens here rather than after the user has
   * confirmed — a dead indexer, an unresolvable account, a rejected simulation. Confirm then only
   * submits.
   */
  async function handlePrepareMove() {
    if (!wallet || !address) return
    setMoveStep('pricing')
    setMoveProgress('')
    setMoveError('')
    try {
      const prepared = await prepareConceal(wallet, address, {
        // The exact figure when MAX was used; the typed value otherwise. Never a re-parse of a
        // rounded display string.
        amountMicrotari: moveExact ?? tariToMicrotari(parseFloat(moveAmount)),
        onProgress: setMoveProgress,
      })
      setMovePrepared(prepared)
      setMoveStep('review')
    } catch (e) {
      // Back to the form, with the reason: at this stage nothing has been sent, so the user can
      // adjust the amount and try again without any on-chain consequence.
      setMoveError(e instanceof Error ? e.message : String(e))
      setMoveStep('form')
    }
  }

  async function handleConfirmMove() {
    if (!movePrepared) return
    setMoveStep('moving')
    setMoveProgress('')
    setMoveError('')
    try {
      const result = await movePrepared.submit(setMoveProgress)
      setMoveTxId(result.txId)
      if (result.outcome === 'Commit') {
        setMoveLanded(result.concealedAmount)
        // Committed, but not yet VISIBLE — hand off to the settle loop rather than declaring
        // success against a balance the indexer has not caught up to yet.
        movePreBalance.current = balance ?? 0n
        moveDeadline.current = Date.now() + MOVE_SETTLE_MS
        setMoveLagging(false)
        setMoveStep('settling')
        // The public side updates immediately — only the stealth listing lags — so kick both now.
        rescan()
      } else {
        setMoveError(
          result.outcome === 'Reject'
            ? 'The network rejected the transaction. Nothing was moved.'
            : 'The transaction did not reach a decision in time. It may still land — refresh your balances in a moment before retrying.',
        )
        setMoveStep('error')
      }
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e))
      setMoveStep('error')
    }
  }

  async function handleConfirmSend() {
    if (!wallet || !address) return
    setSendStep('sending')
    setSendProgress('Connecting to indexer…')
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
            ? 'The network rejected this transaction. Nothing left your wallet and no fee was taken.'
            : 'Broadcast, but the network has not confirmed it. Do not resend. It will appear in Activity.'
        )
        setSendStep('error')
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e))
      setSendStep('error')
    }
  }


  const eyeOpen = (c: string) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>)
  const eyeOff = (c: string) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></svg>)

  const spinnerSm = (
    <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.8s linear infinite', flexShrink: 0 }} />
  )

  const balLabel = { fontSize: 11, fontWeight: 600, letterSpacing: '0.14em' } as const
  const balBig = { fontFamily: MONO, fontSize: 36, fontWeight: 700 } as const
  const balTari = { fontSize: 15, fontWeight: 600, color: 'var(--teal-500)' } as const

  // ── Balance widget: the exact design card for the current state ──
  function balanceWidget() {
    const tealCard = (a: string) => ({ borderRadius: 14, padding: '22px 18px', textAlign: 'center' as const, background: `radial-gradient(320px 170px at 50% 0%, rgba(var(--teal-500-rgb),${a}), rgba(10,14,23,0))`, border: `1px solid rgba(var(--teal-500-rgb),0.2)` })
    if (status === 'scanning' && balance === null) {
      return (
        <div style={{ ...tealCard('0.1'), border: '1px solid rgba(var(--teal-500-rgb),0.18)' }}>
          <div style={{ ...balLabel, color: 'var(--text-teal-dim)', marginBottom: 14 }}>CONFIDENTIAL BALANCE</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 11, marginBottom: 10 }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.8s linear infinite' }} />
            <span style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, color: 'var(--text-teal-label)' }}>scanning…</span>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-teal-dim)' }}>{scan.progress.scanned} outputs checked</div>
        </div>
      )
    }
    if (status === 'error') {
      return (
        <div style={{ borderRadius: 14, padding: '22px 18px', textAlign: 'center', background: 'rgba(var(--danger-rgb),0.04)', border: '1px solid rgba(var(--danger-rgb),0.28)' }}>
          <div style={{ ...balLabel, color: 'var(--text-faint-dim)', marginBottom: 12 }}>CONFIDENTIAL BALANCE</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--danger-300)', marginBottom: 6 }}>Scan failed</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginBottom: 14 }}>Could not reach the Esmeralda indexer.</div>
          <span onClick={rescan} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 18px', borderRadius: 10, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', color: 'var(--danger-300)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--danger-300)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>Retry scan
          </span>
        </div>
      )
    }
    if (balanceHidden && balance !== null) {
      return (
        <div style={tealCard('0.1')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ ...balLabel, color: 'var(--text-teal-dim)' }}>CONFIDENTIAL BALANCE</span>
            <span onClick={() => setBalanceHidden(false)} style={{ cursor: 'pointer', display: 'inline-flex' }}>{eyeOff('var(--teal-500)')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 9 }}>
            <span style={{ ...balBig, color: 'var(--text-teal-label)', letterSpacing: '0.1em' }}>{HIDDEN}</span><span style={balTari}>TARI</span>
          </div>
        </div>
      )
    }
    if (balance === 0n || (balance === null && status === 'done')) {
      return (
        <div style={{ borderRadius: 14, padding: '22px 18px', textAlign: 'center', background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)' }}>
          <div style={{ ...balLabel, color: 'var(--text-faint-dim)', marginBottom: 10 }}>CONFIDENTIAL BALANCE</div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 9, marginBottom: 8 }}>
            <span style={{ ...balBig, color: 'var(--text-faint)' }}>0.00</span><span style={{ ...balTari, color: 'var(--text-faint-dim)' }}>TARI</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted-dim)' }}>Claim testnet funds below to get started.</div>
          {/* Refresh belongs HERE most of all. A zero balance is exactly the state a wallet sits in
              while a just-committed conceal — or an incoming payment — waits out the indexer's
              60–90s lag, and it was the one state with no way to re-scan: the control only rendered
              beside a non-zero balance, so the user who most needed it could not reach it. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12, fontSize: 12, color: 'var(--text-muted-dim)' }}>
            <span>{scan.totalScanned} UTXOs scanned</span>
            <span onClick={rescan} style={{ color: 'var(--teal-500)', fontWeight: 600, cursor: 'pointer' }}>Refresh</span>
          </div>
        </div>
      )
    }
    // DONE (positive balance)
    return (
      <div style={tealCard('0.13')}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ ...balLabel, color: 'var(--text-teal-dim)' }}>CONFIDENTIAL BALANCE</span>
          <span onClick={() => setBalanceHidden(true)} style={{ cursor: 'pointer', display: 'inline-flex' }}>{eyeOpen('var(--text-teal-dim)')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 9, marginBottom: scan.incomplete ? 14 : 0 }}>
          <span style={{ ...balBig, color: 'var(--text-bright)' }}>{balanceStr ?? '—'}</span><span style={balTari}>TARI</span>
        </div>
        {scan.incomplete && (
          <div style={{ display: 'flex', gap: 9, padding: '10px 12px', borderRadius: 10, background: 'rgba(var(--warn-rgb),0.05)', border: '1px solid rgba(var(--warn-rgb),0.25)', fontSize: 12, color: 'var(--warn-300)', textAlign: 'left', lineHeight: 1.45, marginBottom: 12 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
            The indexer returned its maximum result set — there may be more outputs. Balance may be understated.
          </div>
        )}
        {/* Live-app addition (deliberate deviation from the static design card): scan summary + manual refresh. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: scan.incomplete ? 0 : 12, fontSize: 12, color: 'var(--text-teal-dim)' }}>
          <span>{scan.totalScanned} UTXOs scanned · {scan.utxos.length} owned</span>
          <span onClick={rescan} style={{ color: 'var(--teal-500)', fontWeight: 600, cursor: 'pointer' }}>Refresh</span>
        </div>
      </div>
    )
  }

  // ── PUBLIC (revealed) balance row — M1, read-only ──
  //
  // Secondary to the confidential hero by design: private is what Caravel is for, public is the
  // opt-in. Rendered as its own muted row rather than a second figure inside the hero card so the
  // two can never read as parts of one number.
  //
  // THE TWO ARE NEVER SUMMED. They are different states of the same asset, and adding them would
  // invent a "total" the protocol does not have — worse, it would hide the very distinction this
  // feature exists to surface.
  function publicBalanceRow() {
    const rowBase = { borderRadius: 12, padding: '13px 15px', background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)' } as const
    const label = { ...balLabel, fontSize: 10, color: 'var(--text-muted-dim)' } as const
    const note = { fontSize: 12, color: 'var(--text-muted-dim)', lineHeight: 1.45 } as const

    // Hidden alongside the hero — one toggle covers both, or the "hide balance" gesture leaks.
    if (balanceHidden) {
      return (
        <div style={rowBase}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={label}>PUBLIC BALANCE</span>
            <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: 'var(--text-faint)', letterSpacing: '0.1em' }}>{HIDDEN}</span>
          </div>
        </div>
      )
    }

    if (revealed.status === 'idle' || revealed.status === 'loading') {
      return (
        <div style={rowBase}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={label}>PUBLIC BALANCE</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint-dim)' }}>Checking…</span>
          </div>
        </div>
      )
    }

    // UNAVAILABLE — the read threw, so we do not know. Say that; never draw a confident 0.
    if (revealed.status === 'unavailable') {
      return (
        <div style={{ ...rowBase, border: '1px solid rgba(var(--warn-rgb),0.25)', background: 'rgba(var(--warn-rgb),0.04)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ ...label, color: 'var(--warn-300)' }}>PUBLIC BALANCE</span>
            <span onClick={rescan} style={{ fontSize: 12, fontWeight: 600, color: 'var(--teal-500)', cursor: 'pointer' }}>Retry</span>
          </div>
          <div style={{ ...note, color: 'var(--warn-300)' }}>Public balance unavailable — could not reach the indexer. Your confidential balance above is unaffected.</div>
        </div>
      )
    }

    // EMPTY — the common case, and a true zero rather than an unknown one.
    if (revealed.amount === 0n) {
      return (
        <div style={rowBase}>
          <div style={{ ...label, marginBottom: 6 }}>PUBLIC BALANCE</div>
          <div style={note}>Nothing revealed. Your entire balance is confidential.</div>
        </div>
      )
    }

    // A real revealed balance.
    return (
      <div style={rowBase}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={label}>PUBLIC BALANCE</span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: 'var(--text-body)' }}>{fmtMicrotariExact(revealed.amount ?? 0n)}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted-dim)' }}>TARI</span>
          </span>
        </div>
        <div style={note}>Visible to anyone on-chain. Not included in the confidential balance above.</div>
      </div>
    )
  }

  // ── MOVE FUNDS: public → private (M2) ──
  //
  // The SAFE direction, and the UI says so by saying nothing: no warning, no confirmation friction
  // beyond a review of the numbers. Value ends up more private than it started, which is what this
  // wallet is for. (The reverse direction, when it exists, is where the copy has to work harder.)
  //
  // Priced BEFORE review, not after: prepareConceal runs the dry run and hands back a built,
  // signed envelope, so the fee on the review screen is the fee the transaction pays rather than an
  // estimate that might drift.
  function moveFundsPanel() {
    const revealedAmount = revealed.status === 'done' ? (revealed.amount ?? 0n) : 0n
    // Nothing to move, or we do not reliably know what there is — either way, no affordance.
    if (revealed.status !== 'done' || revealedAmount <= 0n) return null

    const card = { borderRadius: 12, padding: '15px 15px 16px', background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)' } as const
    const chip = (text: string, tone: 'public' | 'private') => (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 100, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
        background: tone === 'private' ? 'rgba(var(--teal-500-rgb),0.1)' : 'rgba(var(--border-rgb),0.1)',
        border: `1px solid ${tone === 'private' ? 'rgba(var(--teal-500-rgb),0.3)' : 'rgba(var(--border-rgb),0.2)'}`,
        color: tone === 'private' ? 'var(--teal-300)' : 'var(--text-muted-dim)',
      }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: tone === 'private' ? 'var(--teal-500)' : 'var(--text-faint-dim)' }} />
        {text}
      </span>
    )
    const arrow = (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
    )
    const direction = (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 14 }}>
        {chip('PUBLIC', 'public')}{arrow}{chip('PRIVATE', 'private')}
      </div>
    )
    const line = (l: string, r: string, strong = false) => (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid rgba(var(--border-rgb),0.08)' }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted-dim)' }}>{l}</span>
        <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: strong ? 700 : 500, color: strong ? 'var(--text-bright)' : 'var(--text-body-dim)' }}>{r}</span>
      </div>
    )

    // IDLE — the entry point, alongside the balance it acts on.
    if (moveStep === 'idle') {
      return (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Make private</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 3 }}>Move your public balance into confidential outputs.</div>
            </div>
            <span onClick={() => { setMoveStep('form'); setMoveAmount(''); setMoveExact(null); setMoveError('') }}
              style={{ padding: '9px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', color: 'var(--teal-300)', background: 'rgba(var(--teal-500-rgb),0.08)', border: '1px solid rgba(var(--teal-500-rgb),0.3)', flexShrink: 0 }}>
              Move
            </span>
          </div>
        </div>
      )
    }

    // FORM — amount entry with MAX.
    if (moveStep === 'form') {
      const entered = moveExact ?? (moveAmount === '' ? 0n : tariToMicrotari(parseFloat(moveAmount) || 0))
      const belowMin = moveAmount !== '' && entered < MIN_CONCEAL_MICROTARI
      const overBalance = moveAmount !== '' && entered > revealedAmount
      const bad = belowMin || overBalance || moveAmount === ''
      return (
        <div style={card}>
          {direction}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <input value={moveAmount} onChange={e => { setMoveAmount(e.target.value); setMoveExact(null); setMoveError('') }} placeholder="0.00" inputMode="decimal"
              style={{ flex: 1, padding: '11px 13px', borderRadius: 10, background: 'var(--surface-inset)', border: `1px solid ${bad && moveAmount !== '' ? 'rgba(var(--danger-rgb),0.4)' : 'rgba(var(--border-rgb),0.18)'}`, color: 'var(--text-bright)', fontFamily: MONO, fontSize: 15, outline: 'none' }} />
            {/* MAX is the WHOLE revealed balance, to the microtari: the amount is what leaves the
                vault and the fee is carved out of it, so it can never ask for more than exists —
                PROVIDED it is not rounded on the way through. Both the exact value and its
                full-precision rendering are set. */}
            <span onClick={() => { setMoveExact(revealedAmount); setMoveAmount(microtariToInput(revealedAmount)); setMoveError('') }}
              style={{ padding: '11px 13px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer', color: 'var(--teal-300)', background: 'rgba(var(--teal-500-rgb),0.08)', border: '1px solid rgba(var(--teal-500-rgb),0.28)' }}>MAX</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginBottom: 12 }}>
            Available public: <span style={{ fontFamily: MONO, color: 'var(--text-body-dim)' }}>{fmtMicrotariExact(revealedAmount)} TARI</span>
          </div>
          {belowMin && <div style={{ fontSize: 12, color: 'var(--danger-300)', marginBottom: 10 }}>Minimum {fmtMicrotariExact(MIN_CONCEAL_MICROTARI)} TARI.</div>}
          {overBalance && <div style={{ fontSize: 12, color: 'var(--danger-300)', marginBottom: 10 }}>More than your public balance.</div>}
          {moveError && <div style={{ fontSize: 12, color: 'var(--danger-300)', marginBottom: 10, lineHeight: 1.45 }}>{moveError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <span onClick={() => setMoveStep('idle')} style={{ flex: 1, textAlign: 'center', padding: 11, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text-muted-dim)', border: '1px solid rgba(var(--border-rgb),0.18)' }}>Cancel</span>
            <span onClick={() => { if (!bad) void handlePrepareMove() }}
              style={{ flex: 2, textAlign: 'center', padding: 11, borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: bad ? 'not-allowed' : 'pointer', opacity: bad ? 0.45 : 1, color: 'var(--teal-300)', background: 'rgba(var(--teal-500-rgb),0.1)', border: '1px solid rgba(var(--teal-500-rgb),0.32)' }}>Review</span>
          </div>
        </div>
      )
    }

    // PRICING — the dry run, between form and review.
    if (moveStep === 'pricing') {
      return (
        <div style={card}>
          {direction}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '10px 0', fontSize: 13, color: 'var(--text-muted-dim)' }}>
            {spinnerSm}{moveProgress || 'Checking the network fee…'}
          </div>
        </div>
      )
    }

    // REVIEW — plain confirm. No warning: this direction increases privacy.
    if (moveStep === 'review' && movePrepared) {
      return (
        <div style={card}>
          {direction}
          {line('Moving from public', `${fmtMicrotariExact(movePrepared.withdrawAmount)} TARI`)}
          {line('Network fee', `${fmtMicrotariExact(movePrepared.feeMicrotari)} TARI`)}
          {line('Becomes private', `${fmtMicrotariExact(movePrepared.concealedAmount)} TARI`, true)}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <span onClick={() => setMoveStep('form')} style={{ flex: 1, textAlign: 'center', padding: 11, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text-muted-dim)', border: '1px solid rgba(var(--border-rgb),0.18)' }}>Back</span>
            <span onClick={() => void handleConfirmMove()}
              style={{ flex: 2, textAlign: 'center', padding: 11, borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', color: 'var(--ink-on-teal, #04120f)', background: 'var(--teal-500)' }}>Make private</span>
          </div>
        </div>
      )
    }

    // MOVING — in flight. The entry point is gone from the tree while this renders, so there is
    // nothing to press twice.
    if (moveStep === 'moving') {
      return (
        <div style={{ ...card, border: '1px solid rgba(var(--teal-500-rgb),0.28)' }}>
          {direction}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontSize: 13, color: 'var(--text-teal-label)', marginBottom: 6 }}>
            {spinnerSm}Making {fmtMicrotariExact(movePrepared?.concealedAmount ?? 0n)} TARI private
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', textAlign: 'center' }}>{moveProgress || 'Submitting…'}</div>
        </div>
      )
    }

    // SETTLING — committed on-chain, waiting for the stealth listing to catch up.
    if (moveStep === 'settling') {
      return (
        <div style={{ ...card, border: '1px solid rgba(var(--teal-500-rgb),0.28)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontSize: 13, color: 'var(--text-teal-label)', marginBottom: 6 }}>
            {spinnerSm}Settling on-chain…
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', textAlign: 'center', lineHeight: 1.45 }}>
            {fmtMicrotariExact(moveLanded ?? 0n)} TARI is now private. Your confidential balance updates once the network indexes the new output — usually under a minute.
          </div>
        </div>
      )
    }

    if (moveStep === 'success') {
      return (
        <div style={{ ...card, border: '1px solid rgba(var(--teal-500-rgb),0.3)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-bright)', marginBottom: 4 }}>
            {fmtMicrotariExact(moveLanded ?? 0n)} TARI is now private
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginBottom: 12, lineHeight: 1.45 }}>
            {moveLagging
              ? 'Confirmed on-chain. Your confidential balance hasn’t caught up yet — the network is still indexing the new output. Tap Refresh in a moment; nothing is at risk.'
              : 'Your public balance dropped by that much plus the fee.'}
          </div>
          {moveTxId && hashRow(moveTxId)}
          <span onClick={resetMove} style={{ display: 'block', textAlign: 'center', marginTop: 12, padding: 10, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--teal-300)', border: '1px solid rgba(var(--teal-500-rgb),0.28)' }}>Done</span>
        </div>
      )
    }

    // ERROR — the actual message, verbatim. This path had never run on-chain before M2 shipped, so
    // a generic "something went wrong" would throw away the one useful thing we have.
    return (
      <div style={{ ...card, border: '1px solid rgba(var(--danger-rgb),0.3)', background: 'rgba(var(--danger-rgb),0.04)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger-300)', marginBottom: 6 }}>The move did not go through</div>
        <div style={{ fontSize: 12, color: 'var(--text-body-dim)', marginBottom: 12, lineHeight: 1.5, wordBreak: 'break-word' }}>{moveError || 'Unknown error.'}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginBottom: 12 }}>Nothing moved — your balances are unchanged.</div>
        {moveTxId && hashRow(moveTxId)}
        <span onClick={resetMove} style={{ display: 'block', textAlign: 'center', marginTop: 12, padding: 10, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text-muted-dim)', border: '1px solid rgba(var(--border-rgb),0.18)' }}>Close</span>
      </div>
    )
  }

  const tabItem = (t: Tab) => {
    const on = tab === t
    return (
      <span key={t} onClick={() => setTab(t)} style={{ flex: 1, textAlign: 'center', padding: '9px 0', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: on ? 700 : 600, background: on ? 'var(--surface-inset)' : 'transparent', color: on ? 'var(--text-bright)' : 'var(--text-muted-dim)', boxShadow: on ? 'inset 0 0 0 1px rgba(var(--teal-500-rgb),0.22)' : 'none' }}>
        {t.charAt(0).toUpperCase() + t.slice(1)}
      </span>
    )
  }

  const copyIcon = (c = 'var(--teal-500)') => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>)
  const hashRow = (h: string) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)' }}>
      <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-body-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.slice(0, 8)}…{h.slice(-4)}</span>
      <span onClick={() => navigator.clipboard.writeText(h).catch(() => {})} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--teal-500)', cursor: 'pointer', flexShrink: 0, marginLeft: 8 }}>{copyIcon()}Copy</span>
    </div>
  )

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,14,0.78)', backdropFilter: 'blur(3px)', zIndex: 200 }} />

      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(460px, 94vw)', maxHeight: '88vh', background: 'var(--surface)', borderRadius: 20, border: '1px solid rgba(var(--border-rgb),0.2)', boxShadow: '0 30px 90px rgba(0,0,0,0.65)', zIndex: 201, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Logo size={20} mono />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Wallet</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 100, background: 'rgba(var(--warn-rgb),0.06)', border: '1px solid rgba(var(--warn-rgb),0.28)' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--warn)' }} />
              <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--warn-300)' }}>Esmeralda testnet</span>
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ padding: '3px 7px', borderRadius: 6, border: '1px solid rgba(var(--border-rgb),0.18)', fontFamily: MONO, fontSize: 10, color: 'var(--text-faint-dim)' }}>Esc</span>
            <span onClick={onClose} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(var(--border-rgb),0.16)', cursor: 'pointer' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </span>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ padding: '14px 18px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 4, padding: 5, borderRadius: 12, background: 'var(--surface-trough)', border: '1px solid rgba(var(--border-rgb),0.1)' }}>
            {(['overview', 'send', 'receive', 'activity'] as Tab[]).map(tabItem)}
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>

          {/* ═══ OVERVIEW ═══ */}
          {tab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {balanceWidget()}
              {publicBalanceRow()}
              {moveFundsPanel()}

              {shortAddr && (
                <div onClick={copyAddr} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)', cursor: 'pointer' }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: addrCopied ? 'var(--teal-300)' : 'var(--text-body-dim)' }}>{addrCopied ? 'Copied' : shortAddr}</span>
                  {copyIcon()}
                </div>
              )}

              <FaucetClaimPanel />

              <div style={{ display: 'flex', gap: 10 }}>
                <div onClick={() => setTab('send')} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 13, borderRadius: 12, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>Send
                </div>
                <div onClick={() => setTab('receive')} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 13, borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>Receive
                </div>
              </div>

              <OnsRegisterPanel />
            </div>
          )}

          {/* ═══ SEND ═══ */}
          {tab === 'send' && (
            <div>
              {sendStep === 'form' && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-faint-dim)', marginBottom: 8 }}>RECIPIENT</div>
                  <input value={sendRecipient} onChange={e => { setSendRecipient(e.target.value); setSendValidationError('') }} placeholder="otl_esm_… or @name" spellCheck={false} style={{ width: '100%', boxSizing: 'border-box', padding: '13px 15px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.14)', fontFamily: MONO, fontSize: 13, color: 'var(--text-body)', outline: 'none', marginBottom: 16 }} />

                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-faint-dim)', marginBottom: 8 }}>AMOUNT</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderRadius: 11, background: 'var(--surface-raised)', border: `1px solid ${sendValidationError ? 'rgba(var(--danger-rgb),0.5)' : 'rgba(var(--border-rgb),0.14)'}`, marginBottom: sendValidationError ? 10 : 16 }}>
                    <input type="number" min="0" value={sendAmount} onChange={e => { setSendAmount(e.target.value); setSendValidationError('') }} placeholder="0.00" style={{ background: 'none', border: 'none', outline: 'none', fontFamily: MONO, fontSize: 15, color: 'var(--text-body)', flex: 1 }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: sendValidationError ? 'var(--danger-300)' : 'var(--teal-500)' }}>TARI</span>
                  </div>
                  {sendValidationError && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, marginBottom: 16 }}>
                      <span style={{ color: 'var(--danger-300)' }}>{sendValidationError}</span>
                      {balance !== null && <span style={{ fontFamily: MONO, color: 'var(--text-faint)' }}>available {fmt2(balance)}</span>}
                    </div>
                  )}

                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-faint-dim)', marginBottom: 8 }}>PRIVATE NOTE · OPTIONAL</div>
                  <textarea value={sendNote} onChange={e => setSendNote(e.target.value)} placeholder="Only your recipient sees this" rows={2} style={{ width: '100%', boxSizing: 'border-box', padding: '13px 15px', borderRadius: 11, background: 'var(--surface-raised)', border: `1px ${sendNote ? 'solid' : 'dashed'} rgba(var(--teal-500-rgb),0.24)`, fontSize: 13, color: sendNote ? 'var(--text-body)' : 'var(--text-faint-dim)', outline: 'none', resize: 'vertical', fontFamily: 'inherit', fontStyle: sendNote ? 'normal' : 'italic', marginBottom: 16 }} />

                  <div style={{ display: 'flex', gap: 9, padding: '11px 13px', borderRadius: 11, background: 'rgba(var(--teal-500-rgb),0.05)', border: '1px solid rgba(var(--teal-500-rgb),0.22)', fontSize: 12, color: 'var(--teal-300)', lineHeight: 1.5, marginBottom: 16 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    Confidential. The amount and your address stay hidden on chain.
                  </div>

                  {(() => { const on = !!sendRecipient && !!sendAmount; return (
                    <div onClick={on ? handleReview : undefined} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, background: on ? 'var(--teal-grad)' : 'rgba(16,21,31,0.6)', border: on ? 'none' : '1px solid rgba(var(--border-rgb),0.12)', color: on ? 'var(--ink-on-accent)' : 'var(--text-disabled)', fontSize: 14, fontWeight: 700, cursor: on ? 'pointer' : 'default' }}>Review payment</div>
                  ) })()}
                </>
              )}

              {sendStep === 'review' && (
                <>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>Confirm payment</div>
                  <div style={{ borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)', overflow: 'hidden', marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderBottom: '1px solid rgba(var(--border-rgb),0.08)' }}><span style={{ fontSize: 13, color: 'var(--text-muted-dim)' }}>To</span><span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--text-body)' }}>{sendRecipient.length > 24 ? sendRecipient.slice(0, 14) + '…' + sendRecipient.slice(-6) : sendRecipient}</span></div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderBottom: '1px solid rgba(var(--border-rgb),0.08)' }}><span style={{ fontSize: 13, color: 'var(--text-muted-dim)' }}>Amount</span><span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: 'var(--text-bright)' }}>{sendAmount} TARI</span></div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px' }}><span style={{ fontSize: 13, color: 'var(--text-muted-dim)' }}>Network fee</span><span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--text-muted)' }}>≤ {fmtFee(MAX_FEE)} TARI</span></div>
                  </div>
                  {sendNote && (
                    <div style={{ padding: '12px 14px', borderRadius: 11, background: 'rgba(10,14,23,0.6)', border: '1px dashed rgba(var(--teal-500-rgb),0.26)', marginBottom: 16 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-teal-dim)', marginBottom: 6 }}>PRIVATE NOTE</div>
                      <div style={{ fontSize: 13, color: 'var(--text-note)', fontStyle: 'italic' }}>“{sendNote}”</div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div onClick={() => setSendStep('form')} style={{ flex: '0 0 110px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, border: '1px solid rgba(var(--border-rgb),0.2)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Back</div>
                    <div onClick={handleConfirmSend} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Confirm and send</div>
                  </div>
                </>
              )}

              {sendStep === 'sending' && (
                <div style={{ padding: '44px 20px', borderRadius: 16, background: 'var(--surface)', border: '1px solid rgba(var(--teal-500-rgb),0.24)', textAlign: 'center' }}>
                  <span style={{ display: 'inline-flex', width: 44, height: 44, borderRadius: '50%', border: '3px solid rgba(var(--teal-500-rgb),0.18)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.9s linear infinite', marginBottom: 20 }} />
                  <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-bright)', marginBottom: 8 }}>Sending {sendAmount} TARI</div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', lineHeight: 1.5, maxWidth: 280, margin: '0 auto' }}>{sendProgress || 'Building the confidential proof and broadcasting. Do not close this window.'}</div>
                </div>
              )}

              {sendStep === 'success' && (
                <div style={{ padding: '32px 20px 20px', borderRadius: 16, background: 'linear-gradient(170deg, rgba(var(--teal-500-rgb),0.07), var(--surface) 62%)', border: '1px solid rgba(var(--teal-500-rgb),0.34)', textAlign: 'center' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(var(--teal-500-rgb),0.14)', border: '1px solid rgba(var(--teal-500-rgb),0.4)', marginBottom: 16 }}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  </span>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-bright)', marginBottom: 6 }}>Sent</div>
                  <div style={{ fontSize: 14, color: 'var(--text-teal-label)', marginBottom: 20 }}>{sendAmount} TARI to {sendRecipient.slice(0, 10)}…{sendRecipient.slice(-4)}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, color: 'var(--text-muted-dim)' }}>Fee</span>
                    <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--text-bright)' }}>{sendFee !== null ? `${fmtFee(sendFee)} TARI` : `≤ ${fmtFee(MAX_FEE)} TARI`}</span>
                  </div>
                  {sendTxId && <div style={{ marginBottom: 18 }}>{hashRow(sendTxId)}</div>}
                  <div onClick={resetSend} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Done</div>
                </div>
              )}

              {sendStep === 'error' && sendOutcome !== 'Timeout' && (
                <div style={{ padding: '32px 20px 20px', borderRadius: 16, background: 'var(--surface)', border: '1px solid rgba(var(--danger-rgb),0.3)', textAlign: 'center' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(var(--danger-rgb),0.1)', border: '1px solid rgba(var(--danger-rgb),0.35)', marginBottom: 16 }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </span>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--danger-300)', marginBottom: 6 }}>Rejected</div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted-dim)', lineHeight: 1.5, marginBottom: 20, maxWidth: 300, marginLeft: 'auto', marginRight: 'auto' }}>{sendError}</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div onClick={resetSend} style={{ flex: '0 0 110px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, border: '1px solid rgba(var(--border-rgb),0.2)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Cancel</div>
                    <div onClick={() => { setSendStep('review'); setSendError('') }} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', color: 'var(--danger-300)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Try again</div>
                  </div>
                </div>
              )}

              {sendStep === 'error' && sendOutcome === 'Timeout' && (
                <div style={{ padding: '32px 20px 20px', borderRadius: 16, background: 'var(--surface)', border: '1px solid rgba(var(--warn-rgb),0.3)', textAlign: 'center' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(var(--warn-rgb),0.1)', border: '1px solid rgba(var(--warn-rgb),0.35)', marginBottom: 16 }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  </span>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--warn-300)', marginBottom: 6 }}>Not confirmed yet</div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted-dim)', lineHeight: 1.5, marginBottom: 18, maxWidth: 300, marginLeft: 'auto', marginRight: 'auto' }}>{sendError}</div>
                  {sendTxId && <div style={{ marginBottom: 18 }}>{hashRow(sendTxId)}</div>}
                  <div onClick={() => { resetSend(); setTab('activity') }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>View in Activity</div>
                </div>
              )}
            </div>
          )}

          {/* ═══ RECEIVE ═══ */}
          {tab === 'receive' && (
            !address ? (
              <div style={{ padding: '24px 20px', borderRadius: 16, background: 'var(--surface)', border: '1px solid rgba(var(--border-rgb),0.16)', textAlign: 'center' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 178, height: 178, borderRadius: 14, background: 'var(--surface-raised)', border: '1px dashed rgba(var(--border-rgb),0.2)', marginBottom: 16 }}>
                  <span style={{ width: 30, height: 30, borderRadius: '50%', border: '3px solid rgba(var(--border-rgb),0.15)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.9s linear infinite' }} />
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Deriving your address</div>
                <div style={{ fontSize: 13, color: 'var(--text-faint)', marginBottom: 14, lineHeight: 1.5 }}>This happens locally, in your browser.</div>
                <div style={{ height: 42, borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.1)', marginBottom: 12 }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 13, borderRadius: 12, background: 'rgba(16,21,31,0.6)', border: '1px solid rgba(var(--border-rgb),0.12)', color: 'var(--text-disabled)', fontSize: 14, fontWeight: 700 }}>Copy address</div>
              </div>
            ) : (
              <div style={{ padding: '24px 20px', borderRadius: 16, background: 'var(--surface)', border: '1px solid rgba(var(--border-rgb),0.16)', textAlign: 'center' }}>
                <div style={{ display: 'inline-flex', padding: 14, borderRadius: 14, background: 'var(--text-bright)', marginBottom: 16 }}>
                  <QRCodeSVG value={address} size={150} bgColor="#EAFBF7" fgColor="#04120F" level="M" />
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginBottom: 14, lineHeight: 1.5 }}>Share this address to receive confidential payments.</div>
                <div style={{ padding: '13px 15px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)', fontFamily: MONO, fontSize: 12, color: 'var(--text-body-dim)', lineHeight: 1.6, wordBreak: 'break-all', textAlign: 'left', marginBottom: 12 }}>{address}</div>
                <div onClick={copyAddr} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 13, borderRadius: 12, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  {copyIcon('var(--ink-on-accent)')}{addrCopied ? 'Copied' : 'Copy address'}
                </div>
              </div>
            )
          )}

          {/* ═══ ACTIVITY ═══ */}
          {tab === 'activity' && (() => {
            // Derived from the two authoritative sources (wallet sends + message-linked payments),
            // never the blind scan — see buildActivity. Balance still counts all owned UTXOs.
            const activity = buildActivity(txHistory, messages)
            return activity.length === 0 ? (
              <div style={{ padding: '56px 24px', borderRadius: 16, background: 'var(--surface)', border: '1px solid rgba(var(--border-rgb),0.16)', textAlign: 'center' }}>
                <Logo size={40} mono style={{ opacity: 0.3, marginBottom: 16 }} />
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>No transactions yet</div>
                <div style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.5, maxWidth: 250, margin: '0 auto' }}>Payments you send and receive will appear here.</div>
              </div>
            ) : (
              <div style={{ padding: 0, borderRadius: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 13px 12px', borderBottom: '1px solid rgba(var(--border-rgb),0.07)' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-faint-dim)' }}>CONFIDENTIAL</span>
                  <span onClick={() => setBalanceHidden(v => !v)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: balanceHidden ? 'var(--teal-500)' : 'var(--text-teal-dim)', cursor: 'pointer' }}>
                    {balanceHidden ? eyeOff('var(--teal-500)') : eyeOpen('var(--text-teal-dim)')}{balanceHidden ? 'Show amounts' : 'Hide amounts'}
                  </span>
                </div>
                {activity.map(row => row.kind === 'sent'
                  ? <SentActivityRow key={row.id} row={row} hidden={balanceHidden} />
                  : <ReceivedActivityRow key={row.id} row={row} hidden={balanceHidden} />)}
              </div>
            )
          })()}

        </div>
      </div>
    </>
  )
}
