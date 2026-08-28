// The combined balance — the vault.
//
// THE HIERARCHY THIS ESTABLISHES. The total is the hero; shielded and unshielded become the
// breakdown beneath it. The first question is "how much do I have", and the second is "how much of
// it is visible".
//
// WHAT THE BREAKDOWN IS FOR, beyond detail. When the total cannot be shown, the two cards below are
// the ONLY thing telling the user which half is the problem. A missing total with no breakdown is a
// dead end; one above "shielded 348.86 / unshielded unavailable" is diagnosable at a glance. So the
// breakdown renders in EVERY state, including the ones where the total cannot.
//
// ── WHY THIS IS AN ALWAYS-DARK ISLAND ────────────────────────────────────────
//
// The foundation keeps the balance hero and the nav on navy 900–950 in BOTH themes. So this card
// carries data-theme="dark" and its contents resolve the dark ramp regardless of the page around
// it — white stays legible, the hairline stays navy, and the amber "Unavailable" pill stays the
// light amber that reads on navy rather than the dark ochre that reads on white.
//
// That is why nothing in here is a literal. Hardcoding the dark values would render identically
// today and rot silently the moment a token moves; the island declares its context once and then
// uses ordinary role tokens like everywhere else.

import { C, MONO } from './tokens'
import { ArrowIn, ArrowOut, Eye, Shield, Spinner } from './icons'
import { MASK_SHORT, fmt6 } from './format'
import { unreadableReasonText, type TotalView } from './total'
import type { BalanceView } from './balances'

const cardStyle = {
  background: 'var(--vault-card)',
  borderRadius: 11,
  padding: '12px 14px',
} as const

const num = { fontWeight: 600, color: C.bright, fontFeatureSettings: "'tnum'" } as const

/**
 * One side of the breakdown.
 *
 * ── THE TWO SIDES ARE NOT COLOUR-CODED ──────────────────────────────────────
 *
 * Shielded used to be teal and unshielded neutral, so colour alone carried the distinction. The
 * foundation is explicit that it must not: "Private vs public is icon + label, never color." Both
 * cards share one ground, one label colour and one value colour; the lock-vs-eye icon plus the word
 * Shielded/Unshielded is what tells them apart. A deliberate trade — colour is the faster read —
 * and the right one for a wallet: a colour-only signal is invisible to a colour-blind user and
 * unreadable in a screenshot, on the one distinction the product is about.
 */
function BreakdownCard({ kind, balance, hidden }: {
  kind: 'shielded' | 'unshielded'; balance: BalanceView; hidden: boolean
}) {
  const Icon = kind === 'shielded' ? Shield : Eye

  const value = () => {
    if (hidden) {
      return <div style={{ fontFamily: MONO, fontSize: 13, color: C.bright, marginTop: 5 }}>{MASK_SHORT}</div>
    }
    if (balance.status === 'loading') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7 }}>
          <Spinner size={12} /><span style={{ fontSize: 12.5, color: 'var(--vault-label)' }}>Checking</span>
        </div>
      )
    }
    // NEVER A ZERO. `unavailable` means the read failed, not that the balance is nothing, and the
    // two are a world apart to someone looking at their own money.
    if (balance.status === 'unavailable') {
      return (
        <div style={{ marginTop: 6 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
            borderRadius: 'var(--r-pill)', background: 'rgba(var(--warn-rgb),0.12)',
            color: 'var(--warn)', fontSize: 11, fontWeight: 600,
          }}>Unavailable</span>
        </div>
      )
    }
    return (
      <div style={{ ...num, fontSize: 16, marginTop: 5 }}>
        {fmt6(balance.microtari)}
        <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--accent-300)', marginLeft: 5 }}>XTR</span>
      </div>
    )
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon size={11} color="var(--vault-label)" />
        <span style={{ fontSize: 11.5, fontWeight: 500, color: C.bodyDim }}>
          {kind === 'shielded' ? 'Shielded' : 'Unshielded'}
        </span>
      </div>
      {value()}
    </div>
  )
}

export function TotalHero({ total, privateBalance, publicBalance, hidden, onRetry, onSend, onReceive }: {
  total: TotalView
  /** The SHIELDED balance. The prop keeps the name of the state it is derived from. */
  privateBalance: BalanceView
  /** The UNSHIELDED balance. */
  publicBalance: BalanceView
  hidden: boolean
  /** Offered on `unreadable` — the one state where waiting will not fix it. */
  onRetry?: () => void
  /** The two primary actions. Omitted where the hero is shown without them (the preview gallery). */
  onSend?: () => void
  onReceive?: () => void
}) {
  const headline = () => {
    if (hidden) {
      return <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 500, color: C.bright, marginTop: 8 }}>{MASK_SHORT}</div>
    }
    switch (total.status) {
      case 'ready':
        return (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ ...num, fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.05 }}>
              {fmt6(total.microtari)}
            </span>
            <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--accent-300)' }}>XTR</span>
          </div>
        )
      // NO NUMBER while settling — deliberately not even a faded one. The balances are
      // mid-transition, so any figure here is arithmetic across two different moments, which is how
      // a confident 1100.207422 once appeared directly above the words "updating after your move".
      case 'settling':
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 12 }}>
            <Spinner size={15} ring={2} />
            <span style={{ fontSize: 13.5, color: C.bodyDim }}>Settling, this can take a moment</span>
          </div>
        )
      case 'loading':
        // A skeleton, not a zero and not a dash: nothing is wrong, we simply have no reading yet.
        return <div style={{ width: 150, height: 30, borderRadius: 8, background: 'var(--vault-card)', marginTop: 10 }} />
      case 'unreadable':
        return (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: C.primary }}>Balance unreadable right now</div>
            <div style={{ fontSize: 12.5, color: 'var(--vault-label)', marginTop: 3, lineHeight: 1.5 }}>
              {unreadableReasonText(total.reason)}
              {onRetry && <>{' '}<span
                role="button" tabIndex={0} onClick={onRetry}
                onKeyDown={e => e.key === 'Enter' && onRetry()}
                style={{ color: 'var(--accent-300)', cursor: 'pointer', fontWeight: 600 }}
              >Retry</span></>}
            </div>
          </div>
        )
    }
  }

  // Said once, under the breakdown, when a side is the reason the total is missing. The cards above
  // show WHICH half failed; this line says what that costs.
  const unreadableSide =
    !hidden && total.status === 'unreadable' && privateBalance.status === 'unavailable' ? 'shielded'
    : !hidden && total.status === 'unreadable' && publicBalance.status === 'unavailable' ? 'unshielded'
    : null

  return (
    <div data-theme="dark" style={{
      background: 'var(--nav-ground)', border: '1px solid var(--border)',
      borderRadius: 18, padding: 24,
    }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--vault-label)' }}>Total balance</span>

      {headline()}

      {/* Always rendered — when the total cannot be shown, this is the only thing that says why. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 18 }}>
        <BreakdownCard kind="shielded" balance={privateBalance} hidden={hidden} />
        <BreakdownCard kind="unshielded" balance={publicBalance} hidden={hidden} />
      </div>

      {unreadableSide && (
        <div style={{ fontSize: 11.5, color: 'var(--vault-label)', marginTop: 10, lineHeight: 1.5 }}>
          The {unreadableSide} half could not be read, so the total is not shown.
        </div>
      )}

      {/* The two primary actions live ON the vault, per the design. They stay enabled through every
          balance state: a read that failed says nothing about whether a payment can be built, and
          the send form does its own checking with far better reasons than this card could give. */}
      {(onSend || onReceive) && (
        <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
          {onSend && <VaultAction tone="primary" icon={<ArrowOut color="currentColor" />} label="Send" onClick={onSend} />}
          {onReceive && <VaultAction tone="quiet" icon={<ArrowIn color="currentColor" />} label="Receive" onClick={onReceive} />}
        </div>
      )}
    </div>
  )
}

/** A button on the vault: accent for the primary action, the vault's own card colour for the rest. */
function VaultAction({ tone, icon, label, onClick }: {
  tone: 'primary' | 'quiet'; icon: React.ReactNode; label: string; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="cv-vault-action"
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        padding: '10px 6px', borderRadius: 9, border: 'none', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
        background: tone === 'primary' ? 'var(--accent-400)' : 'var(--vault-card)',
        color: '#FFFFFF',
      }}
    >{icon}{label}</button>
  )
}

/** The service rail's and the chat pill's figure, as one string. Same rules, no layout. */
export function totalPillValue(total: TotalView, hidden: boolean): string {
  if (hidden) return '••••'
  switch (total.status) {
    case 'ready': return fmt6(total.microtari)
    case 'settling': return '···'   // No number mid-transition — same rule as the hero.
    case 'loading': return '···'
    case 'unreadable': return '—'
  }
}
