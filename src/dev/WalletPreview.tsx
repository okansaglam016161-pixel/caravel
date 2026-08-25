// STAGE 1 PREVIEW HARNESS — dev only, never shipped.
//
// WHAT THIS IS FOR. The M4 redesign has to be looked at before it touches the real modal, and
// "looked at" means clicked through, not screenshotted: the states that matter most (settling,
// unavailable, disabled-with-reason, the in-flight lock) are exactly the ones that never show up
// when you open a healthy wallet.
//
// SO IT IS ALL MOCK. No wallet, no network, no builders. Nothing under src/crypto is imported,
// and none of the fund logic is touched. Every number below is a literal, chosen to match the
// figures the real seeded wallet actually produces so the widths and roundings are honest.
//
// Two modes:
//   DRIVE    — one modal, with controls to put it in any state by hand.
//   GALLERY  — every state at once, laid out like the design canvas, for comparing at a glance.

import { useState } from 'react'
import WalletModalV2, { type MoveView, type WalletModalV2Props } from '../components/wallet/v2/WalletModalV2'
import type { BalanceView } from '../components/wallet/v2/balances'
import type { Dir, EntryProps } from '../components/wallet/v2/move'
import { C, MONO, border, tealBorder, tealFill } from '../components/wallet/v2/tokens'
import { fmt6, toInput } from '../components/wallet/v2/format'

// ── Mock figures, taken from the real seeded wallet so nothing is unrealistically round ──
const PRIVATE = 4_942_095n            // 4.942095 — what the wallet holds after M3's reveal
const PUBLIC = 994_997_686n           // 994.997686 — the vault after the same reveal
const FEE = 14_537n                   // the fee that reveal actually paid on-chain
const RESERVE = 51_000n               // REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE
const TXID = '723d6720fb6225a3b7910c9076fb1026f591e910b098ab1fc8587f88a0623481'
const REAL_ERROR =
  'The network rejected this transaction in simulation: FailedToExecuteInstruction ' +
  '{ instruction: 4, error: "Bucket 1 not found in workspace — TakeFromBucket consumed it" }'

const ready = (v: bigint): BalanceView => ({ status: 'ready', microtari: v })
const LOADING: BalanceView = { status: 'loading' }
const UNAVAIL: BalanceView = { status: 'unavailable' }

// ── Scenarios: the balance/account situations the entry rules depend on ──
type Scenario = 'both' | 'publicZero' | 'privateZero' | 'belowFloor' | 'noAccount' | 'loading' | 'unavailable' | 'inFlight'

const SCENARIOS: { id: Scenario; label: string; note: string }[] = [
  { id: 'both', label: 'Both funded', note: 'Ordinary state — both directions offered' },
  { id: 'publicZero', label: 'Public zero', note: 'The good state. Make private disabled with a reason' },
  { id: 'privateZero', label: 'Private zero', note: 'Never funded — claim prompt, no moves' },
  { id: 'belowFloor', label: 'Private below floor', note: 'E3 — under 0.151, reveal says why instead of vanishing' },
  { id: 'noAccount', label: 'No account yet', note: 'E2 — the trap. Disabled with reason, not available-then-broken' },
  { id: 'loading', label: 'Loading', note: 'Skeletons, both balances' },
  { id: 'unavailable', label: 'Unavailable', note: 'Not a zero. Retry offered, moves locked' },
  { id: 'inFlight', label: 'Move in flight', note: 'Banner + updating balances + locked entries' },
]

function balancesFor(s: Scenario): { priv: BalanceView; pub: BalanceView } {
  switch (s) {
    case 'loading': return { priv: LOADING, pub: LOADING }
    case 'unavailable': return { priv: UNAVAIL, pub: UNAVAIL }
    case 'publicZero': return { priv: ready(13_097_503_210n), pub: ready(0n) }
    case 'privateZero': return { priv: ready(0n), pub: ready(0n) }
    case 'belowFloor': return { priv: ready(120_000n), pub: ready(PUBLIC) }
    default: return { priv: ready(PRIVATE), pub: ready(PUBLIC) }
  }
}

/**
 * The entry rules, mirrored from the shipped guards so the preview shows the REAL availability
 * logic rather than a guess — this is the shape Stage 2 will feed from live state.
 */
function entriesFor(s: Scenario, onOpen: (d: Dir) => void): { entries: EntryProps[]; locked?: string; lockedFlight?: boolean } {
  if (s === 'loading') return { entries: [], locked: 'Checking your balances…' }
  if (s === 'unavailable') return { entries: [], locked: 'Unavailable while balances are unknown' }
  if (s === 'inFlight') return { entries: [], locked: 'Locked while a move is in flight', lockedFlight: true }
  if (s === 'privateZero') return { entries: [], locked: 'Nothing to move yet' }

  const { priv, pub } = balancesFor(s)
  const privV = priv.status === 'ready' ? priv.microtari : 0n
  const pubV = pub.status === 'ready' ? pub.microtari : 0n

  return {
    entries: [
      {
        dir: 'conceal',
        disabledReason: pubV === 0n ? 'Nothing public to move' : undefined,
        onClick: () => onOpen('conceal'),
      },
      {
        dir: 'reveal',
        // E2 first — an unrecoverable account is a harder block than a small balance.
        disabledReason: s === 'noAccount'
          ? 'Still identifying this wallet’s account — try again in a moment'
          : privV < 100_000n + RESERVE
            ? 'Not enough private balance to cover an amount plus the fee'
            : undefined,
        onClick: () => onOpen('reveal'),
      },
    ],
  }
}

// ── Drive mode ────────────────────────────────────────────────────────────────

function Drive() {
  const [scenario, setScenario] = useState<Scenario>('both')
  const [hidden, setHidden] = useState(false)
  const [showFacts, setShowFacts] = useState(true)
  const [move, setMove] = useState<MoveView>({ step: 'idle' })

  const { priv, pub } = balancesFor(scenario)
  const privV = priv.status === 'ready' ? priv.microtari : 0n
  const pubV = pub.status === 'ready' ? pub.microtari : 0n

  const parse = (s: string): bigint => {
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return 0n
    const [w, f = ''] = s.split('.')
    return BigInt(w || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6))
  }

  function openMove(dir: Dir) {
    setMove({ step: 'form', dir, amount: '', maxUsed: false, available: dir === 'conceal' ? pubV : privV, canReview: false })
  }

  function refreshForm(dir: Dir, next: string, usedMax: boolean) {
    const available = dir === 'conceal' ? pubV : privV
    const ceiling = dir === 'conceal' ? available : (available > RESERVE ? available - RESERVE : 0n)
    const entered = parse(next)
    const belowMin = next !== '' && entered < 100_000n
    const over = next !== '' && entered > ceiling
    setMove({
      step: 'form', dir, amount: next, maxUsed: usedMax, available,
      canReview: next !== '' && !belowMin && !over,
      error: belowMin ? 'Minimum 0.10 TARI.'
        : over ? (dir === 'reveal'
            ? `More than you can make public — the fee comes out of your private balance too. Most you can move now: ${fmt6(ceiling)} TARI.`
            : 'More than your public balance.')
          : undefined,
      leftoverNote: dir === 'reveal' && usedMax
        ? `About ${fmt6(RESERVE)} TARI stays private to cover the fee. It’s still yours and still spendable.`
        : undefined,
    })
  }

  const amt = move.step === 'form' ? parse(move.amount) : 0n
  const dir: Dir = 'dir' in move ? move.dir : 'conceal'
  const resulting = (a: bigint, d: Dir) => d === 'conceal'
    ? { privateAfter: privV + a - FEE, publicAfter: pubV - a }
    : { privateAfter: privV - a - FEE, publicAfter: pubV + a }

  const { entries, locked, lockedFlight } = entriesFor(scenario, openMove)

  const props: WalletModalV2Props = {
    privateBalance: priv, publicBalance: pub, hidden, networkChip: 'Esmeralda testnet',
    move, entries, lockedText: locked, lockedIsFlight: lockedFlight,
    inFlightText: scenario === 'inFlight' ? 'Making 1.000000 TARI public' : undefined,
    onToggleHidden: () => setHidden(h => !h),
    onRefresh: () => {}, onClose: () => setMove({ step: 'idle' }),
    onBack: () => setMove({ step: 'idle' }),
    onAmountChange: v => refreshForm(dir, v, false),
    onMax: () => {
      const available = dir === 'conceal' ? pubV : privV
      const ceiling = dir === 'conceal' ? available : (available > RESERVE ? available - RESERVE : 0n)
      refreshForm(dir, toInput(ceiling), true)
    },
    onReview: () => {
      setMove({ step: 'review', dir, amountMicrotari: amt, feeMicrotari: null, resulting: null, showPermanenceNote: showFacts })
      setTimeout(() => setMove({ step: 'review', dir, amountMicrotari: amt, feeMicrotari: FEE, resulting: resulting(amt, dir), showPermanenceNote: showFacts }), 1400)
    },
    onConfirm: () => {
      if (move.step !== 'review') return
      const a = move.amountMicrotari, d = move.dir
      setMove({ step: 'moving', dir: d, amountMicrotari: a, progress: 'Submitting to the network — a few seconds.' })
      setTimeout(() => setMove({ step: 'settling', dir: d, amountMicrotari: a, txId: TXID }), 1800)
    },
    onDone: () => setMove({ step: 'idle' }),
    onRetryMove: () => openMove(dir),
    onCopyTx: t => navigator.clipboard?.writeText(t).catch(() => {}),
    onRetryBalance: () => setScenario('both'),
  }

  const jump = (label: string, v: MoveView) => (
    <button key={label} onClick={() => setMove(v)} style={btn(move.step === v.step && ('dir' in v && 'dir' in move ? v.dir === move.dir : true))}>{label}</button>
  )

  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <aside style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 22, flexShrink: 0 }}>
        <Group title="Scenario" note="Drives balances, entry availability and locks">
          {SCENARIOS.map(s => (
            <button key={s.id} onClick={() => { setScenario(s.id); setMove({ step: 'idle' }) }} style={btn(scenario === s.id)} title={s.note}>
              {s.label}
            </button>
          ))}
        </Group>
        <Group title="Toggles">
          <button onClick={() => setHidden(h => !h)} style={btn(hidden)}>Hide balances {hidden ? '· on' : '· off'}</button>
          <button onClick={() => setShowFacts(f => !f)} style={btn(showFacts)}>Permanence note {showFacts ? '· on' : '· off'}</button>
        </Group>
        <Group title="Jump to a move state" note="Bypasses the flow — for states that are hard to reach">
          {jump('Form · make private', { step: 'form', dir: 'conceal', amount: '100', maxUsed: false, available: pubV, canReview: true })}
          {jump('Form · make public', { step: 'form', dir: 'reveal', amount: '1', maxUsed: false, available: privV, canReview: true })}
          {jump('Form · MAX pressed', { step: 'form', dir: 'reveal', amount: toInput(privV - RESERVE), maxUsed: true, available: privV, canReview: true, leftoverNote: `About ${fmt6(RESERVE)} TARI stays private to cover the fee. It’s still yours and still spendable.` })}
          {jump('Form · below minimum', { step: 'form', dir: 'reveal', amount: '0.05', maxUsed: false, available: privV, canReview: false, error: 'Minimum 0.10 TARI.' })}
          {jump('Review · pricing', { step: 'review', dir: 'conceal', amountMicrotari: 100_000_000n, feeMicrotari: null, resulting: null })}
          {jump('Review · make private', { step: 'review', dir: 'conceal', amountMicrotari: 100_000_000n, feeMicrotari: FEE, resulting: resulting(100_000_000n, 'conceal') })}
          {jump('Review · make public', { step: 'review', dir: 'reveal', amountMicrotari: 1_000_000n, feeMicrotari: FEE, resulting: resulting(1_000_000n, 'reveal'), showPermanenceNote: showFacts })}
          {jump('Moving', { step: 'moving', dir: 'reveal', amountMicrotari: 1_000_000n, progress: 'Submitting to the network — a few seconds.' })}
          {jump('Settling', { step: 'settling', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID })}
          {jump('Success', { step: 'success', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID, lagged: false, resulting: resulting(1_000_000n, 'reveal') })}
          {jump('Success · index lagging', { step: 'success', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID, lagged: true, resulting: null })}
          {jump('Error · verbatim', { step: 'error', dir: 'reveal', message: REAL_ERROR, txId: TXID })}
          {jump('Idle', { step: 'idle' })}
        </Group>
      </aside>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Caption>{SCENARIOS.find(s => s.id === scenario)?.note}</Caption>
        <WalletModalV2 {...props} />
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.ghost }}>
          step: {move.step}{'dir' in move ? ` · ${move.dir}` : ''} · scenario: {scenario} · hidden: {String(hidden)}
        </div>
      </div>
    </div>
  )
}

// ── Gallery mode ──────────────────────────────────────────────────────────────

const noop = () => {}
function still(over: Partial<WalletModalV2Props>): WalletModalV2Props {
  return {
    privateBalance: ready(PRIVATE), publicBalance: ready(PUBLIC), hidden: false,
    networkChip: 'Esmeralda testnet', move: { step: 'idle' },
    entries: [{ dir: 'conceal' }, { dir: 'reveal' }],
    onToggleHidden: noop, onRefresh: noop, onClose: noop, onBack: noop,
    onAmountChange: noop, onMax: noop, onReview: noop, onConfirm: noop,
    onDone: noop, onRetryMove: noop, onCopyTx: noop, onRetryBalance: noop,
    ...over,
  }
}

function Gallery() {
  const r = (a: bigint, d: Dir) => d === 'conceal'
    ? { privateAfter: PRIVATE + a - FEE, publicAfter: PUBLIC - a }
    : { privateAfter: PRIVATE - a - FEE, publicAfter: PUBLIC + a }

  const cards: { label: string; props: WalletModalV2Props }[] = [
    { label: 'DEFAULT · BOTH BALANCES', props: still({}) },
    { label: 'PUBLIC ZERO · THE GOOD STATE', props: still({ publicBalance: ready(0n), privateBalance: ready(13_097_503_210n), entries: [{ dir: 'conceal', disabledReason: 'Nothing public to move' }, { dir: 'reveal' }] }) },
    { label: 'PRIVATE ZERO · NOTHING YET', props: still({ privateBalance: ready(0n), publicBalance: ready(0n), entries: [], lockedText: 'Nothing to move yet' }) },
    { label: 'E2 · NO ACCOUNT (disabled, with reason)', props: still({ entries: [{ dir: 'conceal' }, { dir: 'reveal', disabledReason: 'Still identifying this wallet’s account — try again in a moment' }] }) },
    { label: 'E3 · BELOW THE FLOOR', props: still({ privateBalance: ready(120_000n), entries: [{ dir: 'conceal' }, { dir: 'reveal', disabledReason: 'Not enough private balance to cover an amount plus the fee' }] }) },
    { label: 'LOADING', props: still({ privateBalance: LOADING, publicBalance: LOADING, entries: [], lockedText: 'Checking your balances…' }) },
    { label: 'UNAVAILABLE · NOT A ZERO', props: still({ privateBalance: UNAVAIL, publicBalance: UNAVAIL, entries: [], lockedText: 'Unavailable while balances are unknown' }) },
    { label: 'HIDDEN · ONE TOGGLE, EVERYTHING', props: still({ hidden: true }) },
    { label: 'IN FLIGHT · LOCKED', props: still({ inFlightText: 'Making 1.000000 TARI public', entries: [], lockedText: 'Locked while a move is in flight', lockedIsFlight: true }) },
    { label: 'FORM · MAKE PRIVATE', props: still({ move: { step: 'form', dir: 'conceal', amount: '100', maxUsed: false, available: PUBLIC, canReview: true } }) },
    { label: 'FORM · MAKE PUBLIC, MAX', props: still({ move: { step: 'form', dir: 'reveal', amount: toInput(PRIVATE - RESERVE), maxUsed: true, available: PRIVATE, canReview: true, leftoverNote: `About ${fmt6(RESERVE)} TARI stays private to cover the fee. It’s still yours and still spendable.` } }) },
    { label: 'FORM · BELOW MINIMUM', props: still({ move: { step: 'form', dir: 'reveal', amount: '0.05', maxUsed: false, available: PRIVATE, canReview: false, error: 'Minimum 0.10 TARI.' } }) },
    { label: 'REVIEW · PRICING', props: still({ move: { step: 'review', dir: 'conceal', amountMicrotari: 100_000_000n, feeMicrotari: null, resulting: null } }) },
    { label: 'REVIEW · MAKE PRIVATE', props: still({ move: { step: 'review', dir: 'conceal', amountMicrotari: 100_000_000n, feeMicrotari: FEE, resulting: r(100_000_000n, 'conceal') } }) },
    { label: 'REVIEW · MAKE PUBLIC', props: still({ move: { step: 'review', dir: 'reveal', amountMicrotari: 1_000_000n, feeMicrotari: FEE, resulting: r(1_000_000n, 'reveal'), showPermanenceNote: true } }) },
    { label: 'REVIEW · MAKE PUBLIC (no note — design as drawn)', props: still({ move: { step: 'review', dir: 'reveal', amountMicrotari: 1_000_000n, feeMicrotari: FEE, resulting: r(1_000_000n, 'reveal'), showPermanenceNote: false } }) },
    { label: 'MOVING', props: still({ move: { step: 'moving', dir: 'conceal', amountMicrotari: 100_000_000n, progress: 'Submitting to the network — a few seconds.' } }) },
    { label: 'SETTLING · DONE, CATCHING UP', props: still({ move: { step: 'settling', dir: 'conceal', amountMicrotari: 100_000_000n, txId: TXID } }) },
    { label: 'SUCCESS · SETTLED', props: still({ move: { step: 'success', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID, lagged: false, resulting: r(1_000_000n, 'reveal') } }) },
    { label: 'SUCCESS · INDEX LAGGING (still a success)', props: still({ move: { step: 'success', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID, lagged: true, resulting: null } }) },
    { label: 'ERROR · VERBATIM NETWORK TEXT', props: still({ move: { step: 'error', dir: 'reveal', message: REAL_ERROR, txId: TXID } }) },
  ]

  return (
    <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {cards.map(c => (
        <div key={c.label} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.1em', color: C.faintDim }}>{c.label}</span>
          <WalletModalV2 {...c.props} />
        </div>
      ))}
    </div>
  )
}

// ── Chrome ────────────────────────────────────────────────────────────────────

function btn(active: boolean): React.CSSProperties {
  return {
    display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', borderRadius: 9,
    fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer', fontFamily: 'inherit',
    background: active ? tealFill(0.1) : C.raised,
    border: active ? tealBorder(0.35) : border(0.14),
    color: active ? C.teal300 : C.bodyDim,
  }
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: C.faintDim }}>{title.toUpperCase()}</span>
      {note && <span style={{ fontSize: 11.5, color: C.ghost, lineHeight: 1.45, marginBottom: 2 }}>{note}</span>}
      {children}
    </div>
  )
}

const Caption = ({ children }: { children: React.ReactNode }) => (
  <span style={{ fontSize: 12.5, color: C.faint }}>{children}</span>
)

export default function WalletPreview() {
  const [mode, setMode] = useState<'drive' | 'gallery'>('drive')
  return (
    <div style={{ minHeight: '100vh', background: C.void, padding: '32px 36px 120px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em', color: C.primary }}>Wallet modal v2 — preview</h1>
        <span style={{ fontSize: 13.5, color: C.faint }}>Mock data only. No wallet, no network, no fund logic.</span>
      </header>
      <div style={{ display: 'flex', gap: 8, margin: '18px 0 28px' }}>
        <button onClick={() => setMode('drive')} style={{ ...btn(mode === 'drive'), width: 'auto', padding: '8px 18px' }}>Drive</button>
        <button onClick={() => setMode('gallery')} style={{ ...btn(mode === 'gallery'), width: 'auto', padding: '8px 18px' }}>Gallery</button>
      </div>
      {mode === 'drive' ? <Drive /> : <Gallery />}
    </div>
  )
}
