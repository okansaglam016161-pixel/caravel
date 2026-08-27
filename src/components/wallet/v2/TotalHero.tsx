// The combined balance, as the modal's headline.
//
// THE HIERARCHY THIS ESTABLISHES. The total is the hero; private and public become the breakdown
// beneath it. That is a deliberate reversal of the v2 design's original argument (private as hero,
// public as a quiet exception) and it is the right one once value can move both ways: the first
// question is "how much do I have", and the second is "how much of it is visible".
//
// WHAT THE BREAKDOWN IS FOR, beyond detail. When the total degrades to `—`, the two rows below are
// the ONLY thing telling the user which half is the problem. A dash with no breakdown is a dead
// end; a dash above "private 348.86 / public unavailable" is diagnosable at a glance. So the
// breakdown renders in every state, including the ones where the total cannot.

import { C, MONO, warnBorder, warnFill } from './tokens'
import { Eye, Shield, Spinner } from './icons'
import { MASK, fmt6 } from './format'
import { unreadableReasonText, type TotalView } from './total'
import type { BalanceView } from './balances'

const label = { fontSize: 11, fontWeight: 700, letterSpacing: '0.16em' } as const

/**
 * One side of the breakdown. Keeps its own state — see the note above.
 *
 * ── v0.3: THE TWO SIDES ARE NOT COLOUR-CODED ────────────────────────────────
 *
 * Private used to be teal and public neutral, so colour alone carried the distinction. The
 * foundation is explicit that it must not: "Private vs public is icon + label, never color." So
 * both rows now share one ground, one label colour and one value colour, and the lock-vs-eye icon
 * plus the word PRIVATE/PUBLIC is what tells them apart. That is a deliberate trade — colour is
 * the faster read — and it is the right one for a wallet: a colour-only signal is invisible to a
 * colour-blind user and unreadable in a screenshot, on the one distinction the product is about.
 */
function BreakdownRow({ kind, balance, hidden }: {
  kind: 'private' | 'public'; balance: BalanceView; hidden: boolean
}) {
  const isPrivate = kind === 'private'
  const Icon = isPrivate ? Shield : Eye
  const tint = C.mutedDim

  const value = () => {
    if (hidden) return <span style={{ letterSpacing: '0.1em', color: C.bodyDim }}>••••••</span>
    if (balance.status === 'loading') return <span style={{ fontSize: 12.5, color: C.faint, fontFamily: 'inherit' }}>checking…</span>
    if (balance.status === 'unavailable') {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontFamily: MONO, color: C.faintDim }}>—</span>
          <span style={{
            padding: '2px 7px', borderRadius: 999, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em',
            color: C.warn300, background: warnFill(0.08), border: warnBorder(0.3), fontFamily: 'inherit',
          }}>UNAVAILABLE</span>
        </span>
      )
    }
    return <span style={{ color: C.bright }}>{fmt6(balance.microtari)}</span>
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '11px 0', borderTop: '1px solid rgba(120,150,210,0.08)',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={12} color={tint} />
        <span style={{ ...label, fontSize: 10.5, color: C.mutedDim }}>
          {isPrivate ? 'PRIVATE' : 'PUBLIC'}
        </span>
      </span>
      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 500, textAlign: 'right' }}>{value()}</span>
    </div>
  )
}

export function TotalHero({ total, privateBalance, publicBalance, hidden }: {
  total: TotalView
  privateBalance: BalanceView
  publicBalance: BalanceView
  hidden: boolean
}) {
  // The headline, and the one line under it that says what kind of number it is.
  const headline = () => {
    if (hidden) return <span style={{ letterSpacing: '0.08em' }}>{MASK}</span>
    switch (total.status) {
      case 'ready': return fmt6(total.microtari)
      // NO NUMBER while settling. The balances are mid-transition, so any figure here is
      // arithmetic across two different moments — which is how a confident 1100.207422 once
      // appeared directly above the words "updating after your last move…". The caption below
      // carries the whole message on its own.
      case 'settling': return '···'
      case 'loading': return '···'
      case 'unreadable': return '—'
    }
  }

  const caption = () => {
    if (hidden) return <span style={{ color: C.tealLabel }}>Hidden from view · tap the eye to show</span>
    switch (total.status) {
      case 'ready':
        return <span style={{ color: C.tealLabel }}>Your balance, private and public together</span>
      case 'settling':
        // "Something IS happening and a correct number is coming on its own."
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: C.tealLabel }}>
            <Spinner size={11} />updating after your last move…
          </span>
        )
      case 'loading':
        return <span style={{ color: C.tealLabel }}>Checking your balances…</span>
      case 'unreadable':
        // "Nothing is pending. We cannot read one side, and waiting will not fix it."
        return <span style={{ color: C.warn300, lineHeight: 1.5 }}>{unreadableReasonText(total.reason)}</span>
    }
  }

  const degraded = total.status === 'unreadable' && !hidden

  return (
    <div style={{
      padding: '24px 22px 18px', borderRadius: 'var(--r-xl)',
      background: degraded ? C.disabled : C.heroGrad,
      border: degraded ? `1px dashed rgba(var(--warn-rgb),0.30)` : '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={degraded ? C.mutedDim : C.tealLabel} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="6" width="20" height="13" rx="2.5" /><path d="M2 10h20" />
        </svg>
        <span style={{ ...label, color: degraded ? C.mutedDim : C.tealLabel }}>TOTAL BALANCE</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em',
          fontFeatureSettings: "'tnum'", lineHeight: 1.05,
          color: degraded ? C.faintDim : C.bright,
        }}>{headline()}</span>
        <span style={{ fontSize: 17, fontWeight: 600, color: C.teal300 }}>TARI</span>
      </div>

      <div style={{ fontSize: 12.5, marginTop: 8, minHeight: 18 }}>{caption()}</div>

      {/* Always rendered — when the total is a dash, this is the only thing that says why. */}
      <div style={{ marginTop: 14 }}>
        <BreakdownRow kind="private" balance={privateBalance} hidden={hidden} />
        <BreakdownRow kind="public" balance={publicBalance} hidden={hidden} />
      </div>
    </div>
  )
}

/** The main-screen pill's figure, as one string. Same rules, no layout. */
export function totalPillValue(total: TotalView, hidden: boolean): string {
  if (hidden) return '••••'
  switch (total.status) {
    case 'ready': return fmt6(total.microtari)
    case 'settling': return '···'   // No number mid-transition — same rule as the hero.
    case 'loading': return '···'
    case 'unreadable': return '—'
  }
}
