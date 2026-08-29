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
import { Check, Copy, Eye, EyeOff, Lock, Refresh, Spinner } from './icons'
import {
  Body, HeaderIcon, ModalShell, RootHeader, ScanLine, Sheet, type Chrome, type ScanSummary,
} from './primitives'
import {
  ActionButton, ActivityPanel, AmountBlock, CARD, Emblem, OUTCOME_CARD, Outcome, ReceivePanel,
  RecentActivity, SectionHead, SendPanel, SheetHeader, VerbatimBox, type SendPanelProps,
} from './panels'
import { AssetDetail } from './AssetDetail'
import { AssetsPanel } from './assets'
import { PrivacyCard } from './PrivacyCard'
import type { BalanceView } from './balances'
import { TotalHero } from './TotalHero'
import type { TotalView } from './total'
import { InFlightBanner, type EntryProps } from './move'
import {
  DIR, moveAvailLabel, moveBlurb, moveDirectionRow, moveDone, moveMovedTo, moveMovingTo, moveTitle,
  type Dir,
} from './moveCopy'
import { MASK_SHORT, fmt6 } from './format'
import { MONO } from './tokens'

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
  /**
   * NO `resulting` HERE, DELIBERATELY — and the field is absent rather than optional.
   *
   * A success card once showed a predicted post-move split, computed as `live balance + the move's
   * delta`. That is correct at REVIEW, where the balances are still pre-move. It is wrong on this
   * step: `settling` does not end until both sides have actually moved, so by the time success
   * renders the balances already contain the move and adding the delta counts it twice. The card
   * read `private 1,678.586190 · public 280.984345` over a wallet holding `1,668.600647 /
   * 290.984345` — a confident figure, off by exactly one move.
   *
   * It was also inverted by failure: on the `lagged` branch the balances have NOT caught up, so
   * the same arithmetic came out right. Wrong when everything worked, right when the index fell
   * behind.
   *
   * Removing the FIELD rather than the render makes it unrepresentable, the same way TotalView's
   * settling variant carries no microtari. There is no way to put a predicted balance on this card
   * without changing this type, which is the point.
   *
   * THE REAL SPLIT IS ONE LAYER DOWN. The overview behind this sheet reads the settled balance
   * from the same source the card was guessing at, so nothing is lost by not restating it here.
   */
  | {
      step: 'success'; dir: Dir; amountMicrotari: bigint; txId: string
      /** The settle deadline passed. STILL A SUCCESS — different copy, same shape. */
      lagged: boolean
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
        // `bare` like Send and Receive: the V3 move frames put the title inside the card at 21px
        // with its own close box. `dismissable` is false while MOVING — nothing here can call a
        // broadcast back, so a close control would misdescribe what it does; the sheet reopens to
        // the outcome instead. `onClose` is withheld from the panel for the same reason.
        <Sheet
          title={moveTitle(m.dir)}
          bare
          dismissable={m.step !== 'moving'}
          onClose={p.onDone}
        ><MoveBody m={m} p={p} onClose={m.step === 'moving' ? undefined : p.onDone} /></Sheet>
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

/**
 * Both directions of the move flow — V3 frames 4a–4f (make private) and 5a–5f (make public).
 *
 * ── ONE COMPONENT, TWO SERIES, AND WHY THAT IS SAFE ──────────────────────────
 *
 * The frames are drawn as two independent series and they are IDENTICAL in every visual respect:
 * same card, same accent, same spinner, same emblems. Nothing about make-public is styled as a
 * caution any more. The only thing that varies is the words, and every word comes from moveCopy —
 * derived from a single {from, to} pair, so there is no branch here that could put one direction's
 * copy on the other's screen. See moveCopy.ts for why the table is two words long.
 *
 * ── THE OLD BUG, AND WHERE IT CANNOT COME BACK ───────────────────────────────
 *
 * The success headline reads `moveDone(m.dir)`. `m.dir` is the direction carried on the VIEW — the
 * move that was prepared and submitted — not a component-level notion of which button was pressed.
 * The header, the confirm button, the direction row and the confirmation all read the same value,
 * so they agree by construction rather than by review.
 *
 * ── MAKE PUBLIC IS NOT A WARNING ─────────────────────────────────────────────
 *
 * It used to carry amber from the amount field through to the confirm button, plus a bordered
 * alert. That framing treated a legitimate choice as a near-miss: you cannot pay an exchange from
 * a private balance, and the user has already chosen this from a card offering both directions
 * equal weight. The disclosure survives as a plain sentence on review, above the confirm button.
 */
function MoveBody({ m, p, onClose }: {
  m: Exclude<MoveView, { step: 'idle' }>
  p: WalletModalV2Props
  onClose?: () => void
}) {
  // ══ 4a / 5a · FORM ═════════════════════════════════════════════════════════
  if (m.step === 'form') {
    return (
      <div style={CARD}>
        <SheetHeader title={moveTitle(m.dir)} onClose={onClose} />
        <div style={{ fontSize: 13, color: C.mutedDim, marginTop: 6 }}>{moveBlurb(m.dir)}</div>

        <AmountBlock
          mt={28}
          value={p.hidden ? MASK_SHORT : m.amount}
          onChange={p.onAmountChange}
          readOnly={p.hidden}
          onMax={p.onMax}
          availableLabel={p.hidden ? 'Available' : moveAvailLabel(m.dir)}
          availableValue={p.hidden ? MASK_SHORT : m.available !== null ? `${fmt6(m.available)} XTR` : '—'}
          error={m.error}
          // THE REMAINDER, WHEN THERE IS ONE. Set only where MAX genuinely held something back for
          // the fee, and it names the figure. The floor takes the slot otherwise: the builder
          // enforces a minimum, and being told it beats typing under it and being refused.
          note={m.leftoverNote ?? `Minimum ${fmt6(m.minMicrotari)} XTR`}
        />

        <ActionButton mt={28} tone={m.canReview ? 'primary' : 'disabled'} onClick={m.canReview ? p.onReview : undefined}>
          Review
        </ActionButton>
      </div>
    )
  }

  // ══ 4b / 5b · REVIEW ═══════════════════════════════════════════════════════
  if (m.step === 'review') {
    const pricing = m.feeMicrotari === null
    return (
      <div style={CARD}>
        <SheetHeader title="Review" onClose={onClose} />

        <div style={{ textAlign: 'center', marginTop: 28 }}>
          <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em', fontFeatureSettings: "'tnum'", color: C.primary }}>
            {fmt6(m.amountMicrotari)} <span style={{ fontSize: 16, fontWeight: 600, color: C.mutedDim }}>XTR</span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5, color: C.bodyDim, marginTop: 8 }}>
            <MoveSide word={DIR[m.dir].from} />
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.mutedDim} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <MoveSide word={DIR[m.dir].to} />
          </div>
        </div>

        <div style={{
          display: 'flex', flexDirection: 'column', gap: 11, fontSize: 13.5,
          marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)',
        }}>
          <MoveRow label="Direction" value={moveDirectionRow(m.dir)} />
          <MoveRow label="Network fee" mono value={pricing
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit', color: C.faint }}><Spinner size={12} />Pricing…</span>
            : `${fmt6(m.feeMicrotari!)} XTR`} />
          {/* WHAT YOU ARE LEFT WITH. The frames stop at the fee; this is the figure a person
              actually wants before confirming, and it is the only thing on the screen that answers
              "and then what do I have". Drawn as two more rows in the same block, so it costs the
              layout nothing. */}
          {m.resulting && <>
            <MoveRow label="Private after" mono value={`${fmt6(m.resulting.privateAfter)} XTR`} />
            <MoveRow label="Public after" mono value={`${fmt6(m.resulting.publicAfter)} XTR`} />
          </>}
        </div>

        {/* CALM AND FACTUAL, above the confirm button. Someone who confirms without reading has
            still been told; someone who reads has been told first. It is a plain muted sentence
            rather than the amber alert this screen used to carry — the fact has not changed, only
            the claim that it is a mistake. */}
        {m.dir === 'reveal' && (
          <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 12, textAlign: 'center' }}>
            Public funds are visible on chain.
          </div>
        )}

        {m.leftoverNote && (
          <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>
            {m.leftoverNote}
          </div>
        )}

        <ActionButton mt={m.dir === 'reveal' || m.leftoverNote ? 16 : 20} tone={pricing ? 'disabled' : 'primary'} onClick={pricing ? undefined : p.onConfirm}>
          {moveTitle(m.dir)}
        </ActionButton>
        <ActionButton mt={8} tone="quiet" onClick={p.onBack}>Back</ActionButton>
      </div>
    )
  }

  // ══ 4c / 5c · MOVING ═══════════════════════════════════════════════════════
  //
  // The one state the sheet will not close over. Nothing here can call a broadcast back, so no
  // close control is offered — see the Sheet's `dismissable`.
  if (m.step === 'moving') {
    return (
      <div style={OUTCOME_CARD}>
        <Spinner size={28} ring={3} />
        <div style={{ fontSize: 17, fontWeight: 600, color: C.primary, marginTop: 18 }}>Moving funds</div>
        <div style={{ fontSize: 13, color: C.mutedDim, marginTop: 6 }}>
          {fmt6(m.amountMicrotari)} XTR {moveMovingTo(m.dir)}
        </div>
        {m.progress && (
          <div style={{ fontSize: 12, color: C.faint, marginTop: 14, lineHeight: 1.5 }}>{m.progress}</div>
        )}
      </div>
    )
  }

  // ══ 4d / 5d · SETTLING ═════════════════════════════════════════════════════
  //
  // NO AMOUNT, NO FEE, NO TX — a spinner and a caption, and that is the whole frame.
  //
  // The move is FINISHED; what is behind is the index. Same window and same rule as the send flow
  // and the balance hero: the screen says what is happening and stops. Every figure reappears on
  // the success card one state later, which is where the move is actually reported.
  if (m.step === 'settling') {
    return (
      <div style={OUTCOME_CARD}>
        <Spinner size={28} ring={3} />
        <div style={{ fontSize: 17, fontWeight: 600, color: C.primary, marginTop: 18 }}>Settling</div>
        <div style={{ fontSize: 13, color: C.mutedDim, marginTop: 6 }}>This can take a moment.</div>
      </div>
    )
  }

  // ══ 4e / 5e · SUCCESS ══════════════════════════════════════════════════════
  if (m.step === 'success') {
    return (
      <Outcome
        emblem={<Emblem tone="positive"><Check size={18} color="currentColor" /></Emblem>}
        // THE STRING THE OLD BUG GOT WRONG — derived from the direction of the move that ran.
        title={moveDone(m.dir)}
        sub={<>
          <span style={{ fontFamily: MONO }}>{fmt6(m.amountMicrotari)} XTR</span> {moveMovedTo(m.dir)}
          {/* A PASSED DEADLINE IS STILL A SUCCESS. The transaction committed; only the index is
              behind, and telling someone their funds did not move when they demonstrably did is
              the worst outcome available here. */}
          {m.lagged && <><br />Confirmed on the network — your balances haven’t caught up yet. Nothing is at risk.</>}
        </>}
      >
        {/* NO BALANCE SPLIT. See the success variant of MoveView — this card confirms what
            happened; the overview behind it states what you now hold. */}
        {/* The move's one identifier. The frames omit it; it stays, because a settled transaction
            with no id is one the user cannot look up or report. */}
        <MoveTx txId={m.txId} onCopy={() => p.onCopyTx(m.txId)} />
        <ActionButton mt={24} tone="quiet" onClick={p.onDone}>Done</ActionButton>
      </Outcome>
    )
  }

  // ══ 4f / 5f · ERROR ════════════════════════════════════════════════════════
  return (
    <Outcome
      emblem={<Emblem tone="danger">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </Emblem>}
      title="Something went wrong"
      sub="Your funds are untouched."
    >
      {/* THE NETWORK'S OWN WORDS, VERBATIM. The frame does not draw this and it stays anyway: a
          paraphrased error is unreportable, and the headline alone gives nobody anything to paste
          into an issue. */}
      <div style={{ marginTop: 18, textAlign: 'left' }}>
        <VerbatimBox>{m.message}</VerbatimBox>
      </div>
      {m.txId && <MoveTx txId={m.txId} onCopy={() => p.onCopyTx(m.txId!)} />}
      <ActionButton mt={16} tone="primary" onClick={p.onRetryMove}>Try again</ActionButton>
      <span
        role="button" tabIndex={0} onClick={p.onDone} onKeyDown={e => e.key === 'Enter' && p.onDone()}
        style={{
          display: 'block', marginTop: 12, fontSize: 12.5, fontWeight: 500,
          color: C.mutedDim, cursor: 'pointer', userSelect: 'none',
        }}
      >Close</span>
    </Outcome>
  )
}

/**
 * One end of the direction line on review.
 *
 * THE LOCK MARKS THE PRIVATE SIDE, whichever end it is on — so make-private reads
 * `public → 🔒 private` and make-public reads `🔒 private → public`. The emphasis follows the
 * balance, not the direction of travel, which is what lets a glance at the arrow answer "which way
 * am I going" without reading either word.
 */
function MoveSide({ word }: { word: 'private' | 'public' }) {
  if (word !== 'private') return <span>{word}</span>
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600, color: C.primary }}>
      <Lock size={11} color="var(--accent-ink)" />private
    </span>
  )
}

/** A review row: muted label, value on the right. */
function MoveRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: C.mutedDim }}>{label}</span>
      <span style={{ fontWeight: 500, color: C.primary, ...(mono ? { fontFamily: MONO } : {}) }}>{value}</span>
    </div>
  )
}

/** The transaction id, copyable, in the same quiet register as the send receipt. */
function MoveTx({ txId, onCopy }: { txId: string; onCopy: () => void }) {
  const short = txId.length > 14 ? `${txId.slice(0, 6)}…${txId.slice(-6)}` : txId
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
      <span
        role="button" tabIndex={0} onClick={onCopy} onKeyDown={e => e.key === 'Enter' && onCopy()}
        aria-label="Copy transaction id"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 11, color: C.faint, cursor: 'pointer' }}
      >tx {short}<Copy size={11} color="currentColor" /></span>
    </div>
  )
}
