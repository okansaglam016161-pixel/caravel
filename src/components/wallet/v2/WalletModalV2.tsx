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
import { C, tealBorder, tealFill } from './tokens'
import { Alert, Check, Eye, EyeOff, Spinner } from './icons'
import {
  Body, Button, DetailCard, DetailRow, FeeRow, ModalShell, RootHeader, ScanStrip, SettleBar,
  Sheet, TabBar, TxRow, iconBtn, type Chrome, type ScanSummary,
} from './primitives'
import {
  ActivityPanel, FaucetPanel, OnsPanel, ReceivePanel, SendPanel, VerbatimBox,
  type FaucetPanelProps, type OnsPanelProps, type SendPanelProps,
} from './panels'
import { AssetsPanel } from './assets'
import type { BalanceView } from './balances'
import { TotalHero } from './TotalHero'
import type { TotalView } from './total'
import {
  AmountCard, DIR, InFlightBanner, MoveList,
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

/**
 * The tabs the TAB BAR draws.
 *
 * Send and Receive left it in stage 4 without leaving the `tab` state: they are still selected the
 * same way, they simply render as sheets now. Keeping one piece of state for "which view is up"
 * means the existing transitions — "View in Activity" from an unconfirmed send, for one — keep
 * working untouched, and there is no second source of truth to fall out of step.
 */
const VISIBLE_TABS = ['overview', 'activity'] as const

/** Send and Receive are tasks, and tasks get a sheet. See primitives/Sheet. */
const SHEET_TABS: readonly WalletTab[] = ['send', 'receive']

/** Balances after the move lands — the number the M4 report found missing from both reviews. */
export interface Resulting { privateAfter: bigint; publicAfter: bigint }

export type MoveView =
  | { step: 'idle' }
  | {
      step: 'form'; dir: Dir; amount: string; maxUsed: boolean
      available: bigint | null; leftoverNote?: string; error?: string; canReview: boolean
      /** The floor the builder enforces. Stated up front rather than discovered by being refused. */
      minMicrotari: bigint
      /** The CEILING, not the balance — what MAX pins, and on the unshield side that is less than
       *  the shielded total because the fee comes out of it. Both figures are already computed by
       *  the container; this only carries them to the screen. */
      maxMicrotari: bigint
    }
  | {
      step: 'review'; dir: Dir; amountMicrotari: bigint
      /** null while the dry run is in flight — the fee row spins and confirm stays inert. */
      feeMicrotari: bigint | null
      resulting: Resulting | null
      /**
       * The fee-reserve remainder, WHEN THERE IS ONE.
       *
       * Set only when a remainder genuinely exists — MAX was used and the ceiling really did hold
       * something back — and it names the figure. Unset otherwise, because "a small amount stays
       * shielded to cover the fee" said over an ordinary partial unshield describes nothing that
       * happened. Same value the form shows, so the two screens cannot disagree.
       */
      leftoverNote?: string
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
  /** Opens the asset detail page. Unset until that page exists (stage 9). */
  onOpenAsset?: () => void

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
  /**
   * Which surface this is drawn on. `page` fills the content pane in the service shell; `modal`
   * keeps the 480 column the in-chat wallet has always had. The flows are sheets in both.
   */
  chrome?: Chrome
}

const XTR = (n: bigint) => `${fmt6(n)} XTR`

export default function WalletModalV2(p: WalletModalV2Props) {
  const m = p.move
  const tab = p.tab ?? 'overview'

  // ── The root view. ALWAYS RENDERED ──────────────────────────────────────────
  //
  // Every flow is a sheet over this, so the wallet a user is operating on stays visible behind the
  // thing they are doing to it. Before stage 5 the move flow REPLACED this view outright, which
  // meant shielding funds hid the balances the move was about.
  const root = (
      <ModalShell chrome={p.chrome}>
        <RootHeader chip={p.networkChip} chrome={p.chrome} right={<>
          <span role="button" tabIndex={0} onClick={p.onToggleHidden} onKeyDown={e => e.key === 'Enter' && p.onToggleHidden()}
            aria-label={p.hidden ? 'Show balances' : 'Hide balances'}
            style={p.hidden
              ? { ...iconBtn, background: tealFill(0.1), border: tealBorder(0.35) }
              : { ...iconBtn, background: 'transparent', border: 'none', width: 24 }}>
            {p.hidden ? <EyeOff color={C.teal} /> : <Eye size={17} color={C.tealDim} />}
          </span>
          {p.onClose && <span role="button" tabIndex={0} onClick={p.onClose} onKeyDown={e => e.key === 'Enter' && p.onClose!()} style={iconBtn} aria-label="Close">✕</span>}
        </>} />
        <Body gap={14} chrome={p.chrome}>
          {p.onTab && <TabBar tabs={VISIBLE_TABS} active={tab === 'overview' || tab === 'activity' ? tab : 'overview'} onSelect={p.onTab} />}

          {(tab === 'overview' || SHEET_TABS.includes(tab)) && <>
            {p.inFlightText && <InFlightBanner text={p.inFlightText} />}
            <TotalHero
              total={p.total} privateBalance={p.privateBalance} publicBalance={p.publicBalance}
              hidden={p.hidden} onRetry={p.onRetryBalance}
              onSend={p.send && p.onTab ? () => p.onTab!('send') : undefined}
              onReceive={p.receive && p.onTab ? () => p.onTab!('receive') : undefined}
            />
            {/* The strip acknowledges a Refresh press and carries the literal scan figures. It sits
                UNDER the hero now rather than as a band beneath the header: it describes the read
                that produced the numbers above it, and reads as a caption to them. */}
            {p.scanSummary && <ScanStrip scan={p.scanSummary} refreshing={p.refreshing} onRefresh={p.onRefresh} />}
            {/* The portfolio. One real asset today — see assets.tsx for why that is a presentation
                and not a model. `onOpenAsset` is unset until the detail page exists, which is what
                keeps the row from advertising a destination it cannot reach. */}
            <AssetsPanel
              privateBalance={p.privateBalance} publicBalance={p.publicBalance}
              total={p.total} hidden={p.hidden} onOpen={p.onOpenAsset}
            />
            <MoveList entries={p.entries} lockedText={p.lockedText} lockedIsFlight={p.lockedIsFlight} />
            {p.faucet && <FaucetPanel {...p.faucet} />}
            {p.ons && <OnsPanel {...p.ons} />}
            {/* Faucet and name, side by side where there is room. `auto-fit` + a 280 floor does
                that without a media query, and collapses to one column in the 480 modal and on a
                narrow window — the same rule serves both surfaces. */}
            {p.overviewExtras && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, alignItems: 'start' }}>
                {p.overviewExtras}
              </div>
            )}
          </>}

          {tab === 'activity' && (
            <ActivityPanel empty={p.activityEmpty ?? !p.activity} hidden={p.hidden} onToggleHidden={p.onToggleHidden}>
              {p.activity}
            </ActivityPanel>
          )}
        </Body>
      </ModalShell>
  )

  return (
    <>
      {root}

      {/* ── The flows, over the page ──────────────────────────────────────────
          `dismissable` is false while a transaction is on the wire. Nothing here can call a
          broadcast back, so a close control would misdescribe what it does — the sheet reopens to
          the outcome instead, whatever that turns out to be. */}
      {tab === 'send' && p.send && (
        <Sheet
          title="Send"
          dismissable={p.send.view.step !== 'sending'}
          onClose={() => { p.send!.onDone(); p.onTab?.('overview') }}
        ><SendPanel {...p.send} /></Sheet>
      )}
      {tab === 'receive' && p.receive && (
        <Sheet title="Receive" onClose={() => p.onTab?.('overview')}>
          <ReceivePanel {...p.receive} />
        </Sheet>
      )}
      {m.step !== 'idle' && (
        <Sheet
          title={DIR[m.dir].title}
          dismissable={m.step !== 'moving'}
          onClose={p.onDone}
        ><MoveBody m={m} p={p} /></Sheet>
      )}
    </>
  )
}

// ── The move flow ─────────────────────────────────────────────────────────────
//
// ── WHY THE TWO DIRECTIONS DO NOT LOOK ALIKE ─────────────────────────────────
//
// Shield is routine and reversible: unshielded value becomes shielded, and it can be unshielded
// again. Unshield is neither. It publishes an amount to a public vault where it stays readable
// forever, and no later action takes that back.
//
// So the directions are drawn differently on purpose — blue for shield, amber for unshield, an
// explicit warning above the numbers on the irreversible one, and an amber confirm button labelled
// with the act rather than with "Confirm". Colour is never the ONLY carrier: the title, the warning
// sentence and the button label each say it independently, because a colour-only signal is
// invisible to a colour-blind user and this is the one screen where that matters most.

function MoveBody({ m, p }: { m: Exclude<MoveView, { step: 'idle' }>; p: WalletModalV2Props }) {
  const isUnshield = m.dir === 'reveal'
  const accent = isUnshield ? 'var(--warn)' : 'var(--accent-400)'

  if (m.step === 'form') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 12.5, color: C.mutedDim, lineHeight: 1.5 }}>{DIR[m.dir].blurb}</div>

        <AmountCard
          dir={m.dir} value={m.amount} onChange={p.onAmountChange} onMax={p.onMax}
          maxUsed={m.maxUsed} available={m.available} hidden={p.hidden}
          leftoverNote={m.leftoverNote} error={m.error}
        />

        {/* The two figures that decide whether the amount is even allowed, stated up front rather
            than discovered by typing and being refused. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11.5, color: C.mutedDim }}>
          <span>Min {fmt6(m.minMicrotari)} XTR</span>
          <span>
            Max {p.hidden ? '••••••' : fmt6(m.maxMicrotari)} XTR{' · '}
            <span role="button" tabIndex={0} onClick={p.onMax} onKeyDown={e => e.key === 'Enter' && p.onMax()}
              style={{ color: 'var(--accent-ink)', cursor: 'pointer', fontWeight: 600 }}>Use max</span>
          </span>
        </div>

        <Button tone={m.canReview ? (isUnshield ? 'amber' : 'primary') : 'disabled'} onClick={m.canReview ? p.onReview : undefined}>
          Review
        </Button>
      </div>
    )
  }

  if (m.step === 'review') {
    const pricing = m.feeMicrotari === null
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* BEFORE THE NUMBERS AND BEFORE THE BUTTON. Someone who confirms without reading has still
            been told; someone who reads has been told first. */}
        {isUnshield && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
            borderRadius: 'var(--r-md)', background: 'rgba(var(--warn-rgb),0.12)',
            color: 'var(--warn)', fontSize: 12.5, lineHeight: 1.5,
          }}>
            <Alert size={13} color="currentColor" />
            <span>Unshielding makes funds visible on chain. This cannot be undone.</span>
          </div>
        )}

        <DetailCard>
          <DetailRow label="Amount" value={XTR(m.amountMicrotari)} valueColor={C.bright} />
          <DetailRow label="Direction" value={`${DIR[m.dir].from} to ${DIR[m.dir].to}`} valueColor={C.bodyDim} />
          <FeeRow fee={m.feeMicrotari === null ? null : fmt6(m.feeMicrotari)} last={!m.resulting} />
          {/* What you are left with — the figure a person actually wants before confirming. */}
          {m.resulting && <>
            <DetailRow label="Shielded after" value={XTR(m.resulting.privateAfter)} valueColor={C.body} />
            <DetailRow label="Unshielded after" value={XTR(m.resulting.publicAfter)} last />
          </>}
        </DetailCard>

        {m.leftoverNote && (
          <div style={{ fontSize: 11.5, color: C.mutedDim, lineHeight: 1.5 }}>{m.leftoverNote}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <Button tone="neutral" flex={1} onClick={p.onBack}>Back</Button>
          <Button
            tone={pricing ? 'disabled' : isUnshield ? 'amber' : 'primary'} flex={2}
            onClick={pricing ? undefined : p.onConfirm}
          >{isUnshield ? 'Unshield' : 'Shield'}</Button>
        </div>
      </div>
    )
  }

  if (m.step === 'moving') {
    return (
      <MoveStatus
        icon={<Spinner size={26} ring={3} />}
        title="Moving funds"
        sub={m.progress || 'Then settling on the Ootle. This can take a moment.'}
      />
    )
  }

  // The transaction is FINISHED. This window is the index catching up, and it says so.
  if (m.step === 'settling') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <MoveStatus
          ring={{ bg: 'rgba(var(--positive-rgb),0.12)', ink: C.positive }}
          icon={<Check size={16} color="currentColor" />}
          title={DIR[m.dir].done}
          sub={`${fmt6(m.amountMicrotari)} XTR ${DIR[m.dir].pastTense}. Your balances update in about a minute.`}
        />
        <SettleBar caption="Updating balances — the move itself is finished." />
        <TxRow txId={m.txId} onCopy={() => p.onCopyTx(m.txId)} />
        <Button tone="neutral" onClick={p.onDone}>Done</Button>
      </div>
    )
  }

  if (m.step === 'success') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <MoveStatus
          ring={{ bg: 'rgba(var(--positive-rgb),0.12)', ink: C.positive }}
          icon={<Check size={16} color="currentColor" />}
          title={DIR[m.dir].done}
          sub={m.lagged
            // A PASSED DEADLINE IS STILL A SUCCESS. The transaction committed; only the index is
            // behind, and telling someone their funds did not move when they demonstrably did is
            // the worst outcome available here.
            ? `${fmt6(m.amountMicrotari)} XTR ${DIR[m.dir].pastTense}. Confirmed on the network — your balances haven’t caught up yet, so tap Refresh in a moment. Nothing is at risk.`
            : `${fmt6(m.amountMicrotari)} XTR ${DIR[m.dir].pastTense}.`}
        />
        {m.resulting && (
          <DetailCard>
            <DetailRow label="Shielded" value={XTR(m.resulting.privateAfter)} valueColor={C.body} />
            <DetailRow label="Unshielded" value={XTR(m.resulting.publicAfter)} last />
          </DetailCard>
        )}
        <TxRow txId={m.txId} onCopy={() => p.onCopyTx(m.txId)} />
        <Button tone="primary" onClick={p.onDone}>Done</Button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MoveStatus
        ring={{ bg: 'rgba(var(--danger-rgb),0.12)', ink: C.danger }}
        icon={<Alert size={16} color="currentColor" />}
        title="Something went wrong"
        sub="Your funds are untouched."
      />
      <VerbatimBox>{m.message}</VerbatimBox>
      {m.txId && <TxRow txId={m.txId} onCopy={() => p.onCopyTx(m.txId!)} />}
      <div style={{ display: 'flex', gap: 10 }}>
        <Button tone="neutral" flex={1} onClick={p.onDone}>Close</Button>
        <Button tone={accent === 'var(--warn)' ? 'amber' : 'primary'} flex={2} onClick={p.onRetryMove}>Try again</Button>
      </div>
    </div>
  )
}

/** The centred icon-over-title block the design uses for every move outcome. */
function MoveStatus({ ring, icon, title, sub }: {
  ring?: { bg: string; ink: string }; icon: ReactNode; title: string; sub: string
}) {
  return (
    <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 34, height: 34, borderRadius: 'var(--r-pill)',
        background: ring?.bg ?? 'transparent', color: ring?.ink ?? 'inherit',
      }}>{icon}</span>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.primary, marginTop: 12 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 3, lineHeight: 1.5 }}>{sub}</div>
    </div>
  )
}
