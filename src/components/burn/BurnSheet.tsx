// The Burn TARI sheet: amount → review → burning → done. The Send sheet's pieces and its rules.
//
// SAME DISCIPLINE AS A SEND, step for step: the fee is priced by dry run before review and is the
// fee charged; Confirm re-checks the quote (crypto/quote) and re-prices rather than sending a stale
// one; the journal row is written before anything is submitted; the settle loop watches the balance
// that paid. A burn simply has no recipient — its destination is the burn wallet, always.

import { useRef, useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { MIN_BURN_MICROTARI, preparePrivateBurn, preparePublicBurn, type BurnSource, type PreparedBurn } from '../../crypto/burn'
import { maxStealthSend } from '../../crypto/confidentialSend'
import { explorerTxUrl } from '../../crypto/explorer'
import { beginEntry, settleEntry } from '../../crypto/journalStore'
import { maxPublicSend } from '../../crypto/publicSend'
import Callout from '../primitives/Callout'
import { TICKER, fmt6, toInput } from '../wallet/v2/format'
import { GenerationGuard } from '../wallet/v2/generation'
import { Clock, Eye, Flame, Lock, Spinner } from '../wallet/v2/icons'
import {
  ActionButton, AmountBlock, CARD, Emblem, OUTCOME_CARD, Outcome, Receipt, SheetHeader, SourceToggle, VerbatimBox,
} from '../wallet/v2/panels'
import { plainError } from '../wallet/v2/plainError'
import { Sheet } from '../wallet/v2/primitives'
import { C, MONO } from '../wallet/v2/tokens'
import { createBurnConfirm, type BurnProgress } from './burnConfirm'
import { parseTariInput } from './burnModel'

type Step =
  | { step: 'form'; error?: string }
  | { step: 'review'; amount: bigint; prepared: PreparedBurn | null; notice?: string }
  | BurnProgress

const WARNING = 'This can’t be undone. Burned TARI is locked forever.'

export default function BurnSheet({ onClose, onBurned }: {
  onClose: () => void
  /** A burn committed (or was broadcast and may still land): `amount` is on its way into the burn wallet. */
  onBurned: (amount: bigint) => void
}) {
  const { wallet, address, scan, revealed, rescan, beginSettle, acknowledgeSettle } = useWallet()

  // What each side can burn: the same ceilings the Send sheet offers.
  const privateAvail = scan.status === 'done' ? maxStealthSend(scan.utxos.map(u => u.amount)) : null
  const publicAvail = revealed.status === 'done' && revealed.amount !== null ? maxPublicSend(revealed.amount) : null
  const privateOk = (privateAvail ?? 0n) >= MIN_BURN_MICROTARI
  const publicOk = (publicAvail ?? 0n) >= MIN_BURN_MICROTARI
  const canChoose = privateOk && publicOk

  const [source, setSource] = useState<BurnSource>(privateOk || !publicOk ? 'private' : 'public')
  const [amount, setAmount] = useState('')
  const [view, setView] = useState<Step>({ step: 'form' })
  const gen = useRef(new GenerationGuard())
  const settledTx = useRef<string | null>(null)
  /** "Burn forever" is locked from the first click — see burnConfirm. Drawn disabled while set. */
  const [locked, setLocked] = useState(false)

  // The guarded confirm sequence, created ONCE so its lock survives re-renders. It reads the latest
  // wallet state through this ref rather than the render it was created in.
  const latest = useRef({ address, scan, revealed, rescan, beginSettle, onBurned })
  latest.current = { address, scan, revealed, rescan, beginSettle, onBurned }
  const gate = useRef<ReturnType<typeof createBurnConfirm> | null>(null)
  if (gate.current === null) {
    gate.current = createBurnConfirm({
      get address() { return latest.current.address ?? '' },
      beginEntry,
      settleEntry,
      beginSettle: e => latest.current.beginSettle(e),
      rescan: () => latest.current.rescan(),
      balancesBefore: () => ({
        private: latest.current.scan.balance,
        public: latest.current.revealed.status === 'done' ? latest.current.revealed.amount : null,
      }),
      show: v => setView(v),
      // Through the ref: `review` reads this render's amount and source, not the first render's.
      reprice: notice => { setLocked(false); void reviewRef.current(notice) },
      onBurned: (amount, txId) => { settledTx.current = txId; latest.current.onBurned(amount) },
    })
  }

  const available = source === 'private' ? privateAvail : publicAvail

  function close() {
    gen.current.cancel()
    if (view.step === 'review') view.prepared?.release()
    if (settledTx.current) acknowledgeSettle(settledTx.current)
    onClose()
  }

  function pickSource(s: BurnSource) {
    setSource(s)
    setView({ step: 'form' })
  }

  async function review(notice?: string) {
    const micro = parseTariInput(amount)
    if (micro === null) { setView({ step: 'form', error: 'Enter an amount to burn.' }); return }
    if (micro < MIN_BURN_MICROTARI) { setView({ step: 'form', error: `The smallest burn is ${fmt6(MIN_BURN_MICROTARI)} ${TICKER}.` }); return }
    if (available === null || micro > available) {
      setView({ step: 'form', error: `More than your ${source} balance can burn, with the fee.` })
      return
    }
    if (!wallet || !address) { setView({ step: 'form', error: 'Your wallet is locked — unlock it to burn.' }); return }

    const token = gen.current.begin()
    setView({ step: 'review', amount: micro, prepared: null, notice })
    try {
      const prepared = source === 'public'
        ? await preparePublicBurn(wallet, address, { amountMicrotari: micro })
        : await preparePrivateBurn(wallet, address, { amountMicrotari: micro })
      if (gen.current.isStale(token)) { prepared.release(); return }
      setView({ step: 'review', amount: micro, prepared, notice })
    } catch (e) {
      if (gen.current.isStale(token)) return
      setView({ step: 'form', error: plainError(e instanceof Error ? e.message : String(e)) })
    }
  }

  const reviewRef = useRef(review)
  reviewRef.current = review

  function confirm() {
    if (view.step !== 'review' || !view.prepared || !address) return
    setLocked(true)
    void gate.current!.confirm(view.prepared)
  }

  function tryAgain() {
    gate.current!.reset()
    setLocked(false)
    setView({ step: 'form' })
  }

  const dismissable = view.step !== 'burning'

  return (
    <Sheet title="Burn TARI" onClose={close} dismissable={dismissable} bare>
      {view.step === 'form' && (
        <div style={CARD}>
          <SheetHeader title="Burn TARI" onClose={close} />
          {canChoose && <SourceToggle source={source} onSource={pickSource} />}
          <AmountBlock
            value={amount}
            onChange={v => { setAmount(v); if (view.error) setView({ step: 'form' }) }}
            availableLabel={canChoose ? 'Available' : source === 'private' ? 'Private available' : 'Public available'}
            availableValue={available !== null ? `${fmt6(available)} ${TICKER}` : '—'}
            onMax={() => { if (available !== null && available > 0n) setAmount(toInput(available)) }}
            error={view.error}
            mt={canChoose ? 24 : 28}
          />
          <SourceNote source={source} />
          <Warning />
          <ActionButton
            tone={(privateOk || publicOk) && amount ? 'primary' : 'disabled'}
            onClick={() => { void review() }}
          >Review burn</ActionButton>
        </div>
      )}

      {view.step === 'review' && (
        <div style={CARD}>
          <SheetHeader title="Confirm burn" onClose={close} />
          <div style={{ textAlign: 'center', marginTop: 28 }}>
            <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em', fontFeatureSettings: "'tnum'", color: C.primary }}>
              {fmt6(view.amount)} <span style={{ fontSize: 16, fontWeight: 600, color: C.mutedDim }}>{TICKER}</span>
            </div>
            <div style={{ fontSize: 13.5, color: C.bodyDim, marginTop: 8 }}>to the Caravel Burn Wallet</div>
          </div>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 11, fontSize: 13.5,
            marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)',
          }}>
            <Row label="From">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500, color: C.primary }}>
                {source === 'private' ? <Lock size={11} color="var(--accent-ink)" /> : <Eye size={11} color={C.mutedDim} />}
                {source === 'private' ? 'Private funds' : 'Public funds'}
              </span>
            </Row>
            <Row label="Fee">
              <span style={{ fontFamily: MONO, fontWeight: 500, color: C.primary }}>
                {view.prepared === null
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit', color: C.faint }}><Spinner size={12} />Pricing…</span>
                  : `${fmt6(view.prepared.feeMicrotari)} ${TICKER}`}
              </span>
            </Row>
            {view.prepared !== null && (
              <Row label="Total from your balance">
                <span style={{ fontFamily: MONO, fontWeight: 600, color: C.primary }}>{fmt6(view.amount + view.prepared.feeMicrotari)} {TICKER}</span>
              </Row>
            )}
          </div>
          {view.notice && (
            <div role="status" style={{ fontSize: 12.5, color: 'var(--warn)', marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>{view.notice}</div>
          )}
          <Warning />
          <ActionButton tone={view.prepared === null || locked ? 'disabled' : 'primary'} onClick={locked ? undefined : confirm} mt={20}>
            {locked
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Spinner size={12} color="currentColor" />Burning…</span>
              : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Flame size={13} color="currentColor" width={2} />Burn forever</span>}
          </ActionButton>
          <ActionButton tone="quiet" mt={8} onClick={() => {
            gen.current.cancel()
            view.prepared?.release()
            setView({ step: 'form' })
          }}>Back</ActionButton>
        </div>
      )}

      {view.step === 'burning' && (
        <div style={OUTCOME_CARD}>
          <Spinner size={28} ring={3} />
          <div style={{ fontSize: 17, fontWeight: 600, color: C.primary, marginTop: 18 }}>
            Burning <span style={{ fontFamily: MONO }}>{fmt6(view.amount)}</span> {TICKER}
          </div>
          <div style={{ fontSize: 13, color: C.mutedDim, marginTop: 6 }}>Settling on the Ootle. This can take a moment.</div>
          <div style={{ fontSize: 12, color: C.faint, marginTop: 14, lineHeight: 1.5 }}>{view.progress}</div>
        </div>
      )}

      {view.step === 'success' && (
        <Outcome
          emblem={<Emblem tone="accent"><Flame size={18} color="currentColor" width={2} /></Emblem>}
          title={`${fmt6(view.amount)} ${TICKER} burned forever`}
          sub="The burn wallet total updates once it’s verified on chain."
        >
          <Receipt fee={view.fee} txId={view.txId} viewUrl={explorerTxUrl(view.txId)}
            onCopy={() => { navigator.clipboard.writeText(view.txId).catch(() => {}) }} />
          <ActionButton tone="quiet" onClick={close} mt={24}>Done</ActionButton>
        </Outcome>
      )}

      {view.step === 'unconfirmed' && (
        <Outcome
          emblem={<Emblem tone="accent"><Clock size={17} color="currentColor" /></Emblem>}
          title="Burn sent, not yet confirmed"
          sub="It may still land. The burn wallet total will show it once it’s verified on chain."
        >
          <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 11, color: C.faint }}>
            tx {view.txId.slice(0, 6)}…{view.txId.slice(-6)} · <a href={explorerTxUrl(view.txId)} target="_blank" rel="noreferrer"
              style={{ fontFamily: 'inherit', fontWeight: 600, color: 'var(--accent-ink)', textDecoration: 'none' }}>View ↗</a>
          </div>
          <ActionButton tone="quiet" onClick={close} mt={24}>Done</ActionButton>
        </Outcome>
      )}

      {view.step === 'error' && (
        <Outcome
          emblem={<Emblem tone="danger">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </Emblem>}
          title="Burn failed"
          sub="The network’s own words are below."
        >
          <div style={{ marginTop: 18, textAlign: 'left' }}><VerbatimBox>{view.message}</VerbatimBox></div>
          <ActionButton tone="primary" onClick={tryAgain} mt={16}>Try again</ActionButton>
          <span role="button" tabIndex={0} onClick={close} onKeyDown={e => e.key === 'Enter' && close()}
            style={{ display: 'block', marginTop: 12, fontSize: 12.5, fontWeight: 500, color: C.mutedDim, cursor: 'pointer', userSelect: 'none' }}
          >Close</span>
        </Outcome>
      )}
    </Sheet>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: C.mutedDim }}>{label}</span>
      {children}
    </div>
  )
}

function Warning() {
  return <Callout tone="warn" style={{ marginTop: 20 }}>{WARNING}</Callout>
}

/** What is visible about a burn, per source — the Send sheet's PrivacyNote, worded for a burn. */
function SourceNote({ source }: { source: BurnSource }) {
  const isPrivate = source === 'private'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20, justifyContent: 'center', textAlign: 'center' }}>
      {isPrivate ? <Lock size={12} color={C.mutedDim} /> : <Eye size={12} color={C.mutedDim} />}
      <span style={{ fontSize: 12.5, color: C.mutedDim, lineHeight: 1.5 }}>
        {isPrivate ? 'Private. Nothing ties this burn to your account.' : 'Public. Burned from your account, visibly.'}
      </span>
    </div>
  )
}
