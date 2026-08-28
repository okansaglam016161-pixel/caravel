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
import WalletModalV2, { WALLET_TABS, type MoveView, type WalletModalV2Props, type WalletTab } from '../components/wallet/v2/WalletModalV2'
import { ActivityRowShell, type ActivityRowView, type FaucetPhase, type OnsStatus, type SendView } from '../components/wallet/v2/panels'
import type { BalanceView } from '../components/wallet/v2/balances'
import { computeTotal } from '../components/wallet/v2/total'
import type { Dir, EntryProps } from '../components/wallet/v2/move'
import { C, MONO, PAGE_MAX_WIDTH, border, tealBorder, tealFill } from '../components/wallet/v2/tokens'
import { fmt6, toInput } from '../components/wallet/v2/format'

// ── Mock figures, taken from the real seeded wallet so nothing is unrealistically round ──
const PRIVATE = 4_942_095n            // 4.942095 — what the wallet holds after M3's reveal
const PUBLIC = 994_997_686n           // 994.997686 — the vault after the same reveal
const FEE = 14_537n                   // the fee that reveal actually paid on-chain
const RESERVE = 51_000n               // REVEAL_FEE_RESERVE + MIN_STEALTH_CHANGE
const TXID = '723d6720fb6225a3b7910c9076fb1026f591e910b098ab1fc8587f88a0623481'
const ADDRESS = 'otl_esm_1tnay4uzgpe0cvu4tzwfmhdhtvc3pq97szrnteetuz2dvqmjk2ecwq34fnsm8hz7tk43xrur8d2y6mye4w3shjq4qj5sm7xvpq7yqqngs8224p'
const SEND_FEE = 16_138n
const ONS_FEE = 21_400n
const SEND_ERROR =
  'The network rejected this transaction: InsufficientFeesPaid { required: 16138, paid: 12000 }'
const REAL_ERROR =
  'The network rejected this transaction in simulation: FailedToExecuteInstruction ' +
  '{ instruction: 4, error: "Bucket 1 not found in workspace — TakeFromBucket consumed it" }'

/**
 * One row per state the shipped Activity can actually reach — both directions, every outcome, and
 * the full lazy-resolution machine a received row runs through. Newest first, as buildActivity sorts.
 */
const ACTIVITY: ActivityRowView[] = [
  { id: 'a1', direction: 'out', title: 'Sent to otl_esm_1t…224p', note: 'lunch', status: 'confirmed', amountMicrotari: 1_500_000n },
  { id: 'a2', direction: 'in', title: 'Received from npub1abcd…wxyz', note: 'thanks!', status: 'received', amountMicrotari: 12_000_000n },
  { id: 'a3', direction: 'in', title: 'Received from npub1qqrs…m2k9', note: '', status: 'checking', amountMicrotari: null },
  { id: 'a4', direction: 'out', title: 'Sent to @okan', note: 'rent', status: 'sent', amountMicrotari: 250_000_000n },
  { id: 'a5', direction: 'out', title: 'Sent to otl_esm_1kq…8f31', note: '', status: 'unconfirmed', amountMicrotari: 5_000_000n },
  { id: 'a6', direction: 'in', title: 'Received from npub1z8vk…4tql', note: 'split the bill', status: 'pending', amountMicrotari: null },
  { id: 'a7', direction: 'out', title: 'Sent from another device', note: '', status: 'confirmed', amountMicrotari: null },
  { id: 'a8', direction: 'in', title: 'Received from npub1h3ne…9wsd', note: 'coffee', status: 'spent', amountMicrotari: 900_000n },
  { id: 'a9', direction: 'out', title: 'Sent to otl_esm_1m4…c7de', note: '', status: 'failed', amountMicrotari: 2_000_000n },
  { id: 'a10', direction: 'in', title: 'Received from npub1v0pq…s6xa', note: '', status: 'unreadable', amountMicrotari: null },
]

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
  /** Which surface to draw. The page layout is wide, so it is worth checking here too. */
  const [chrome, setChrome] = useState<'modal' | 'page'>('modal')
  const [scenario, setScenario] = useState<Scenario>('both')
  const [hidden, setHidden] = useState(false)
  const [showFacts, setShowFacts] = useState(true)
  const [move, setMove] = useState<MoveView>({ step: 'idle' })
  const [tab, setTab] = useState<WalletTab>('overview')
  const [faucet, setFaucet] = useState<FaucetPhase>('idle')
  const [ons, setOns] = useState<OnsStatus>('idle')
  const [onsName, setOnsName] = useState('')
  const [copied, setCopied] = useState(false)
  const [addrReady, setAddrReady] = useState(true)
  const [send, setSend] = useState<SendView>({ step: 'form', recipient: '', amount: '', note: '', available: PRIVATE, canReview: false, source: 'private', canChooseSource: true })
  const [refreshing, setRefreshing] = useState(false)
  const [emptyActivity, setEmptyActivity] = useState(false)
  const [incomplete, setIncomplete] = useState(false)

  const settled = balancesFor(scenario)
  // A refresh re-reads BOTH balances, so both drop to their loading treatment for the duration —
  // which is exactly what the real scan does, and the whole point of showing it.
  const priv = refreshing ? LOADING : settled.priv
  const pub = refreshing ? LOADING : settled.pub
  const privV = settled.priv.status === 'ready' ? settled.priv.microtari : 0n
  const pubV = settled.pub.status === 'ready' ? settled.pub.microtari : 0n

  function runRefresh() {
    if (refreshing) return
    setRefreshing(true)
    setTimeout(() => setRefreshing(false), 1600)
  }

  const parse = (s: string): bigint => {
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return 0n
    const [w, f = ''] = s.split('.')
    return BigInt(w || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6))
  }

  /** The same ceiling rule the app applies: the fee comes out of the shielded side on an unshield. */
  const ceilingFor = (dir: Dir) => {
    const available = dir === 'conceal' ? pubV : privV
    return dir === 'conceal' ? available : (available > RESERVE ? available - RESERVE : 0n)
  }

  function openMove(dir: Dir) {
    setMove({
      step: 'form', dir, amount: '', maxUsed: false,
      available: dir === 'conceal' ? pubV : privV,
      minMicrotari: 100_000n, maxMicrotari: ceilingFor(dir),
      canReview: false,
    })
  }

  function refreshForm(dir: Dir, next: string, usedMax: boolean) {
    const available = dir === 'conceal' ? pubV : privV
    const ceiling = dir === 'conceal' ? available : (available > RESERVE ? available - RESERVE : 0n)
    const entered = parse(next)
    const belowMin = next !== '' && entered < 100_000n
    const over = next !== '' && entered > ceiling
    setMove({
      step: 'form', dir, amount: next, maxUsed: usedMax, available,
      minMicrotari: 100_000n, maxMicrotari: ceiling,
      canReview: next !== '' && !belowMin && !over,
      error: belowMin ? 'Minimum 0.10 XTR.'
        : over ? (dir === 'reveal'
            ? `More than you can unshield — the fee comes out of your shielded balance too. Most you can move now: ${fmt6(ceiling)} XTR.`
            : 'More than your unshielded balance.')
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
    chrome,
    privateBalance: priv, publicBalance: pub, hidden, networkChip: 'Esmeralda testnet',
    total: computeTotal({
      privateBalance: priv, publicBalance: pub, privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: incomplete,
      settling: move.step === 'settling',
    }),
    scanSummary: {
      status: refreshing ? 'scanning' : priv.status === 'unavailable' ? 'error' : priv.status === 'loading' ? 'scanning' : 'done',
      scanned: 1247, owned: 6, progressScanned: 812,
    },
    move, entries, lockedText: locked, lockedIsFlight: lockedFlight,
    inFlightText: scenario === 'inFlight' ? 'Making 1.000000 TARI public' : undefined,
    onToggleHidden: () => setHidden(h => !h),
    refreshing,
    onRefresh: runRefresh,
    onClose: () => setMove({ step: 'idle' }),
    onBack: () => setMove({ step: 'idle' }),
    onAmountChange: v => refreshForm(dir, v, false),
    onMax: () => {
      const available = dir === 'conceal' ? pubV : privV
      const ceiling = dir === 'conceal' ? available : (available > RESERVE ? available - RESERVE : 0n)
      refreshForm(dir, toInput(ceiling), true)
    },
    onReview: () => {
      setMove({ step: 'review', dir, amountMicrotari: amt, feeMicrotari: null, resulting: null })
      setTimeout(() => setMove({ step: 'review', dir, amountMicrotari: amt, feeMicrotari: FEE, resulting: resulting(amt, dir) }), 1400)
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
    onRetryBalance: () => { setScenario('both'); runRefresh() },
    activity: emptyActivity ? undefined : ACTIVITY.map(r => <ActivityRowShell key={r.id} row={r} hidden={hidden} />),

    tab, onTab: setTab,
    faucet: {
      phase: faucet, received: 1_000_000_000n, balance: privV,
      onClaim: () => {
        setFaucet('claiming')
        setTimeout(() => setFaucet('verifying'), 1400)
        setTimeout(() => setFaucet('done'), 3200)
      },
      onRefresh: () => setFaucet('done'),
    },
    ons: {
      status: ons, name: onsName || 'yourname', feeMicrotari: ONS_FEE, txId: TXID,
      policyError: /[^a-z0-9_]/.test(onsName) ? 'Letters, numbers and underscores only.' : undefined,
      onName: v => { setOnsName(v.toLowerCase()); setOns('idle') },
      onCheck: () => { setOns('checking'); setTimeout(() => setOns(onsName === 'taken' ? 'taken' : 'available'), 1200) },
      onRegister: () => { setOns('estimating'); setTimeout(() => setOns('confirm'), 1200) },
      onConfirm: () => { setOns('registering'); setTimeout(() => setOns('done'), 1600) },
      onReset: () => setOns('idle'),
      onCopyTx: t => navigator.clipboard?.writeText(t).catch(() => {}),
    },
    receive: {
      address: addrReady ? ADDRESS : null, copied,
      onCopy: () => { setCopied(true); setTimeout(() => setCopied(false), 1800) },
    },
    send: {
      view: send, hidden,
      onRecipient: v => setSend(s0 => s0.step === 'form' ? { ...s0, recipient: v, canReview: !!v && !!s0.amount } : s0),
      onAmount: v => setSend(s0 => s0.step === 'form' ? { ...s0, amount: v, canReview: !!s0.recipient && !!v } : s0),
      onNote: v => setSend(s0 => s0.step === 'form' ? { ...s0, note: v } : s0),
      onSource: (src) => setSend(s0 => s0.step === 'form' ? { ...s0, source: src } : s0),
      onMax: () => setSend(s0 => s0.step === 'form' ? { ...s0, amount: toInput(privV > SEND_FEE ? privV - SEND_FEE : 0n), canReview: !!s0.recipient } : s0),
      onReview: () => setSend(s0 => {
        if (s0.step !== 'form') return s0
        const a = parse(s0.amount)
        setTimeout(() => setSend({ step: 'review', recipient: s0.recipient, amountMicrotari: a, note: s0.note, feeMicrotari: SEND_FEE, source: s0.source }), 1300)
        return { step: 'review', recipient: s0.recipient, amountMicrotari: a, note: s0.note, feeMicrotari: null, source: s0.source }
      }),
      onBack: () => setSend(s0 => s0.step === 'review'
        ? { step: 'form', recipient: s0.recipient, amount: toInput(s0.amountMicrotari), note: s0.note, available: privV, canReview: true, source: s0.source, canChooseSource: true }
        : s0),
      onConfirm: () => setSend(s0 => {
        if (s0.step !== 'review') return s0
        setTimeout(() => setSend({ step: 'success', recipient: s0.recipient, amountMicrotari: s0.amountMicrotari, feeMicrotari: SEND_FEE, txId: TXID }), 1800)
        return { step: 'sending', amountMicrotari: s0.amountMicrotari, progress: 'Building the payment and broadcasting. Don’t close this window.', source: s0.source }
      }),
      onDone: () => setSend({ step: 'form', recipient: '', amount: '', note: '', available: privV, canReview: false, source: 'private', canChooseSource: true }),
      onRetry: () => setSend({ step: 'form', recipient: '', amount: '', note: '', available: privV, canReview: false, source: 'private', canChooseSource: true }),
      onCopyTx: t => navigator.clipboard?.writeText(t).catch(() => {}),
      onViewActivity: () => setTab('activity'),
    },
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
          <button onClick={() => setEmptyActivity(e => !e)} style={btn(emptyActivity)}>Activity empty {emptyActivity ? '· on' : '· off'}</button>
          <button onClick={() => setIncomplete(i => !i)} style={btn(incomplete)}>Scan incomplete {incomplete ? '· on' : '· off'}</button>
        </Group>
        <Group title="Refresh" note="Or press Refresh in the modal header">
          <button onClick={runRefresh} style={btn(refreshing)}>{refreshing ? 'Refreshing…' : 'Run a refresh (1.6s)'}</button>
          <button onClick={() => setRefreshing(r => !r)} style={btn(false)}>Hold refreshing {refreshing ? 'off' : 'on'}</button>
        </Group>
        <Group title="Tab">
          {WALLET_TABS.map(t => (
            <button key={t} onClick={() => { setTab(t); setMove({ step: 'idle' }) }} style={btn(tab === t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </Group>
        <Group title="Faucet panel" note="Shown on Overview">
          {(['idle', 'locked', 'claiming', 'verifying', 'done', 'lagging', 'error', 'cooldown', 'plenty'] as FaucetPhase[]).map(f => (
            <button key={f} onClick={() => { setFaucet(f); setTab('overview') }} style={btn(faucet === f)}>{f}</button>
          ))}
        </Group>
        <Group title="Name panel" note="Type “taken” in the field to see the taken state">
          {(['idle', 'checking', 'available', 'taken', 'estimating', 'confirm', 'registering', 'done', 'error'] as OnsStatus[]).map(o => (
            <button key={o} onClick={() => { setOns(o); setTab('overview') }} style={btn(ons === o)}>{o}</button>
          ))}
        </Group>
        <Group title="Send state">
          {([
            ['Form', { step: 'form', recipient: '', amount: '', note: '', available: privV, canReview: false, source: 'private', canChooseSource: true }],
            ['Review · pricing', { step: 'review', recipient: ADDRESS, amountMicrotari: 1_500_000n, note: 'lunch', feeMicrotari: null, source: 'private' }],
            ['Review · priced', { step: 'review', recipient: ADDRESS, amountMicrotari: 1_500_000n, note: 'lunch', feeMicrotari: SEND_FEE, source: 'private' }],
            ['Sending', { step: 'sending', amountMicrotari: 1_500_000n, progress: 'Building the payment and broadcasting. Don’t close this window.', source: 'private' }],
            ['Success', { step: 'success', recipient: ADDRESS, amountMicrotari: 1_500_000n, feeMicrotari: SEND_FEE, txId: TXID }],
            ['Unconfirmed', { step: 'unconfirmed', message: 'Broadcast, but the network hasn’t confirmed it yet. Don’t resend — it will appear in Activity.', txId: TXID }],
            ['Error · verbatim', { step: 'error', message: SEND_ERROR }],
          ] as [string, SendView][]).map(([label, v]) => (
            <button key={label} onClick={() => { setSend(v); setTab('send') }} style={btn(send.step === v.step)}>{label}</button>
          ))}
        </Group>
        <Group title="Receive">
          <button onClick={() => { setAddrReady(true); setTab('receive') }} style={btn(addrReady)}>Address ready</button>
          <button onClick={() => { setAddrReady(false); setTab('receive') }} style={btn(!addrReady)}>Preparing address</button>
        </Group>
        <Group title="Jump to a move state" note="Bypasses the flow — for states that are hard to reach">
          {jump('Form · shield', { step: 'form', dir: 'conceal', amount: '100', maxUsed: false, available: pubV, minMicrotari: 100_000n, maxMicrotari: pubV, canReview: true })}
          {jump('Form · unshield', { step: 'form', dir: 'reveal', amount: '1', maxUsed: false, available: privV, minMicrotari: 100_000n, maxMicrotari: privV - RESERVE, canReview: true })}
          {jump('Form · MAX pressed', { step: 'form', dir: 'reveal', amount: toInput(privV - RESERVE), maxUsed: true, available: privV, minMicrotari: 100_000n, maxMicrotari: privV - RESERVE, canReview: true, leftoverNote: `About ${fmt6(RESERVE)} XTR stays shielded to cover the fee. It’s still yours and still spendable.` })}
          {jump('Form · below minimum', { step: 'form', dir: 'reveal', amount: '0.05', maxUsed: false, available: privV, minMicrotari: 100_000n, maxMicrotari: privV - RESERVE, canReview: false, error: 'Minimum 0.10 XTR.' })}
          {jump('Review · pricing', { step: 'review', dir: 'conceal', amountMicrotari: 100_000_000n, feeMicrotari: null, resulting: null })}
          {jump('Review · shield', { step: 'review', dir: 'conceal', amountMicrotari: 100_000_000n, feeMicrotari: FEE, resulting: resulting(100_000_000n, 'conceal') })}
          {jump('Review · unshield', { step: 'review', dir: 'reveal', amountMicrotari: 1_000_000n, feeMicrotari: FEE, resulting: resulting(1_000_000n, 'reveal') })}
          {jump('Review · unshield MAX (leftover)', { step: 'review', dir: 'reveal', amountMicrotari: privV - RESERVE, feeMicrotari: FEE, resulting: resulting(privV - RESERVE, 'reveal'), leftoverNote: `About ${fmt6(RESERVE)} XTR stays shielded to cover the fee. It’s still yours and still spendable.` })}
          {jump('Moving', { step: 'moving', dir: 'reveal', amountMicrotari: 1_000_000n, progress: 'Submitting to the network — a few seconds.' })}
          {jump('Settling', { step: 'settling', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID })}
          {jump('Success', { step: 'success', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID, lagged: false, resulting: resulting(1_000_000n, 'reveal') })}
          {jump('Success · index lagging', { step: 'success', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID, lagged: true, resulting: null })}
          {jump('Error · verbatim', { step: 'error', dir: 'reveal', message: REAL_ERROR, txId: TXID })}
          {jump('Idle', { step: 'idle' })}
        </Group>
      </aside>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <Caption>{SCENARIOS.find(s => s.id === scenario)?.note}</Caption>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setChrome('modal')} style={{ ...btn(chrome === 'modal'), width: 'auto', padding: '6px 14px' }}>Modal chrome</button>
          <button onClick={() => setChrome('page')} style={{ ...btn(chrome === 'page'), width: 'auto', padding: '6px 14px' }}>Page chrome</button>
        </div>
        {/* The page fills its container, so the harness gives it one the width of the real pane. */}
        <div style={chrome === 'page'
          ? { width: '100%', maxWidth: PAGE_MAX_WIDTH, background: C.void, borderRadius: 'var(--r-lg)', padding: 20, border: '1px solid var(--border)' }
          : undefined}>
          <WalletModalV2 {...props} />
        </div>
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
    tab: 'overview', onTab: noop,
    faucet: { phase: 'idle', onClaim: noop, onRefresh: noop },
    ons: { status: 'idle', name: '', onName: noop, onCheck: noop, onRegister: noop, onConfirm: noop, onReset: noop, onCopyTx: noop },
    receive: { address: ADDRESS, copied: false, onCopy: noop },
    activity: ACTIVITY.map(r => <ActivityRowShell key={r.id} row={r} hidden={false} />),
    scanSummary: { status: 'done', scanned: 1247, owned: 6, progressScanned: 1247 },
    total: computeTotal({ privateBalance: ready(PRIVATE), publicBalance: ready(PUBLIC), privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, settling: false }),
    send: {
      view: { step: 'form', recipient: '', amount: '', note: '', available: PRIVATE, canReview: false, source: 'private', canChooseSource: true },
      hidden: false, onSource: noop, onRecipient: noop, onAmount: noop, onNote: noop, onMax: noop,
      onReview: noop, onBack: noop, onConfirm: noop, onDone: noop, onRetry: noop,
      onCopyTx: noop, onViewActivity: noop,
    },
    ...over,
  }
}

/** Shorthands so the gallery entries below stay one line each. */
const faucetAt = (phase: FaucetPhase, extra: Record<string, unknown> = {}) =>
  ({ faucet: { phase, received: 1_000_000_000n, balance: 250_000_000n, onClaim: noop, onRefresh: noop, ...extra } })
const onsAt = (status: OnsStatus, name = 'okan') =>
  ({ ons: { status, name, feeMicrotari: ONS_FEE, txId: TXID, onName: noop, onCheck: noop, onRegister: noop, onConfirm: noop, onReset: noop, onCopyTx: noop } })
const sendAt = (view: SendView) =>
  ({ tab: 'send' as WalletTab, send: { view, hidden: false, onSource: noop, onRecipient: noop, onAmount: noop, onNote: noop, onMax: noop, onReview: noop, onBack: noop, onConfirm: noop, onDone: noop, onRetry: noop, onCopyTx: noop, onViewActivity: noop } })

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
    { label: 'IN FLIGHT · LOCKED', props: still({ inFlightText: 'Unshielding 1.000000 XTR', entries: [], lockedText: 'Locked while a move is in flight', lockedIsFlight: true }) },
    { label: 'FORM · SHIELD', props: still({ move: { step: 'form', dir: 'conceal', amount: '100', maxUsed: false, available: PUBLIC, minMicrotari: 100_000n, maxMicrotari: PUBLIC, canReview: true } }) },
    { label: 'FORM · UNSHIELD, MAX', props: still({ move: { step: 'form', dir: 'reveal', amount: toInput(PRIVATE - RESERVE), maxUsed: true, available: PRIVATE, minMicrotari: 100_000n, maxMicrotari: PRIVATE - RESERVE, canReview: true, leftoverNote: `About ${fmt6(RESERVE)} XTR stays shielded to cover the fee. It’s still yours and still spendable.` } }) },
    { label: 'FORM · BELOW MINIMUM', props: still({ move: { step: 'form', dir: 'reveal', amount: '0.05', maxUsed: false, available: PRIVATE, minMicrotari: 100_000n, maxMicrotari: PRIVATE - RESERVE, canReview: false, error: 'Minimum 0.10 XTR.' } }) },
    { label: 'REVIEW · PRICING', props: still({ move: { step: 'review', dir: 'conceal', amountMicrotari: 100_000_000n, feeMicrotari: null, resulting: null } }) },
    { label: 'REVIEW · SHIELD', props: still({ move: { step: 'review', dir: 'conceal', amountMicrotari: 100_000_000n, feeMicrotari: FEE, resulting: r(100_000_000n, 'conceal') } }) },
    { label: 'REVIEW · UNSHIELD', props: still({ move: { step: 'review', dir: 'reveal', amountMicrotari: 1_000_000n, feeMicrotari: FEE, resulting: r(1_000_000n, 'reveal') } }) },
    { label: 'REVIEW · UNSHIELD MAX (fee remainder)', props: still({ move: { step: 'review', dir: 'reveal', amountMicrotari: PRIVATE - RESERVE, feeMicrotari: FEE, resulting: r(PRIVATE - RESERVE, 'reveal'), leftoverNote: `About ${fmt6(RESERVE)} XTR stays shielded to cover the fee. It’s still yours and still spendable.` } }) },
    { label: 'REVIEW · MAKE PUBLIC (no note — design as drawn)', props: still({ move: { step: 'review', dir: 'reveal', amountMicrotari: 1_000_000n, feeMicrotari: FEE, resulting: r(1_000_000n, 'reveal') } }) },
    { label: 'MOVING', props: still({ move: { step: 'moving', dir: 'conceal', amountMicrotari: 100_000_000n, progress: 'Submitting to the network — a few seconds.' } }) },
    { label: 'SETTLING · DONE, CATCHING UP', props: still({ move: { step: 'settling', dir: 'conceal', amountMicrotari: 100_000_000n, txId: TXID } }) },
    { label: 'SUCCESS · SETTLED', props: still({ move: { step: 'success', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID, lagged: false, resulting: r(1_000_000n, 'reveal') } }) },
    { label: 'SUCCESS · INDEX LAGGING (still a success)', props: still({ move: { step: 'success', dir: 'reveal', amountMicrotari: 1_000_000n, txId: TXID, lagged: true, resulting: null } }) },
    { label: 'ERROR · VERBATIM NETWORK TEXT', props: still({ move: { step: 'error', dir: 'reveal', message: REAL_ERROR, txId: TXID } }) },

    // ── Faucet ──
    { label: 'FAUCET · IDLE', props: still(faucetAt('idle')) },
    { label: 'FAUCET · CLAIMING', props: still(faucetAt('claiming')) },
    { label: 'FAUCET · CHECKING BALANCE', props: still(faucetAt('verifying')) },
    { label: 'FAUCET · RECEIVED', props: still(faucetAt('done')) },
    { label: 'FAUCET · SENT, NOT VISIBLE YET', props: still(faucetAt('lagging')) },
    { label: 'FAUCET · ALREADY CLAIMED', props: still(faucetAt('cooldown')) },
    { label: 'FAUCET · ALREADY HAS PLENTY', props: still(faucetAt('plenty')) },
    { label: 'FAUCET · UNAVAILABLE', props: still(faucetAt('error')) },

    // ── Name (ONS) ──
    { label: 'NAME · IDLE', props: still(onsAt('idle', '')) },
    { label: 'NAME · CHECKING', props: still(onsAt('checking')) },
    { label: 'NAME · AVAILABLE', props: still(onsAt('available')) },
    { label: 'NAME · TAKEN', props: still(onsAt('taken')) },
    { label: 'NAME · CONFIRM THE FEE', props: still(onsAt('confirm')) },
    { label: 'NAME · REGISTERING', props: still(onsAt('registering')) },
    { label: 'NAME · REGISTERED', props: still(onsAt('done')) },
    { label: 'NAME · FAILED', props: still(onsAt('error')) },

    // ── Send ──
    { label: 'SEND · FORM', props: still(sendAt({ step: 'form', recipient: '', amount: '', note: '', available: PRIVATE, canReview: false, source: 'private', canChooseSource: true })) },
    { label: 'SEND · SOURCE = PUBLIC (honest note)', props: still(sendAt({ step: 'form', recipient: '@okan', amount: '1.5', note: '', available: PUBLIC, canReview: true, source: 'public', canChooseSource: true })) },
    { label: 'SEND · REVIEW FROM PUBLIC', props: still(sendAt({ step: 'review', recipient: ADDRESS, amountMicrotari: 1_500_000n, note: 'lunch', feeMicrotari: 14_456n, source: 'public' })) },
    { label: 'SEND · SENT, INDEX LAGGING', props: still(sendAt({ step: 'success', recipient: ADDRESS, amountMicrotari: 1_500_000n, feeMicrotari: SEND_FEE, txId: TXID, lagged: true })) },
    { label: 'SEND · FORM, FILLED', props: still(sendAt({ step: 'form', recipient: '@okan', amount: '1.5', note: 'lunch', available: PRIVATE, canReview: true, source: 'private', canChooseSource: true })) },
    { label: 'SEND · REVIEW, PRICING', props: still(sendAt({ step: 'review', recipient: ADDRESS, amountMicrotari: 1_500_000n, note: 'lunch', feeMicrotari: null, source: 'private' })) },
    { label: 'SEND · REVIEW, PRICED', props: still(sendAt({ step: 'review', recipient: ADDRESS, amountMicrotari: 1_500_000n, note: 'lunch', feeMicrotari: SEND_FEE, source: 'private' })) },
    { label: 'SEND · SENDING', props: still(sendAt({ step: 'sending', amountMicrotari: 1_500_000n, progress: 'Building the payment and broadcasting. Don’t close this window.', source: 'private' })) },
    { label: 'SEND · SENT', props: still(sendAt({ step: 'success', recipient: ADDRESS, amountMicrotari: 1_500_000n, feeMicrotari: SEND_FEE, txId: TXID })) },
    { label: 'SEND · NOT CONFIRMED YET', props: still(sendAt({ step: 'unconfirmed', message: 'Broadcast, but the network hasn’t confirmed it yet. Don’t resend — it will appear in Activity.', txId: TXID })) },
    { label: 'SEND · FAILED', props: still(sendAt({ step: 'error', message: SEND_ERROR })) },

    // ── Receive / Activity ──
    { label: 'RECEIVE · ADDRESS + QR', props: still({ tab: 'receive' }) },
    { label: 'RECEIVE · PREPARING', props: still({ tab: 'receive', receive: { address: null, copied: false, onCopy: noop } }) },

    // ── Activity ──
    { label: 'ACTIVITY · EVERY ROW STATE', props: still({ tab: 'activity' }) },
    { label: 'ACTIVITY · AMOUNTS HIDDEN', props: still({ tab: 'activity', hidden: true, activity: ACTIVITY.map(r => <ActivityRowShell key={r.id} row={r} hidden />) }) },
    { label: 'ACTIVITY · EMPTY', props: still({ tab: 'activity', activity: [] }) },
    { label: 'RECENT · LATEST THREE ON THE PAGE', props: still({ tab: 'overview' }) },
    { label: 'RECENT · EMPTY ON THE PAGE', props: still({ tab: 'overview', activity: [] }) },

    // ── The total ──
    { label: 'TOTAL · BOTH CONFIDENT', props: still({}) },
    { label: 'TOTAL · SETTLING (a move is in flight)', props: still({ total: computeTotal({ privateBalance: ready(PRIVATE), publicBalance: ready(PUBLIC), privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, settling: true }) }) },
    { label: 'TOTAL · SETTLING, MID-RESCAN', props: still({ privateBalance: LOADING, publicBalance: LOADING, total: computeTotal({ privateBalance: LOADING, publicBalance: LOADING, privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, settling: true }) }) },
    { label: 'TOTAL · “—” PUBLIC UNAVAILABLE', props: still({ publicBalance: UNAVAIL, total: computeTotal({ privateBalance: ready(PRIVATE), publicBalance: UNAVAIL, privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, settling: false }) }) },
    { label: 'TOTAL · “—” PRIVATE UNAVAILABLE', props: still({ privateBalance: UNAVAIL, total: computeTotal({ privateBalance: UNAVAIL, publicBalance: ready(PUBLIC), privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, settling: false }) }) },
    { label: 'TOTAL · “—” SCAN INCOMPLETE', props: still({ total: computeTotal({ privateBalance: ready(PRIVATE), publicBalance: ready(PUBLIC), privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: true, settling: false }) }) },
    { label: 'TOTAL · “—” BOTH UNAVAILABLE', props: still({ privateBalance: UNAVAIL, publicBalance: UNAVAIL, total: computeTotal({ privateBalance: UNAVAIL, publicBalance: UNAVAIL, privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, settling: false }) }) },
    { label: 'TOTAL · SETTLING (no number, ever)', props: still({ total: computeTotal({ privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, privateBalance: ready(850_250_000n), publicBalance: ready(249_957_422n), settling: true }) }) },
    { label: 'TOTAL · “—” LAGGED PAST THE DEADLINE', props: still({ total: computeTotal({ privateGeneration: 1, publicGeneration: 1, settleLagged: true, privateIncomplete: false, privateBalance: ready(850_250_000n), publicBalance: ready(249_957_422n), settling: false }) }) },
    { label: 'TOTAL · MISMATCHED FRESHNESS (never a number)', props: still({ total: computeTotal({ privateGeneration: 1, publicGeneration: 2, settleLagged: false, privateIncomplete: false, privateBalance: ready(900_000_000n), publicBalance: ready(199_000_000n), settling: false }) }) },
    { label: 'TOTAL · LOADING', props: still({ privateBalance: LOADING, publicBalance: LOADING, total: computeTotal({ privateBalance: LOADING, publicBalance: LOADING, privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, settling: false }) }) },
    { label: 'TOTAL · HIDDEN', props: still({ hidden: true }) },

    // ── The scan diagnostic ──
    { label: 'SCAN STRIP · SCANNED · OWNED', props: still({}) },
    { label: 'SCAN STRIP · SCANNING', props: still({ scanSummary: { status: 'scanning', scanned: 0, owned: 0, progressScanned: 812 } }) },
    { label: 'SCAN STRIP · SCAN FAILED', props: still({ scanSummary: { status: 'error', scanned: 0, owned: 0, progressScanned: 0 }, privateBalance: UNAVAIL, total: computeTotal({ privateBalance: UNAVAIL, publicBalance: ready(PUBLIC), privateGeneration: 1, publicGeneration: 1, settleLagged: false, privateIncomplete: false, settling: false }) }) },
    { label: 'SCAN STRIP · NEVER SCANNED', props: still({ scanSummary: { status: 'idle', scanned: 0, owned: 0, progressScanned: 0 } }) },

    // ── Refresh ──
    { label: 'REFRESHING · BOTH BALANCES RE-READ', props: still({ refreshing: true, privateBalance: LOADING, publicBalance: LOADING, entries: [], lockedText: 'Checking your balances…' }) },
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
  /**
   * THEME, IN THE HARNESS ONLY.
   *
   * The shipped shell has no theme switch yet — the app is dark until the app-wide light pass. But
   * the wallet is built theme-aware NOW, and "theme-aware" is a claim that has to be checkable
   * against the states that matter. This harness is already the place the wallet's unreachable
   * states are driven from (settling, unavailable, disabled-with-reason), so it is the right place
   * to cross them with both themes.
   *
   * Applied to this subtree, exactly as the landing page does it: the light block in index.css
   * matches any element, not only :root. Dev-only — dev-wallet.html is never built.
   */
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  return (
    <div data-theme={theme} style={{ minHeight: '100vh', background: 'var(--surface-void)', padding: '32px 36px 120px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', color: C.primary }}>Wallet modal v2 — preview</h1>
        <span style={{ fontSize: 13.5, color: C.faint }}>Mock data only. No wallet, no network, no fund logic.</span>
      </header>
      <div style={{ display: 'flex', gap: 8, margin: '18px 0 28px', flexWrap: 'wrap' }}>
        <button onClick={() => setMode('drive')} style={{ ...btn(mode === 'drive'), width: 'auto', padding: '8px 18px' }}>Drive</button>
        <button onClick={() => setMode('gallery')} style={{ ...btn(mode === 'gallery'), width: 'auto', padding: '8px 18px' }}>Gallery</button>
        <span style={{ width: 18 }} />
        <button onClick={() => setTheme('dark')} style={{ ...btn(theme === 'dark'), width: 'auto', padding: '8px 18px' }}>Dark</button>
        <button onClick={() => setTheme('light')} style={{ ...btn(theme === 'light'), width: 'auto', padding: '8px 18px' }}>Light</button>
      </div>
      {mode === 'drive' ? <Drive /> : <Gallery />}
    </div>
  )
}
