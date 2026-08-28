// The M4 wallet modal, composed. PRESENTATIONAL ONLY.
//
// Everything it renders comes from `props`; it owns no wallet state, touches no network, and does
// no arithmetic beyond formatting. That is deliberate and is what makes Stage 2 a reskin rather
// than a rewrite: the proven builders (conceal.ts, reveal.ts), the settle hook, the exact-bigint
// MAX and the zero-vs-unavailable split keep producing exactly the values they produce today, and
// this component displays them.
//
// The view union below is shaped to match the shipped MoveStep machine one-for-one, with two
// deliberate differences the design introduces:
//
//   * PRICING IS NOT A SCREEN. The design prices INSIDE review — the fee row shows a spinner and
//     the confirm button is inert until the number arrives. The shipped flow has a whole 'pricing'
//     step that shows nothing but a spinner; folding it into review means the user reads the amount
//     and the direction while the fee resolves, instead of watching a blank card.
//   * ERROR OFFERS "TRY AGAIN". The shipped flow only offers Close, which throws away a typed
//     amount on a transient network failure.

import type { ReactNode } from 'react'
import { C, MONO, tealBorder, tealFill } from './tokens'
import { Alert, Check, Eye, EyeOff, Shield, Spinner } from './icons'
import {
  Body, Button, DetailCard, DetailRow, FeeRow, ModalShell, RootHeader, ScanStrip, SettleBar,
  StatusBlock, SubHeader, TabBar, TxRow, iconBtn, type ScanSummary,
} from './primitives'
import {
  ActivityPanel, FaucetPanel, OnsPanel, ReceivePanel, SendPanel,
  type FaucetPanelProps, type OnsPanelProps, type SendPanelProps,
} from './panels'
import type { BalanceView } from './balances'
import { TotalHero } from './TotalHero'
import type { TotalView } from './total'
import {
  AmountCard, DIR, DirectionChips, InFlightBanner, MoveList, PermanenceNote,
  type Dir, type EntryProps,
} from './move'
import { fmt6 } from './format'

/**
 * Top-level areas. The design canvas navigates by pushing sub-views and draws no tab bar, but the
 * shipped modal has these four and dropping one would be an IA change rather than a reskin — so
 * tabs select the area and flows inside an area still push a sub-view.
 */
export const WALLET_TABS = ['overview', 'send', 'receive', 'activity'] as const
export type WalletTab = (typeof WALLET_TABS)[number]

/** Balances after the move lands — the number the M4 report found missing from both reviews. */
export interface Resulting { privateAfter: bigint; publicAfter: bigint }

export type MoveView =
  | { step: 'idle' }
  | {
      step: 'form'; dir: Dir; amount: string; maxUsed: boolean
      available: bigint | null; leftoverNote?: string; error?: string; canReview: boolean
    }
  | {
      step: 'review'; dir: Dir; amountMicrotari: bigint
      /** null while the dry run is in flight — the fee row spins and confirm stays inert. */
      feeMicrotari: bigint | null
      resulting: Resulting | null
      showPermanenceNote?: boolean
    }
  | { step: 'moving'; dir: Dir; amountMicrotari: bigint; progress: string }
  | { step: 'settling'; dir: Dir; amountMicrotari: bigint; txId: string }
  | {
      step: 'success'; dir: Dir; amountMicrotari: bigint; txId: string
      /** The settle deadline passed. STILL A SUCCESS — different copy, same shape. */
      lagged: boolean
      resulting: Resulting | null
    }
  | { step: 'error'; dir: Dir; message: string; txId?: string }

export interface WalletModalV2Props {
  privateBalance: BalanceView
  publicBalance: BalanceView
  /**
   * The combined balance — THE HERO. The two balances above render as its breakdown rather than as
   * separate cards; see TotalHero for why the breakdown stays visible even when the total itself
   * cannot be shown.
   *
   * REQUIRED since M9 CP3. It was optional while M7's total was landing, with the pre-total layout
   * kept behind a `total ? … : …` fallback. Every call site has passed a total since, and
   * computeTotal cannot return undefined, so the fallback was unreachable in the app AND in the
   * preview — a second balance layout that nobody could see and no test could reach, drifting.
   */
  total: TotalView
  hidden: boolean
  networkChip?: string
  move: MoveView
  /** Entry rows for the idle view. Pass a disabledReason to show a direction as unavailable. */
  entries: EntryProps[]
  /** Replaces the entry list entirely — the in-flight lock, or unknown balances. */
  lockedText?: string
  lockedIsFlight?: boolean
  /** Banner above the balances while a move runs in the background. */
  inFlightText?: string
  onToggleHidden: () => void
  onRefresh: () => void
  /** Omitted in page chrome — see SubHeader. The ✕ is not rendered rather than made inert. */
  onClose?: () => void
  onBack: () => void
  onAmountChange: (v: string) => void
  onMax: () => void
  onReview: () => void
  onConfirm: () => void
  onDone: () => void
  onRetryMove: () => void
  onCopyTx: (txId: string) => void
  onRetryBalance?: () => void

  // ── The areas beyond the balance card. Omit one and its tab renders nothing. ──
  tab?: WalletTab
  onTab?: (t: WalletTab) => void
  /**
   * Faucet and name panels as DATA — used by the preview harness, which has no real logic behind
   * them. The app passes `overviewExtras` instead: those two panels own their own state machines
   * (claim, cooldown, the settle loop; check/estimate/register) and reskinning them meant keeping
   * that logic where it lives rather than lifting it up here.
   */
  faucet?: FaucetPanelProps
  ons?: OnsPanelProps
  /** Rendered at the foot of Overview — the app's own stateful panels. */
  overviewExtras?: ReactNode
  send?: SendPanelProps
  receive?: { address: string | null; copied: boolean; onCopy: () => void }
  /** Pre-rendered rows — see ActivityPanel for why this is children, not data. */
  activity?: ReactNode
  activityEmpty?: boolean
  /**
   * A balance refresh is running.
   *
   * SEPARATE FROM the balances' own `loading` status, because they are different facts: `loading`
   * is "we have never had a value", `refreshing` is "we have one and are re-reading it". The
   * control has to acknowledge the press either way — a Refresh that visibly does nothing reads as
   * broken, and this is a wallet whose whole async story is that reads lag.
   */
  refreshing?: boolean
  /** Last private-scan diagnostics, shown beside Refresh. Omit to hide the strip entirely. */
  scanSummary?: ScanSummary
}

const TARI = (n: bigint) => `${fmt6(n)} TARI`

export default function WalletModalV2(p: WalletModalV2Props) {
  const m = p.move

  // ── Root view: the tab bar, and whichever area is selected ──
  if (m.step === 'idle') {
    const tab = p.tab ?? 'overview'
    return (
      <ModalShell>
        <RootHeader chip={p.networkChip} right={<>
          <span role="button" tabIndex={0} onClick={p.onToggleHidden} onKeyDown={e => e.key === 'Enter' && p.onToggleHidden()}
            aria-label={p.hidden ? 'Show balances' : 'Hide balances'}
            style={p.hidden
              ? { ...iconBtn, background: tealFill(0.1), border: tealBorder(0.35) }
              : { ...iconBtn, background: 'transparent', border: 'none', width: 24 }}>
            {p.hidden ? <EyeOff color={C.teal} /> : <Eye size={17} color={C.tealDim} />}
          </span>
          {p.onClose && <span role="button" tabIndex={0} onClick={p.onClose} onKeyDown={e => e.key === 'Enter' && p.onClose!()} style={iconBtn} aria-label="Close">✕</span>}
        </>} />
        {p.scanSummary && <ScanStrip scan={p.scanSummary} refreshing={p.refreshing} onRefresh={p.onRefresh} />}
        <Body gap={14}>
          {p.onTab && <TabBar tabs={WALLET_TABS} active={tab} onSelect={p.onTab} />}

          {tab === 'overview' && <>
            {p.inFlightText && <InFlightBanner text={p.inFlightText} />}
            <TotalHero total={p.total} privateBalance={p.privateBalance} publicBalance={p.publicBalance} hidden={p.hidden} />
            {/* The design's own loading footer, shown whenever a read is actually in flight — so a
                Refresh press is acknowledged even when the previous values are still on screen. */}
            {(p.refreshing || p.privateBalance.status === 'loading' || p.publicBalance.status === 'loading') && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '2px 0 6px' }}>
                <Spinner size={13} />
                <span style={{ fontSize: 12.5, color: C.mutedDim }}>Checking your balances…</span>
              </div>
            )}
            <MoveList entries={p.entries} lockedText={p.lockedText} lockedIsFlight={p.lockedIsFlight} />
            {p.faucet && <FaucetPanel {...p.faucet} />}
            {p.ons && <OnsPanel {...p.ons} />}
            {p.overviewExtras}
          </>}

          {tab === 'send' && p.send && <SendPanel {...p.send} />}
          {tab === 'receive' && p.receive && <ReceivePanel {...p.receive} />}
          {tab === 'activity' && (
            <ActivityPanel empty={p.activityEmpty ?? !p.activity} hidden={p.hidden} onToggleHidden={p.onToggleHidden}>
              {p.activity}
            </ActivityPanel>
          )}
        </Body>
      </ModalShell>
    )
  }

  // ── Amount entry ──
  if (m.step === 'form') {
    return (
      <ModalShell>
        <SubHeader title={DIR[m.dir].title} onBack={p.onBack} onClose={p.onClose} />
        <Body gap={16}>
          <DirectionChips dir={m.dir} />
          <AmountCard
            dir={m.dir} value={m.amount} onChange={p.onAmountChange} onMax={p.onMax}
            maxUsed={m.maxUsed} available={m.available} hidden={p.hidden}
            leftoverNote={m.leftoverNote} error={m.error}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: C.mutedDim, padding: '0 4px' }}>
            <span>Network fee</span>
            <span style={{ color: C.muted }}>Shown before you confirm</span>
          </div>
          <Button tone={m.canReview ? (m.dir === 'conceal' ? 'primary' : 'neutral') : 'disabled'} onClick={p.onReview}>Review</Button>
        </Body>
      </ModalShell>
    )
  }

  // ── Review (prices in place) ──
  if (m.step === 'review') {
    const pricing = m.feeMicrotari === null
    const isReveal = m.dir === 'reveal'
    return (
      <ModalShell>
        <SubHeader title="Review" onBack={p.onBack} onClose={p.onClose} />
        <Body gap={16}>
          <Headline amount={m.amountMicrotari} dir={m.dir} />
          {isReveal && m.showPermanenceNote && <PermanenceNote />}
          <DetailCard>
            <FeeRow fee={m.feeMicrotari === null ? null : fmt6(m.feeMicrotari)} last={!m.resulting} />
            {/* THE NUMBER THE OLD REVIEW NEVER SHOWED. The M4 report's gap #10: users want to know
                what they will be left with, not how the transaction is assembled. */}
            {m.resulting && <>
              <DetailRow label="Private after" value={TARI(m.resulting.privateAfter)} valueColor={C.teal300} />
              <DetailRow label="Public after" value={TARI(m.resulting.publicAfter)} last />
            </>}
          </DetailCard>
          <Button
            tone={pricing ? 'disabled' : isReveal ? 'amber' : 'primary'}
            onClick={pricing ? undefined : p.onConfirm}
          >
            {isReveal ? `Make ${fmt6(m.amountMicrotari)} TARI public` : 'Make private'}
          </Button>
        </Body>
      </ModalShell>
    )
  }

  // ── In flight ──
  if (m.step === 'moving') {
    return (
      <ModalShell>
        <SubHeader title={DIR[m.dir].title} onClose={p.onClose} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, padding: '44px 22px 40px' }}>
          <Spinner size={34} ring={3} />
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: C.bright, textAlign: 'center' }}>
              Moving {fmt6(m.amountMicrotari)} TARI to {m.dir === 'conceal' ? 'private' : 'public'}
            </span>
            <span style={{ fontSize: 13, color: C.mutedDim, textAlign: 'center' }}>{m.progress}</span>
          </span>
        </div>
      </ModalShell>
    )
  }

  // ── Settling: the move is DONE; only the index is behind ──
  if (m.step === 'settling') {
    return (
      <ModalShell>
        <SubHeader title={DIR[m.dir].title} onClose={p.onClose} />
        <Body gap={18}>
          <StatusBlock
            ring={{ fill: tealFill(0.1), border: tealBorder(0.35) }}
            icon={<Check color={C.teal} />}
            title="Move complete"
            sub={`${fmt6(m.amountMicrotari)} TARI is now ${m.dir === 'conceal' ? 'private' : 'public'}. Your balances update in about a minute.`}
          />
          <SettleBar caption="Updating balances — the move itself is finished." />
          <TxRow txId={m.txId} onCopy={() => p.onCopyTx(m.txId)} />
          <Button tone="neutral" onClick={p.onDone}>Done</Button>
        </Body>
      </ModalShell>
    )
  }

  // ── Success (settled, or the deadline passed — both are successes) ──
  if (m.step === 'success') {
    return (
      <ModalShell>
        <SubHeader title={DIR[m.dir].title} onClose={p.onClose} />
        <Body gap={18}>
          <StatusBlock
            ring={{ fill: tealFill(0.1), border: tealBorder(0.35) }}
            icon={<Check color={C.teal} />}
            title={`${fmt6(m.amountMicrotari)} TARI is now ${m.dir === 'conceal' ? 'private' : 'public'}`}
            sub={m.lagged
              ? 'Confirmed on the network. Your balances haven’t caught up yet — tap Refresh in a moment. Nothing is at risk.'
              : 'The move settled on the network.'}
          />
          {m.resulting && (
            <DetailCard>
              <DetailRow label="Private" value={TARI(m.resulting.privateAfter)} valueColor={C.teal300} />
              <DetailRow label="Public" value={TARI(m.resulting.publicAfter)} last />
            </DetailCard>
          )}
          <TxRow txId={m.txId} onCopy={() => p.onCopyTx(m.txId)} />
          <Button tone="primary" onClick={p.onDone}>Done</Button>
        </Body>
      </ModalShell>
    )
  }

  // ── Failure. The verbatim text is load-bearing — see the M4 report. ──
  return (
    <ModalShell>
      <SubHeader title={DIR[m.dir].title} onClose={p.onClose} />
      <Body gap={16}>
        <StatusBlock
          ring={{ fill: 'rgba(var(--danger-rgb),0.10)', border: '1px solid rgba(var(--danger-rgb),0.28)' }}
          icon={<Alert color={C.danger} />}
          title="The move didn’t go through"
          sub="Your funds haven’t moved. You can try again."
        />
        <div style={{
          padding: '13px 15px', borderRadius: 11, background: C.errorGround,
          border: `1px solid rgba(var(--danger-rgb),0.28)`, fontFamily: MONO,
          fontSize: 11.5, lineHeight: 1.65, color: C.dangerText,
          overflowWrap: 'anywhere', userSelect: 'text', cursor: 'text',
          maxHeight: 180, overflowY: 'auto',
        }}>{m.message}</div>
        {m.txId && <TxRow txId={m.txId} onCopy={() => p.onCopyTx(m.txId!)} />}
        <div style={{ display: 'flex', gap: 10 }}>
          <Button tone="neutral" flex={1} onClick={p.onDone}>Close</Button>
          <Button tone="primary" flex={2} onClick={p.onRetryMove}>Try again</Button>
        </div>
      </Body>
    </ModalShell>
  )
}

/** The amount, then what happens to it. Amber on the permanent direction, teal on the routine one. */
function Headline({ amount, dir }: { amount: bigint; dir: Dir }): ReactNode {
  const isReveal = dir === 'reveal'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 0 4px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap', justifyContent: 'center' }}>
        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', fontFeatureSettings: "'tnum'", color: C.bright }}>{fmt6(amount)}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.teal300 }}>TARI</span>
      </div>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: isReveal ? C.warn300 : C.tealLabel }}>
        {DIR[dir].verb}
        {isReveal ? <Eye size={12} color={C.warn} /> : <Shield size={12} color={C.teal} />}
      </span>
    </div>
  )
}
