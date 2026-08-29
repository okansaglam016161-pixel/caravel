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
import ThemeToggle from '../../primitives/ThemeToggle'
import { C } from './tokens'
import { Alert, Check, Eye, EyeOff, Refresh, Spinner } from './icons'
import {
  Body, Button, DetailCard, DetailRow, FeeRow, HeaderIcon, ModalShell, RootHeader, ScanLine,
  SettleBar, Sheet, TxRow, type Chrome, type ScanSummary,
} from './primitives'
import {
  ActivityPanel, ReceivePanel, RecentActivity, SectionHead, SendPanel, VerbatimBox,
  type SendPanelProps,
} from './panels'
import { AssetDetail } from './AssetDetail'
import { AssetsPanel } from './assets'
import { PrivacyCard } from './PrivacyCard'
import type { BalanceView } from './balances'
import { TotalHero } from './TotalHero'
import type { TotalView } from './total'
import {
  AmountCard, DIR, InFlightBanner,
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
 * There is no tab bar any more.
 *
 * The wallet page is ONE vertical scroll — balance, moves, assets, recent activity, extras — and
 * everything deeper opens over it. `tab` survives as the name of whichever sheet is up, which is
 * why the existing transitions still work untouched: "View in Activity" from an unconfirmed send
 * still sets 'activity', and now that opens the full list rather than switching a tab.
 */
const SHEET_TABS = ['send', 'receive', 'activity'] as const satisfies readonly WalletTab[]
void SHEET_TABS // documentation of the set; the branches below name each member directly.

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
  /** Opens the asset detail page. The assets row is inert while this is unset. */
  onOpenAsset?: () => void
  /** True while the asset page is the root view. Sheets still open over it. */
  assetOpen?: boolean
  /** Back to the wallet. */
  onCloseAsset?: () => void

  // ── The areas beyond the balance card. Omit one and its tab renders nothing. ──
  tab?: WalletTab
  onTab?: (t: WalletTab) => void
  /**
   * Rendered at the foot of Overview — the app's own stateful cards.
   *
   * NODES, NOT DATA. The faucet owns a claim/cooldown/settle machine, so it is passed
   * already-rendered rather than described here. The `faucet` and `ons` DATA props that used to
   * duplicate this slot are gone: the app passed `faucet={undefined}`, and they were dead render
   * branches. The preview harness drives this slot the same way the app does.
   *
   * The @name card left the overview in V3 and lives on the Name page, so today this holds the
   * faucet alone.
   */
  overviewExtras?: ReactNode
  send?: SendPanelProps
  receive?: { address: string | null; copied: boolean; onCopy: () => void }
  /**
   * Pre-rendered rows, NEWEST FIRST.
   *
   * An array rather than a node so the page can take the first three without reaching into
   * children. They arrive pre-rendered because an inbound row resolves its own amount through a
   * hook, which has to happen per row and cannot be lifted into a data shape.
   */
  activity?: ReactNode[]
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
  //
  // The asset page is a root view TOO, swapped in here rather than layered over — it is a place you
  // navigate to and come back from, not something you do to the wallet. Every sheet below opens
  // over it identically, which is what lets it reuse the flows rather than restate them.
  const showAsset = !!p.assetOpen && !!p.onCloseAsset

  const root = (
      <ModalShell chrome={p.chrome}>
        {/* ── THE TOP-RIGHT CLUSTER ──
            The network chip, then three boxed controls sharing one geometry (primitives/iconBox):
            hide-balance, refresh, theme. They belong together because they are the same kind of
            thing — none of them moves money, all of them change what you are looking at. Refresh
            joined them when the scan card was demoted to a line. */}
        <RootHeader chip={p.networkChip} chrome={p.chrome} right={<>
          <HeaderIcon
            label={p.hidden ? 'Show balances' : 'Hide balances'}
            onClick={p.onToggleHidden}
            // The only departure from the shared box: the EMBLEM takes the accent while balances
            // are masked. The box stays identical so the row still reads as one control repeated,
            // but a hidden balance is a state worth seeing from across the screen.
            tint={p.hidden ? 'var(--accent-400)' : undefined}
          >{p.hidden ? <EyeOff size={15} color="currentColor" /> : <Eye size={15} color="currentColor" />}</HeaderIcon>
          <HeaderIcon label="Refresh balances" onClick={p.onRefresh} busy={p.refreshing}>
            <Refresh color="currentColor" />
          </HeaderIcon>
          {/* Theme, beside the eye — the two view controls the wallet has, together. The SAME
              component the landing page's top bar uses, sized to match.
              PAGE ONLY: the in-chat wallet sits inside a subtree pinned dark until chat is
              reskinned, so a toggle there would change the app theme while the screen holding it
              stayed dark — a control that visibly does nothing. */}
          {p.chrome === 'page' && <ThemeToggle size={30} />}
          {p.onClose && <HeaderIcon label="Close" onClick={p.onClose}>✕</HeaderIcon>}
        </>} />
        <Body gap={14} chrome={p.chrome}>
          {showAsset ? (
            <AssetDetail
              privateBalance={p.privateBalance} publicBalance={p.publicBalance}
              total={p.total} hidden={p.hidden} entries={p.entries}
              activity={p.activity ?? []}
              onBack={p.onCloseAsset!}
              onSend={() => p.onTab?.('send')}
              onReceive={() => p.onTab?.('receive')}
              onViewAllActivity={() => p.onTab?.('activity')}
            />
          ) : (
          <>
            {p.inFlightText && <InFlightBanner text={p.inFlightText} />}
            <TotalHero
              total={p.total} privateBalance={p.privateBalance} publicBalance={p.publicBalance}
              hidden={p.hidden} onRetry={p.onRetryBalance}
              onSend={p.send && p.onTab ? () => p.onTab!('send') : undefined}
              onReceive={p.receive && p.onTab ? () => p.onTab!('receive') : undefined}
            />
            {/* The literal scan figures, as a caption to the number above them. The Refresh press
                is acknowledged by the header icon, which spins — see ScanLine. */}
            {p.scanSummary && <ScanLine scan={p.scanSummary} refreshing={p.refreshing} />}
            {/* The composition, and the two controls that change it. This card also inherits the
                hero's old breakdown duty — when the total cannot be shown, it is the only thing on
                screen saying which half is the reason. See PrivacyCard. */}
            <PrivacyCard
              privateBalance={p.privateBalance} publicBalance={p.publicBalance}
              total={p.total} hidden={p.hidden}
              entries={p.entries} lockedText={p.lockedText} lockedIsFlight={p.lockedIsFlight}
            />
            {/* The portfolio. One real asset today — see assets.tsx for why that is a presentation
                and not a model. */}
            <SectionHead title="Assets" />
            <AssetsPanel total={p.total} hidden={p.hidden} onOpen={p.onOpenAsset} />
            {p.activity && p.onTab && (
              <RecentActivity rows={p.activity} onViewAll={() => p.onTab!('activity')} />
            )}
            {p.overviewExtras && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, alignItems: 'start' }}>
                {p.overviewExtras}
              </div>
            )}
          </>
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
          bare
          dismissable={p.send.view.step !== 'sending'}
          onClose={() => { p.send!.onDone(); p.onTab?.('overview') }}
        >
          {/* `onClose` is handed DOWN rather than drawn by the sheet: the V3 form and review frames
              put the ✕ inside the card, and the five outcome frames have none at all. The panel is
              the only thing that knows which state it is in.
              It is withheld while sending — the same fact that makes the sheet undismissable. */}
          <SendPanel
            {...p.send}
            onClose={p.send.view.step === 'sending' ? undefined : () => { p.send!.onDone(); p.onTab?.('overview') }}
          />
        </Sheet>
      )}
      {tab === 'receive' && p.receive && (
        // `bare` for the same reason Send is: the V3 receive frames put the title inside the card
        // at 21px with its own close box. Nothing here is ever mid-flight, so the ✕ is always
        // offered and the sheet stays dismissable throughout.
        <Sheet title="Receive" bare onClose={() => p.onTab?.('overview')}>
          <ReceivePanel {...p.receive} onClose={() => p.onTab?.('overview')} />
        </Sheet>
      )}
      {tab === 'activity' && (
        <Sheet title="Activity" onClose={() => p.onTab?.('overview')}>
          <ActivityPanel rows={p.activity ?? []} />
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
