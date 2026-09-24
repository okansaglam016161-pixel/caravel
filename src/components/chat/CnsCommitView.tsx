//   CNS — the commit half of registration: fee, submit, and what the chain actually did (§10D).
//
//   ── THIS ONE SPENDS MONEY ────────────────────────────────────────────────────
//
//   Every other CNS screen reads. This one writes, irreversibly, for a fee that is consumed whether
//   or not a name is registered — so the rules it follows are not stylistic:
//
//     · THE FEE IS SHOWN AND APPROVED BEFORE ANYTHING IS SENT. Estimating is a dry-run; nothing is
//       spent by it, and the gate below it is the only route to a submission.
//     · SUCCESS MEANS A TRUE ON-CHAIN ACCEPT AND NOTHING ELSE. The writer classifies on
//       `execution_result.finalize.result`, never on `final_decision` — trusting the latter is what
//       used to report success for transactions that only ever committed a fee.
//     · A BURNED FEE IS DISCLOSED IN FULL. Not "something went wrong": the amount, the fact that no
//       name was registered, and the transaction to look it up by.
//     · A TIMEOUT IS PENDING, NOT FAILURE. We stopped waiting; the chain did not stop working. It
//       renders warn, never red, and the action is to go and look rather than to confidently retry.
//
//   ── WHAT WE REFUSE TO SAY ────────────────────────────────────────────────────
//
//   The writer's rejection sentence asserts "the fee was too low". It builds that from the outcome
//   alone and discards the chain's actual reason — so it is wrong precisely when somebody has lost a
//   name to a faster transaction. We do not repeat it. Instead, after a rejection, we ASK: one more
//   keyless availability read, free, which either finds the name taken (and then we can say so,
//   because we looked) or does not, in which case the screen reports the rejection and the spend and
//   claims no cause at all.
//
//   ── THE JOURNAL IS THE SAME ONE THE WALLET WRITES ────────────────────────────
//
//   Entry opened BEFORE submitting, so a crash, a closed tab or a throw all leave a record. A
//   non-Accept settles as `pending` — attempted, never failed — which is what makes Activity's
//   neutral "attempted" row honest, and what the timeout screen is telling you to go and read.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import {
  checkOnsAvailable, estimateOnsRegistration, registerOnsName,
  type OnsEstimateErrorKind,
} from '../../crypto/ons'
import { beginEntry, markDegraded, settleEntry } from '../../crypto/journalStore'
import { fetchCreatedUtxoIds } from '../../crypto/txOutputs'
import { fmt6 } from '../wallet/v2/format'
import { MONO } from './chatDisplay'

/** µtTARI as the product says it everywhere else. One formatter, one unit on screen. */
const XTR = (micro: bigint) => `${fmt6(micro)} XTR`

type Commit =
  | { kind: 'estimating' }
  | { kind: 'estimate-failed'; errorKind: OnsEstimateErrorKind; error: string }
  | { kind: 'confirm'; budget: bigint }
  | { kind: 'submitting' }
  /** A true on-chain Accept. The only success. */
  | { kind: 'accepted'; txId?: string }
  /** Rejected, fee spent, cause NOT claimed. */
  | { kind: 'fee-burned'; txId?: string; spent: bigint }
  /** Rejected, fee spent, and a second look found the name gone. Cause established by evidence. */
  | { kind: 'taken'; txId?: string; spent: bigint }
  /** We stopped waiting. Pending, not failed. */
  | { kind: 'timed-out'; txId?: string }

const Ring = ({ size = 12 }: { size?: number }) => (
  <span style={{
    width: size, height: size, borderRadius: 99, flexShrink: 0,
    border: '2px solid var(--border)', borderTopColor: 'var(--accent-400)',
    animation: 'cv-spin 0.8s linear infinite',
  }} />
)

/** The 44px outcome disc. Tone is the whole message before a word is read, so it is never decorative. */
function Emblem({ tone, children }: { tone: 'positive' | 'danger' | 'warn'; children: React.ReactNode }) {
  const ink = tone === 'positive' ? 'var(--positive)' : tone === 'danger' ? 'var(--danger-500)' : 'var(--warn)'
  const rgb = tone === 'positive' ? '--positive-rgb' : tone === 'danger' ? '--danger-rgb' : '--warn-rgb'
  return (
    <span style={{
      width: 44, height: 44, borderRadius: 99, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `rgba(var(${rgb}),0.12)`, color: ink,
    }}>{children}</span>
  )
}

/**
 * The transaction reference. ON EVERY OUTCOME THAT TOUCHED THE CHAIN, because it is the only thing
 * that makes a spend checkable after the fact — a burned fee with no reference is a number the user
 * has to take on trust.
 */
function TxRow({ txId }: { txId: string }) {
  const [copied, setCopied] = useState(false)
  const short = txId.length > 18 ? `${txId.slice(0, 6)}…${txId.slice(-6)}` : txId
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
      padding: '9px 12px', borderRadius: 10, border: '1px solid var(--border)',
    }}>
      <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.12em', color: 'var(--text-muted-dim)', flexShrink: 0 }}>TX</span>
      <span title={txId} style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, color: 'var(--text-body-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{short}</span>
      <button
        onClick={() => {
          navigator.clipboard.writeText(txId).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }).catch(() => { /* clipboard refused — the id is on screen and on hover regardless */ })
        }}
        title="Copy transaction id"
        aria-label="Copy transaction id"
        style={{
          flexShrink: 0, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer',
          color: copied ? 'var(--positive)' : 'var(--text-muted-dim)',
          fontFamily: 'inherit', fontSize: 10.5, fontWeight: 600,
          display: 'flex', alignItems: 'center',
        }}
      >
        {copied ? 'Copied' : (
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x={9} y={9} width={13} height={13} rx={2} /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        )}
      </button>
    </div>
  )
}

const ACTIONS: React.CSSProperties = { display: 'flex', gap: 8, marginTop: 12 }
const BTN: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 10, textAlign: 'center',
  fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
}
const QUIET: React.CSSProperties = {
  ...BTN, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-body-dim)',
}
const PRIMARY: React.CSSProperties = {
  ...BTN, border: 'none', background: 'var(--accent-400)', color: 'var(--ink-on-accent)',
}

/** Centred outcome head — emblem, one line of verdict, one of consequence. */
function Outcome({ tone, title, children, emblem }: {
  tone: 'positive' | 'danger' | 'warn'
  title: string
  emblem: React.ReactNode
  children: React.ReactNode
}) {
  const ink = tone === 'positive' ? 'var(--text-primary)' : tone === 'danger' ? 'var(--danger-500)' : 'var(--warn)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10, padding: '6px 0 2px' }}>
      <Emblem tone={tone}>{emblem}</Emblem>
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: ink }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-body-dim)', lineHeight: 1.55, maxWidth: 300, textWrap: 'pretty' }}>{children}</div>
    </div>
  )
}

const CheckMark = () => <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
const Cross = () => <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
const Clock = () => <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx={12} cy={12} r={9} /><path d="M12 7v5l3 3" /></svg>

export default function CnsCommitView({ name, onCancel, onDone, onTryAnother, onOpenWallet }: {
  name: string
  /** Back to the availability screen, with its answer intact. Nothing has been written. */
  onCancel: () => void
  /** Finished — return to the list, which re-reads. */
  onDone: () => void
  /** The name is gone; go back and pick a different one. */
  onTryAnother: () => void
  /** Switch to the Wallet service so "Check Activity" goes somewhere. */
  onOpenWallet: () => void
}) {
  const { wallet, address, nostrNpub } = useWallet()
  const [state, setState] = useState<Commit>({ kind: 'estimating' })

  /**
   * A GENERATION, NOT A LIVE FLAG — and the difference is why this used to hang.
   *
   * It was a `live` ref set false by an unmount cleanup. StrictMode mounts, tears down and mounts
   * again in development, so the cleanup ran and the setup never re-armed it: every subsequent
   * result was discarded and the screen sat on "estimating" forever, with 200s in the network tab.
   * A flag owned by the component's lifetime cannot guard work fired repeatedly during it.
   *
   * A generation is owned by the RUN. Each call stamps one and only writes if it is still the
   * newest, which fixes the hang and also closes a race the boolean never could: Try again fired
   * while a previous attempt is still in flight can no longer let the older answer land last.
   *
   * Same idiom as CnsRegisterView's availability check and the compose resolver. All three CNS
   * async paths now guard the same way — per-run, never per-mount.
   */
  const gen = useRef(0)

  const estimate = useCallback(async () => {
    if (!wallet || !address || !nostrNpub) {
      setState({ kind: 'estimate-failed', errorKind: 'unreachable', error: 'This wallet is locked.' })
      return
    }
    const mine = ++gen.current
    setState({ kind: 'estimating' })
    const r = await estimateOnsRegistration(wallet, address, name, nostrNpub)
    if (gen.current !== mine) return
    if (!r.ok || r.feeMicroTari === undefined) {
      setState({ kind: 'estimate-failed', errorKind: r.errorKind ?? 'unreachable', error: r.error ?? 'Could not work out the fee.' })
      return
    }
    setState({ kind: 'confirm', budget: r.feeMicroTari })
  }, [wallet, address, nostrNpub, name])

  useEffect(() => { void estimate() }, [estimate])

  async function submit(budget: bigint) {
    if (!wallet || !address || !nostrNpub) return
    // Stamped like the estimate. NOTE WHAT IS NOT GUARDED: everything below writes to the JOURNAL
    // unconditionally, and must. A superseded run may not touch the screen, but the transaction it
    // sent is real and its record has to be written whether or not anyone is still looking.
    const mine = ++gen.current
    setState({ kind: 'submitting' })

    // ── JOURNALLED BEFORE THE WRITE, NOT AFTER ──
    //
    // Verbatim the wallet's own registration entry, so both surfaces leave the same record. Two
    // things depend on it: reconciliation must know this transaction's change output is OURS (a
    // stealth output carries no sender, and an unrecorded one gets reported as money from a
    // stranger), and the txId has to outlive this component — which is exactly what a timeout needs,
    // since the screen it produces sends you to Activity to look the transaction up.
    const journalId = beginEntry(address, {
      kind: 'ons-register',
      amountMicrotari: null,      // nothing is sent; the fee is the whole cost
      feeMicrotari: null,
      from: 'private',
      to: 'private',              // the change comes straight back to us
      counterparty: { kind: 'self', value: address },
      note: null,
      source: 'local-journal',
      selfOutputIds: null,
      spentInputIds: null,             // the ONS path does not report its inputs
    }).entry.id

    const r = await registerOnsName(wallet, address, name, nostrNpub, budget)

    if (!r.ok) {
      // ATTEMPTED, NOT FAILED. `pending` is what Activity draws neutral — nothing here is known to
      // have gone wrong in the sense a red row would claim, and for a timeout nothing is known at all.
      settleEntry(address, journalId, { outcome: 'pending' })
      if (gen.current !== mine) return

      if (r.outcome === 'timed-out' || r.outcome === 'not-submitted') {
        setState({ kind: 'timed-out', txId: r.txId })
        return
      }

      // ── WE DO NOT GUESS WHY. WE LOOK. ──
      //
      // The writer's sentence blames the fee; it cannot know that, and it is wrong exactly when
      // somebody has just lost the name. One free keyless read settles it: if the name now reads as
      // registered, it went to somebody else and we can say so because we checked. If it reads free,
      // or the check itself fails, the screen reports the rejection and the spend and claims nothing
      // about the cause.
      const after = await checkOnsAvailable(name)
      if (gen.current !== mine) return
      const gone = after.ok && after.available === false
      setState({ kind: gone ? 'taken' : 'fee-burned', txId: r.txId, spent: budget })
      return
    }

    settleEntry(address, journalId, {
      outcome: 'committed',
      txId: r.txId ?? null,
      feeMicrotari: r.fee ?? null,
    })
    if (gen.current === mine) setState({ kind: 'accepted', txId: r.txId })

    // Read back the change output this created. AFTER the screen has been told it succeeded — it
    // did, and a slow indexer must not make it look otherwise. A miss here is a repairable hole
    // (`selfOutputIds` stays null and reconciliation refuses to classify against it), which is why
    // it does not degrade the epoch; a commit with no transaction id is not repairable and does.
    if (r.txId) {
      const created = await fetchCreatedUtxoIds(r.txId)
      if (created !== null) settleEntry(address, journalId, { outcome: 'committed', selfOutputIds: created })
    } else {
      markDegraded(address)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)', marginBottom: 11 }}>
        Register @{name}
      </div>
      {commitBody(state, name, { estimate, submit, onCancel, onDone, onTryAnother, onOpenWallet })}
    </div>
  )
}

interface Acts {
  estimate: () => Promise<void>
  submit: (budget: bigint) => Promise<void>
  onCancel: () => void
  onDone: () => void
  onTryAnother: () => void
  onOpenWallet: () => void
}

/** One switch, exhaustive by construction — see the `never` at the foot. */
function commitBody(state: Commit, name: string, a: Acts) {
  switch (state.kind) {
    case 'estimating':
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: 'var(--text-body-dim)', padding: '6px 0' }}>
            <Ring />Working out the network fee…
          </div>
          {/* CANCEL ONLY. There is nothing to approve until the fee exists, and a register button
              sitting here would be asking for consent to an amount nobody has been shown. */}
          <div style={ACTIONS}>
            <button onClick={a.onCancel} style={QUIET}>Cancel</button>
          </div>
        </>
      )

    case 'estimate-failed': {
      // THREE PROBLEMS, THREE THINGS TO DO. An empty wallet, a balance in the wrong shape, and a
      // network that would not answer are not one error — only the last is worth retrying, and only
      // the middle one has a fix the user can act on. Nothing was spent in any of them.
      const network = state.errorKind === 'unreachable'
      const copy = state.errorKind === 'no-balance'
        ? 'This wallet needs a balance to pay the network fee.'
        : state.errorKind === 'fragmented'
        ? 'Your balance is split across too many outputs to cover the fee from one. Consolidate first.'
        : state.errorKind === 'policy'
        ? state.error
        : 'Couldn’t work out the fee. This is a network problem. Try again.'
      return (
        <>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 5, padding: '11px 13px', borderRadius: 11,
            background: network ? 'var(--card-warn)' : 'var(--card-danger)',
            border: `1px solid ${network ? 'var(--warn)' : 'var(--border)'}`,
          }}>
            <div style={{ fontSize: 12, color: 'var(--text-body-dim)', lineHeight: 1.5, textWrap: 'pretty' }}>{copy}</div>
            {network && (
              <button
                onClick={() => { void a.estimate() }}
                style={{
                  alignSelf: 'flex-start', marginTop: 2, padding: '6px 13px', borderRadius: 8,
                  border: '1px solid var(--warn)', background: 'transparent', color: 'var(--warn)',
                  fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                }}
              >
                Try again
              </button>
            )}
          </div>
          <div style={ACTIONS}>
            <button onClick={a.onCancel} style={QUIET}>Back</button>
          </div>
        </>
      )
    }

    case 'confirm':
      return (
        <>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 13px',
            borderRadius: 11, border: '1px solid var(--border)', background: 'var(--surface-base)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
              <span style={{ color: 'var(--text-muted-dim)' }}>Name</span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>@{name}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
              <span style={{ color: 'var(--text-muted-dim)' }}>Network fee</span>
              <span style={{ fontFamily: MONO, fontWeight: 600, color: 'var(--text-primary)' }}>{XTR(state.budget)}</span>
            </div>
          </div>
          {/* THE GATE SAYS WHAT PRESSING IT COSTS, and that nothing has happened yet. The whole
              revealed budget is consumed on this path, so the figure above is not an estimate of
              what might be taken — it is what leaves. */}
          <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 8, lineHeight: 1.5, textWrap: 'pretty' }}>
            The fee leaves your wallet when you press Register. Nothing has been written yet.
          </div>
          <div style={ACTIONS}>
            <button onClick={a.onCancel} style={QUIET}>Cancel</button>
            <button onClick={() => { void a.submit(state.budget) }} className="cv-btn-primary" style={PRIMARY}>Register @{name}</button>
          </div>
        </>
      )

    case 'submitting':
      // NO ACTIONS. There is nothing to cancel — the transaction is with the network, and a button
      // implying otherwise would be offering a control over something we no longer hold.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '14px 0 8px', textAlign: 'center' }}>
          <Ring size={16} />
          <div style={{ fontSize: 12.5, color: 'var(--text-body-dim)' }}>Registering @{name} on the Tari network…</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', lineHeight: 1.5, maxWidth: 280, textWrap: 'pretty' }}>
            This can take a moment. Keep Caravel open until it finishes.
          </div>
        </div>
      )

    case 'accepted':
      // REACHED ONLY BY A TRUE ON-CHAIN ACCEPT. Every other ending is below this line.
      return (
        <>
          <Outcome tone="positive" title={`@${name} is yours`} emblem={<CheckMark />}>
            People can now find you by name.
          </Outcome>
          {state.txId && <TxRow txId={state.txId} />}
          <div style={ACTIONS}>
            <button onClick={a.onTryAnother} style={QUIET}>Register another</button>
            <button onClick={a.onDone} className="cv-btn-primary" style={PRIMARY}>Done</button>
          </div>
        </>
      )

    case 'fee-burned':
      // THE FULL DISCLOSURE. Money left, nothing was written, and here is the transaction. NO CAUSE
      // IS CLAIMED — we checked whether the name had gone and it had not, so anything further would
      // be a guess dressed as an explanation.
      return (
        <>
          <Outcome tone="danger" title={`@${name} was not registered`} emblem={<Cross />}>
            The registration was rejected, but the network fee you approved was still spent.{' '}
            {XTR(state.spent)} left your wallet and no name was registered.
          </Outcome>
          {state.txId && <TxRow txId={state.txId} />}
          <div style={ACTIONS}>
            <button onClick={a.onDone} style={QUIET}>Close</button>
            <button onClick={() => { void a.estimate() }} className="cv-btn-primary" style={PRIMARY}>Try again</button>
          </div>
        </>
      )

    case 'taken':
      // THE CAUSE WE ACTUALLY ESTABLISHED. The name reads as registered now and it did not when the
      // user checked, so somebody's transaction landed first. Said because it was verified.
      return (
        <>
          <Outcome tone="danger" title={`@${name} is no longer available`} emblem={<Cross />}>
            @{name} was registered by someone else before your transaction landed. The network fee
            you approved was still spent — {XTR(state.spent)} left your wallet.
          </Outcome>
          {state.txId && <TxRow txId={state.txId} />}
          <div style={ACTIONS}>
            <button onClick={a.onDone} style={QUIET}>Close</button>
            <button onClick={a.onTryAnother} className="cv-btn-primary" style={PRIMARY}>Try another name</button>
          </div>
        </>
      )

    case 'timed-out':
      // PENDING. NOT FAILED. WARN, NEVER RED. We stopped waiting; the network did not stop working,
      // and this may be registered already. So the primary action is to go and LOOK — a confident
      // "try again" here is how somebody pays a second fee for a name they already own.
      return (
        <>
          <Outcome tone="warn" title={`@${name} didn’t confirm in time`} emblem={<Clock />}>
            It may still have gone through. Check your Activity before trying again.
          </Outcome>
          {state.txId && <TxRow txId={state.txId} />}
          <div style={ACTIONS}>
            <button onClick={a.onDone} style={QUIET}>Close</button>
            <button onClick={a.onOpenWallet} className="cv-btn-primary" style={PRIMARY}>Check Activity</button>
          </div>
        </>
      )

    default: {
      const unhandled: never = state
      return unhandled
    }
  }
}
