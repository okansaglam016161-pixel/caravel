//   The wallet, as a still — drawn by the REAL V3 components over mock props.
//
//   ── WHY THIS IS NOT HAND-DRAWN ───────────────────────────────────────────────
//
//   The landing page used to approximate the wallet in its own markup, and the approximation went
//   stale twice: it was still drawing the pre-V3 layout — a two-card Shielded/Unshielded breakdown
//   that had been DELETED from the app, no Privacy card at all, an assets row with two features
//   that no longer exist — months after the wallet had moved on. A picture nobody compiles is a
//   picture nobody notices rotting.
//
//   So it renders the actual components now. The three below own no state, call no hooks, touch no
//   context and do no arithmetic beyond formatting; `computeTotal` is a pure function over a plain
//   record. There is no wallet here, no key, no network — the same arrangement src/dev/WalletPreview
//   has run on since M4, which is the in-repo proof that these run on literals alone.
//
//   WHAT IT BUYS: tsc is the drift alarm. If TotalView, BalanceView or EntryProps move, this file
//   fails to build instead of quietly misdescribing the product to everyone who visits.
//
//   WHAT IT COSTS: the landing page now depends on wallet/v2 types. That is the same fact stated
//   from the other side, and it is the trade this file exists to make.
//
//   ── EVERYTHING IS INERT ──────────────────────────────────────────────────────
//
//   The components are given real handlers so they render exactly as the app draws them — the hero
//   keeps its Send and Receive, the assets row keeps its chevron, "Make public" keeps its full
//   weight rather than the greyed-out treatment a missing handler would give it. The handlers do
//   nothing, and `inert` on the wrapper is what makes that safe: it takes the whole subtree out of
//   the tab order, out of pointer events, and out of the accessibility tree.
//
//   THE A11Y REMOVAL IS DELIBERATE, not a side effect. This is a decorative picture of a product;
//   "$340.00" and "74% private" announced to a screen reader as if they were the visitor's own
//   balance would be worse than silence. `pointerEvents: 'none'` rides along as the
//   fallback for anything too old to know `inert` — the handlers are no-ops either way.
//
//   ── THE STATE IT DEPICTS ─────────────────────────────────────────────────────
//
//   A MIXED WALLET: 625,000 XTR private and 225,000 public, summing to the 850,000 this page has
//   always priced at $340. It is the ordinary state — most wallets hold some of each — and it is
//   the only one that shows the Privacy card doing its job: a real split bar at 74%, and BOTH
//   directions live, because with funds on each side there is something to move either way.
//
//   THE HERO SAYS "Total balance" AS A CONSEQUENCE, not as a setting. TotalHero prints "Your
//   balance is private" only when that is TRUE of the balance beside it — a known total, both
//   halves read, nothing hidden and nothing public (its `allPrivate`) — and falls back to "Total
//   balance" otherwise. A public balance makes the fallback the honest branch, so the label follows
//   the figures automatically.
//
//   THE TWO ARE THEREFORE COUPLED, and that is the thing to know before editing: zeroing PUBLIC
//   below does not merely change a number, it changes what the hero SAYS. Both readings are states
//   the app can produce; what it cannot produce, and what this must never be edited into, is a
//   split bar sitting under a hero claiming the balance is entirely private.

import ThemeToggle from '../primitives/ThemeToggle'
import { iconBoxStyle } from '../primitives/iconBox'
import { AssetsPanel } from '../wallet/v2/assets'
import type { BalanceView } from '../wallet/v2/balances'
import { Eye, Refresh } from '../wallet/v2/icons'
import type { EntryProps } from '../wallet/v2/move'
import { SectionHead } from '../wallet/v2/panels'
import { Body } from '../wallet/v2/primitives'
import { PrivacyCard } from '../wallet/v2/PrivacyCard'
import { C, MONO } from '../wallet/v2/tokens'
import { TotalHero } from '../wallet/v2/TotalHero'
import { computeTotal } from '../wallet/v2/total'

// ── The figures ───────────────────────────────────────────────────────────────
//
// At the fixed testnet rate (1 XTR = $0.0004, fiat.ts): 625,000 XTR is $250.00, 225,000 is $90.00,
// and the total is the $340.00 this page has always shown. Every one of those figures is now
// DERIVED from these two bigints rather than typed beside them, so they cannot disagree — and if
// the rate ever moves, the whole page moves with it. That is the point of pricing through the
// app's own converter instead of writing dollars into the markup.

const PRIVATE = 625_000_000_000n
const PUBLIC = 225_000_000_000n

const privateBalance: BalanceView = { status: 'ready', microtari: PRIVATE }
const publicBalance: BalanceView = { status: 'ready', microtari: PUBLIC }

const total = computeTotal({
  privateBalance, publicBalance,
  privateGeneration: 1, publicGeneration: 1,
  privateIncomplete: false, settling: false, settleLagged: false,
})

/** Inert by the wrapper, not by omission — see the header note. */
const noop = () => {}

// BOTH DIRECTIONS LIVE, with no `disabledReason` between them — which is exactly what the wallet
// offers when both sides hold funds. PrivacyCard disables a button when it has a reason OR no
// handler, so these two render at full weight and the card shows no reason lines at all: the
// ordinary, unblocked state of the feature the section's copy is describing.
const entries: EntryProps[] = [
  { dir: 'conceal', onClick: noop },
  { dir: 'reveal', onClick: noop },
]

/**
 * The header cluster, hand-drawn — the one part of the wallet page that is not a component.
 *
 * RootHeader is not exported as anything a still can use: it takes its right-hand controls as a
 * node and every one of them is a live button. So the LAYOUT is reproduced here and the GEOMETRY is
 * imported — `iconBoxStyle` is the same helper the wallet's three header controls already share,
 * which is what stops this row from becoming a fourth, subtly different box.
 *
 * THE THEME TOGGLE IS THE REAL ONE. It is the only control here whose emblem depends on state — a
 * moon in light, a sun in dark — and a hand-drawn copy would be a second thing to keep in step for
 * no gain. Inert, like everything else in this subtree.
 *
 * The controls are `span`s rather than buttons: nothing focusable, even in a browser that has never
 * heard of `inert`.
 */
function StillHeader() {
  return (
    <div className="cv-lp-mockhead" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '0 0 4px', flexShrink: 0,
    }}>
      <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em', color: C.primary }}>Wallet</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Mono, quiet, amber dot — a statement of fact rather than a badge, and SENTENCE CASE.
            The old mock shouted ESMERALDA TESTNET in caps, which the wallet never did. */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border)',
          fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.08em',
          color: C.mutedDim, whiteSpace: 'nowrap',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: 'var(--r-pill)', background: C.warn }} />
          Esmeralda testnet
        </span>
        <span style={iconBoxStyle(30)}><Eye size={15} color="currentColor" /></span>
        <span style={iconBoxStyle(30)}><Refresh size={14} color="currentColor" /></span>
        <ThemeToggle size={30} />
      </div>
    </div>
  )
}

/**
 * @param compact  Drops the header and the assets block — the services showcase, where this sits in
 *                 a ~454px grid column beside a paragraph and the full stack would tower over it.
 *                 The hero and the Privacy card are the two that carry the private/public story
 *                 that section's copy is about.
 */
export default function WalletStill({ compact = false }: { compact?: boolean }) {
  return (
    <div inert style={{ pointerEvents: 'none' }}>
      {!compact && <StillHeader />}
      {/* The app's own column: gap and padding come from the same component the wallet page uses,
          at the same `chrome` and the same gap WalletModalV2 passes. */}
      <Body gap={14} chrome="page">
        <TotalHero
          total={total} privateBalance={privateBalance} publicBalance={publicBalance}
          hidden={false} onSend={noop} onReceive={noop}
        />
        <PrivacyCard
          privateBalance={privateBalance} publicBalance={publicBalance}
          total={total} hidden={false} entries={entries}
        />
        {!compact && (
          <>
            <SectionHead title="Assets" />
            <AssetsPanel total={total} hidden={false} onOpen={noop} />
          </>
        )}
      </Body>
    </div>
  )
}
