// The Trade sheet: PLACE an order, FILL one from the book, or CANCEL one of your own.
//
//   form → review (a LIVE quote) → sending (locked) → done | sent-not-confirmed | taken | failed
//
// The Send and Burn sheets' discipline, step for step (components/burn/BurnSheet): the network fee is
// priced by dry run before review and is the fee charged; Confirm locks on the first click, re-checks
// the quote (crypto/quote, inside tradeActions.runTrade) and re-prices rather than sending a stale one;
// the journal row is written before anything is submitted. Every figure on screen is the T3 logic's —
// the review reads prepared.details, never a number worked out here.
//
// "TAKEN" IS ITS OWN STATE, not an error: an order filled or cancelled by somebody else between the
// book and Confirm is refused before anything is charged (the fill pins the order's version), so the
// sheet says so plainly and the book refreshes.

import { useEffect, useRef, useState } from 'react'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'
import { useWallet } from '../../context/WalletContext'
import { loadAccountAddress } from '../../crypto/accountStore'
import { explorerTxUrl } from '../../crypto/explorer'
import type { BookEntry, Price } from '../../crypto/market'
import { QuoteChanged } from '../../crypto/quote'
import { prepareCancel, prepareFill, tradeFeeSplit, type PreparedTrade, type Trader } from '../../crypto/trade'
import { preparePlaceOrder, runTrade, traderFor, type TradeRun } from '../../crypto/tradeActions'
import { SELL, type OrderSide, type TradeMode } from '../../crypto/tradeConfig'
import type { BoardInfo } from '../../crypto/tradeRead'
import { GenerationGuard } from '../wallet/v2/generation'
import { Clock, Eye, Lock, Spinner } from '../wallet/v2/icons'
import { ActionButton, CARD, Emblem, OUTCOME_CARD, Outcome, Receipt, SheetHeader } from '../wallet/v2/panels'
import { useTradeBalances, type Amount } from '../../hooks/useTradeBalances'
import { Sheet } from '../wallet/v2/primitives'
import { TICKER } from '../wallet/v2/format'
import { C, MONO } from '../wallet/v2/tokens'
import {
  INSUFFICIENT_MESSAGE, fillRows, fmtCusdWithUnit, fmtPrice, fmtTari, isTaken, orderTotal, parsePrice, parseTari,
  placeRows, termsLine, tradeMessage, type Row,
} from './tradeModel'

/** What the sheet is for. A cancel carries everything Cancel needs (its seed-derived key index). */
export type SheetMode =
  | { kind: 'place'; side: OrderSide }
  | { kind: 'fill'; entry: BookEntry }
  | { kind: 'cancel'; order: { orderId: string; side: OrderSide; n: bigint; p: bigint; price: Price; cancelIndex: number; to: TradeMode } }

type View =
  | { step: 'form'; error?: string }
  | { step: 'review'; prepared: PreparedTrade | null; notice?: string }
  | { step: 'sending'; progress: string }
  | { step: 'success'; run: TradeRun; details: PreparedTrade['details'] }
  | { step: 'unconfirmed'; txId: string }
  | { step: 'taken' }
  | { step: 'error'; message: string }

const MIN_ORDER = 1_000_000n

export default function TradeSheet({ mode, board, onClose, onTraded }: {
  mode: SheetMode
  /** The Board's live settings (for a new order's fee preview), or null while unknown. */
  board: BoardInfo | null
  onClose: () => void
  /** Something reached the chain (or the book moved under us): refresh balances and the book. */
  onTraded: () => void
}) {
  const { wallet, address, purposeKeys } = useWallet()
  const [amount, setAmount] = useState('')
  const [price, setPrice] = useState('')
  // PRIVATE BY DEFAULT, both ways — "Public: visible on-chain."
  const [pay, setPay] = useState<TradeMode>('private')
  const [get, setGet] = useState<TradeMode>('private')
  const [view, setView] = useState<View>(mode.kind === 'cancel' ? { step: 'review', prepared: null } : { step: 'form' })
  /** Confirm is locked from the first click until the outcome is left. */
  const [locked, setLocked] = useState(false)
  const gen = useRef(new GenerationGuard())

  const trader = (): Trader | null => wallet && address && purposeKeys
    ? traderFor(wallet, address, purposeKeys, loadAccountAddress(address))
    : null

  // A new order's figures as typed (P = N × price), and its fee from the Board's live settings.
  const n = parseTari(amount)
  const px = parsePrice(price)
  const total = n !== null && px !== null ? orderTotal(n, px) : null
  const split = n !== null && board ? tradeFeeSplit(n, board.feeBps, board.caravelPct) : null

  // ── ENOUGH TO PAY? — checked BEFORE pricing, from balances already read ──
  // What this trade takes from the side it pays from, and at least a little of that side's tTARI for
  // the network fee. A figure not read yet is not judged (pricing would still refuse a real shortfall,
  // and that refusal reads the same).
  const balances = useTradeBalances()
  const known = (a: Amount) => (a.status === 'ready' ? a.value : null)
  const short = (() => {
    if (mode.kind === 'cancel') return false   // the network fee only; priced as the sheet opens
    let tari = 1n, cusd = 0n
    if (mode.kind === 'place') { if (mode.side === SELL) tari += n ?? 0n; else cusd = total?.p ?? 0n }
    else if (mode.entry.side === SELL) cusd = mode.entry.p
    else tari += mode.entry.n
    const t = known(pay === 'private' ? balances.tari.private : balances.tari.public)
    const c = known(pay === 'private' ? balances.cusd.private : balances.cusd.public)
    return (t !== null && t < tari) || (cusd > 0n && c !== null && c < cusd)
  })()

  async function review(notice?: string) {
    const t = trader()
    if (!t) { setView({ step: 'form', error: 'Your wallet is locked — unlock it to trade.' }); return }
    let run: () => Promise<PreparedTrade>
    if (mode.kind === 'place') {
      if (n === null) { setView({ step: 'form', error: `Enter an amount of ${TICKER}.` }); return }
      if (n < MIN_ORDER) { setView({ step: 'form', error: `The smallest order is 1 ${TICKER}.` }); return }
      if (px === null || total === null || total.p <= 0n) { setView({ step: 'form', error: `Enter a price per ${TICKER}.` }); return }
      run = () => preparePlaceOrder(t, { side: mode.side, n, p: total.p, escrow: pay, payout: get })
    } else if (mode.kind === 'fill') {
      const e = mode.entry
      run = () => prepareFill(t, { orderId: e.orderId, expectedN: e.n, expectedP: e.p, pay, receive: get })
    } else {
      const o = mode.order
      run = () => prepareCancel(t, { orderId: o.orderId, cancelIndex: o.cancelIndex, to: o.to })
    }
    if (short) { setView({ step: 'form', error: INSUFFICIENT_MESSAGE }); return }
    const token = gen.current.begin()
    setView({ step: 'review', prepared: null, notice })
    try {
      const prepared = await run()
      if (gen.current.isStale(token)) return
      setView({ step: 'review', prepared, notice })
    } catch (e) {
      if (gen.current.isStale(token)) return
      if (isTaken(e)) { onTraded(); setView({ step: 'taken' }); return }
      const message = tradeMessage(e)
      setView(mode.kind === 'cancel' ? { step: 'error', message } : { step: 'form', error: message })
    }
  }

  // A cancel has nothing to fill in: it is priced the moment it opens.
  const reviewRef = useRef(review)
  reviewRef.current = review
  useEffect(() => { if (mode.kind === 'cancel') void reviewRef.current() }, [mode.kind])

  async function confirm() {
    const t = trader()
    if (locked || view.step !== 'review' || !view.prepared || !t) return
    setLocked(true)   // the click lock: a second click does nothing
    const prepared = view.prepared
    try {
      const run = await runTrade(t, prepared, progress => setView({ step: 'sending', progress }))
      onTraded()
      if (run.outcome === 'Commit') setView({ step: 'success', run, details: prepared.details })
      else if (run.outcome === 'Timeout') setView({ step: 'unconfirmed', txId: run.txId })
      // A pinned order that moved is refused before it runs and pays nothing: somebody got there first.
      else if (!run.feeOnly && mode.kind === 'fill' && /no longer open|version|FailedToLock|is down/i.test(run.reason ?? '')) setView({ step: 'taken' })
      else setView({
        step: 'error',
        message: run.feeOnly
          ? 'The network fee was charged, but the trade didn’t go through. Nothing else moved.'
          : 'The network turned this trade down. Nothing was charged.',
      })
    } catch (e) {
      if (e instanceof QuoteChanged && (e.reason === 'fee-risen' || e.reason === 'stale')) {
        setLocked(false)
        void review(e.message)   // re-priced, and asked again — never sent at the old price
        return
      }
      if (isTaken(e)) { onTraded(); setView({ step: 'taken' }); return }
      setView({ step: 'error', message: tradeMessage(e) })
    }
  }

  function close() {
    gen.current.cancel()
    onClose()
  }

  const title = mode.kind === 'place' ? (mode.side === SELL ? 'Place sell order' : 'Place buy order')
    : mode.kind === 'fill' ? (mode.entry.side === SELL ? 'Buy from this order' : 'Sell into this order')
    : 'Cancel order'
  const sending = view.step === 'sending'

  return (
    <Sheet title={title} onClose={close} dismissable={!sending} bare>
      {view.step === 'form' && mode.kind === 'place' && (
        <div style={CARD}>
          <SheetHeader title={title} onClose={close} />
          <Field label="Amount" hint={`min 1 ${TICKER}`} unit={TICKER} value={amount} big autoFocus
            onChange={v => { setAmount(v); if (view.error) setView({ step: 'form' }) }} />
          <Field label={`Price per ${TICKER}`} unit="cUSD" value={price}
            onChange={v => { setPrice(v); if (view.error) setView({ step: 'form' }) }} />
          <ModePair left={{ label: 'Pay from', value: pay, onChange: setPay }} right={{ label: 'Get paid', value: get, onChange: setGet }} />
          <Summary rows={[
            ...(total ? placeRows(mode.side, n!, total.p, split) : placeRows(mode.side, 0n, 0n, null).map(r => (r.note ? r : { ...r, v: '—' }))),
            { k: 'Network fee', v: 'priced at review' },
          ]} />
          {total && !total.exact && (
            <div style={{ fontSize: 11.5, color: C.mutedDim, marginTop: 8 }}>
              The total is rounded down to cUSD’s six decimals: the order is {fmtCusdWithUnit(total.p)}.
            </div>
          )}
          {(view.error || short) && <ErrorLine>{view.error ?? INSUFFICIENT_MESSAGE}</ErrorLine>}
          <ActionButton tone={n !== null && total && !short ? 'primary' : 'disabled'} onClick={() => { void review() }} mt={18}>Review order</ActionButton>
        </div>
      )}

      {view.step === 'form' && mode.kind === 'fill' && (
        <div style={CARD}>
          <SheetHeader title={title} onClose={close} />
          <Summary rows={[...fillRows(mode.entry), { k: 'Network fee', v: 'priced at review' }]} mt={24} />
          <ModePair left={{ label: 'Pay with', value: pay, onChange: setPay }} right={{ label: 'Receive as', value: get, onChange: setGet }} />
          {(view.error || short) && <ErrorLine>{view.error ?? INSUFFICIENT_MESSAGE}</ErrorLine>}
          <ActionButton tone={short ? 'disabled' : 'primary'} onClick={() => { void review() }} mt={18}>Review</ActionButton>
        </div>
      )}

      {view.step === 'review' && (
        <div style={CARD}>
          <SheetHeader title={reviewTitle(mode)} onClose={close} />
          <Summary rows={reviewRows(mode, view.prepared, pay, get)} mt={22} />
          {view.prepared && mode.kind === 'place' && (
            <div style={{ fontSize: 12, color: C.mutedDim, lineHeight: 1.55, marginTop: 12 }}>
              {mode.side === SELL
                ? `Your ${TICKER} is held until the order fills or you cancel.`
                : 'Your cUSD is held until the order fills or you cancel.'}
            </div>
          )}
          {mode.kind === 'cancel' && (
            <div style={{ fontSize: 12.5, color: C.bodyDim, lineHeight: 1.5, marginTop: 12 }}>Everything comes back, no trade fee.</div>
          )}
          {view.notice && (
            <div role="status" style={{ fontSize: 12.5, color: 'var(--warn)', marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>{view.notice}</div>
          )}
          <ActionButton tone={view.prepared === null || locked ? 'disabled' : 'primary'} onClick={locked ? undefined : () => { void confirm() }} mt={20}>
            {locked
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Spinner size={12} color="currentColor" />Sending…</span>
              : mode.kind === 'place' ? 'Place order' : mode.kind === 'fill' ? 'Confirm' : 'Cancel order'}
          </ActionButton>
          <ActionButton tone="quiet" mt={8} onClick={() => {
            gen.current.cancel()
            if (mode.kind === 'cancel') close(); else setView({ step: 'form' })
          }}>{mode.kind === 'cancel' ? 'Keep order' : 'Back'}</ActionButton>
        </div>
      )}

      {view.step === 'sending' && (
        <div style={OUTCOME_CARD}>
          <Spinner size={28} ring={3} />
          <div style={{ fontSize: 17, fontWeight: 600, color: C.primary, marginTop: 18 }}>
            {mode.kind === 'place' ? 'Placing order' : mode.kind === 'fill' ? 'Completing trade' : 'Cancelling order'}
          </div>
          <div style={{ fontSize: 13, color: C.mutedDim, marginTop: 6 }}>Settling on the Ootle. This can take a moment.</div>
          <div style={{ fontSize: 12, color: C.faint, marginTop: 14, lineHeight: 1.5 }}>{view.progress}</div>
        </div>
      )}

      {view.step === 'success' && (
        <Outcome
          emblem={<Emblem tone={mode.kind === 'cancel' ? 'accent' : 'positive'}><CheckGlyph /></Emblem>}
          title={mode.kind === 'place' ? 'Order placed' : mode.kind === 'fill' ? 'Trade complete' : 'Order cancelled'}
          sub={successLine(view.details)}
        >
          <Receipt fee={view.run.feeMicrotari} txId={view.run.txId} viewUrl={explorerTxUrl(view.run.txId)}
            onCopy={() => { navigator.clipboard.writeText(view.run.txId).catch(() => {}) }} />
          <ActionButton tone="primary" onClick={close} mt={24}>Done</ActionButton>
        </Outcome>
      )}

      {view.step === 'unconfirmed' && (
        <Outcome
          emblem={<Emblem tone="accent"><Clock size={17} color="currentColor" /></Emblem>}
          title="Sent, not yet confirmed"
          sub="It may still land. Your balances and the book will show it once it’s confirmed."
        >
          <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 11, color: C.faint }}>
            tx {view.txId.slice(0, 6)}…{view.txId.slice(-6)} · <a href={explorerTxUrl(view.txId)} target="_blank" rel="noreferrer"
              style={{ fontFamily: 'inherit', fontWeight: 600, color: 'var(--accent-ink)', textDecoration: 'none' }}>View ↗</a>
          </div>
          <ActionButton tone="quiet" onClick={close} mt={24}>Done</ActionButton>
        </Outcome>
      )}

      {view.step === 'taken' && (
        <Outcome
          emblem={<Emblem tone="accent"><Clock size={17} color="currentColor" /></Emblem>}
          title="Someone just took this order"
          sub="Nothing was charged. The book has been refreshed."
        >
          <ActionButton tone="quiet" onClick={close} mt={24}>Back to book</ActionButton>
        </Outcome>
      )}

      {view.step === 'error' && (
        <Outcome
          emblem={<Emblem tone="danger">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </Emblem>}
          title={mode.kind === 'cancel' ? 'Cancel failed' : 'Trade failed'}
          sub={view.message}
        >
          <ActionButton tone="primary" onClick={() => { setLocked(false); if (mode.kind === 'cancel') void review(); else setView({ step: 'form' }) }} mt={16}>Try again</ActionButton>
          <span role="button" tabIndex={0} onClick={close} onKeyDown={e => e.key === 'Enter' && close()}
            style={{ display: 'block', marginTop: 12, fontSize: 12.5, fontWeight: 500, color: C.mutedDim, cursor: 'pointer', userSelect: 'none' }}
          >Close</span>
        </Outcome>
      )}
    </Sheet>
  )
}

// ── What the review says — from prepared.details only ─────────────────────────

function reviewTitle(mode: SheetMode): string {
  if (mode.kind === 'place') return mode.side === SELL ? 'Review sell order' : 'Review buy order'
  if (mode.kind === 'fill') return mode.entry.side === SELL ? 'Review purchase' : 'Review sale'
  return 'Cancel order'
}

const modeWord = (m: TradeMode) => (m === 'private' ? 'Private' : 'Public')

function reviewRows(mode: SheetMode, prepared: PreparedTrade | null, pay: TradeMode, get: TradeMode): Row[] {
  const fee: Row = { k: 'Network fee', v: prepared ? fmtTari(prepared.fee) : 'pricing…' }
  if (mode.kind === 'cancel') {
    const o = mode.order
    return [
      { k: 'Order', v: `${o.side === SELL ? 'Sell' : 'Buy'} ${fmtTari(o.n)} @ ${fmtPrice(o.price)}`, strong: true },
      { k: 'Returns to you', v: o.side === SELL ? fmtTari(o.n) : fmtCusdWithUnit(o.p), strong: true },
      fee,
    ]
  }
  if (!prepared) return [fee]
  const d = prepared.details
  if (mode.kind === 'place') {
    return [
      { k: mode.side === SELL ? 'Sell' : 'Buy', v: termsLine(d.n, d.p), strong: true },
      ...placeRows(mode.side, d.n, d.p, { fee: d.tradeFee }),
      fee,
      { k: 'Pay from · Get paid', v: `${modeWord(pay)} · ${modeWord(get)}` },
    ]
  }
  return [
    ...fillRows({ side: d.side, n: d.n, p: d.p, fee: d.tradeFee }),
    fee,
    { k: 'Pay with · Receive as', v: `${modeWord(pay)} · ${modeWord(get)}` },
  ]
}

/** The design's one-line outcome, from the confirmed trade's own terms. */
function successLine(d: PreparedTrade['details']): string {
  const where = (m: TradeMode) => (m === 'private' ? 'private' : 'public')
  if (d.action === 'place') {
    return `${d.side === SELL ? 'Sell' : 'Buy'} ${fmtTari(d.n)} @ ${fmtPrice({ micro: (d.p * 1_000_000n) / d.n, exact: (d.p * 1_000_000n) % d.n === 0n })} is live in the book.`
  }
  if (d.action === 'fill') {
    const got = d.gets!
    const received = got.resource === TARI_RESOURCE_ADDRESS ? fmtTari(got.amount) : fmtCusdWithUnit(got.amount)
    return `${received} received, ${where(got.mode)}. ${fmtTari(d.burnCut)} burned.`
  }
  const back = d.gets!
  return `${back.resource === TARI_RESOURCE_ADDRESS ? fmtTari(back.amount) : fmtCusdWithUnit(back.amount)} is back in your ${where(back.mode)} balance. No trade fee.`
}

// ── Small parts ───────────────────────────────────────────────────────────────

function Summary({ rows, mt = 16 }: { rows: Row[]; mt?: number }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 9, marginTop: mt, padding: '13px 15px',
      border: '1px solid var(--border)', borderRadius: 11, background: 'var(--surface-void)', fontSize: 12.5,
    }}>
      {rows.map(r => r.note ? (
        <div key={r.v} style={{ fontSize: 11.5, color: C.mutedDim, marginTop: -3 }}>{r.v}</div>
      ) : (
        <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: C.mutedDim, flexShrink: 0 }}>{r.k}</span>
          <span style={{
            fontFamily: MONO, textAlign: 'right', fontWeight: r.strong ? 600 : 500,
            color: r.positive ? 'var(--positive)' : C.primary, overflowWrap: 'anywhere',
          }}>{r.v}</span>
        </div>
      ))}
    </div>
  )
}

function Field({ label, hint, unit, value, onChange, big = false, autoFocus = false }: {
  label: string; hint?: string; unit: string; value: string; onChange: (v: string) => void; big?: boolean; autoFocus?: boolean
}) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.mutedDim, marginBottom: 7 }}>
        <span>{label}</span>{hint && <span style={{ fontFamily: MONO }}>{hint}</span>}
      </div>
      <label className="cv-trade-field" style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12,
        border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'text',
      }}>
        <input value={value} onChange={e => onChange(e.target.value)} inputMode="decimal" placeholder="0" autoFocus={autoFocus}
          aria-label={label}
          style={{
            flex: 1, minWidth: 0, width: '100%', border: 'none', outline: 'none', background: 'transparent',
            color: C.primary, fontFamily: MONO, fontSize: big ? 22 : 18, fontWeight: 500,
          }} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: C.mutedDim }}>{unit}</span>
      </label>
    </div>
  )
}

function ModeToggle({ label, value, onChange }: { label: string; value: TradeMode; onChange: (m: TradeMode) => void }) {
  const opt = (m: TradeMode) => {
    const on = m === value
    return (
      <span role="radio" tabIndex={0} aria-checked={on}
        onClick={() => onChange(m)} onKeyDown={e => e.key === 'Enter' && onChange(m)}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '7px 4px', borderRadius: 8, cursor: 'pointer', userSelect: 'none',
          fontSize: 12.5, fontWeight: 600, background: on ? 'var(--accent-400)' : 'transparent',
          color: on ? '#FFFFFF' : C.bodyDim,
        }}>
        {m === 'private' ? <Lock size={11} color="currentColor" /> : <Eye size={11} color="currentColor" />}{modeWord(m)}
      </span>
    )
  }
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: C.mutedDim, marginBottom: 7 }}>{label}</div>
      <div role="radiogroup" aria-label={label} style={{
        display: 'flex', padding: 3, gap: 3, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-void)',
      }}>{opt('private')}{opt('public')}</div>
    </div>
  )
}

function ModePair({ left, right }: {
  left: { label: string; value: TradeMode; onChange: (m: TradeMode) => void }
  right: { label: string; value: TradeMode; onChange: (m: TradeMode) => void }
}) {
  return (
    <>
      <div className="cv-trade-grid2" style={{ marginTop: 16 }}>
        <ModeToggle {...left} /><ModeToggle {...right} />
      </div>
      <div style={{ fontSize: 11.5, color: C.mutedDim, marginTop: 7 }}>Public: visible on-chain.</div>
    </>
  )
}

function ErrorLine({ children }: { children: string }) {
  return <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger-500)', marginTop: 12, lineHeight: 1.5 }}>{children}</div>
}

function CheckGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
}

