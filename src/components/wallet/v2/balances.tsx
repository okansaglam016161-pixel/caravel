// The two balance cards.
//
// THE HIERARCHY IS THE ARGUMENT. Private is a teal hero with a shield; public is a quieter raised
// row with an eye. A glance tells you which state this wallet is mostly in, and which one is the
// exception. They are never summed — see the M4 report; a combined figure would invent a number the
// protocol does not have.
//
// FOUR STATES EACH, and the important pair is ZERO vs UNAVAILABLE. A zero is a real, confident
// fact. An unavailable is "we could not read it" — drawn dashed, badged, and with a retry, because
// drawing a confident 0.00 over a failed read tells someone they have nothing when they may have
// a great deal.

import { C, MONO, border, tealBorder, tealFill, warnBorder, warnFill } from './tokens'
import { Eye, Retry, Shield } from './icons'
import { MASK, MASK_SHORT, fmt6 } from './format'
import { Skeleton } from './primitives'

/** What either balance can be. Mirrors the shipped ScanState / RevealedState split exactly. */
export type BalanceView =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; microtari: bigint }

const heroCard = {
  padding: '24px 22px 20px', borderRadius: 14,
  background: C.heroGrad, border: tealBorder(0.3),
} as const

const heroCardDead = {
  padding: '24px 22px 20px', borderRadius: 14,
  background: C.disabled, border: `1px dashed rgba(255,180,60,0.3)`,
} as const

const label = { fontSize: 11, fontWeight: 700, letterSpacing: '0.16em' } as const

// ── Private hero ──────────────────────────────────────────────────────────────

export function PrivateHero({ balance, hidden, onRetry }: {
  balance: BalanceView; hidden: boolean; onRetry?: () => void
}) {
  const head = (color: string) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <Shield color={color} /><span style={{ ...label, color: color === C.teal ? C.tealLabel : C.mutedDim }}>PRIVATE</span>
    </span>
  )

  if (balance.status === 'loading') {
    return (
      <div style={heroCard}>
        <div style={{ marginBottom: 16 }}>{head(C.teal)}</div>
        <Skeleton w={220} h={30} fill={tealFill(0.1)} />
        <Skeleton w={150} h={12} fill="rgba(143,183,176,0.12)" mt={12} />
      </div>
    )
  }

  // UNAVAILABLE — an em-dash and an explicit denial that this is a zero.
  if (balance.status === 'unavailable') {
    return (
      <div style={heroCardDead}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          {head(C.mutedDim)}
          <span style={{ padding: '3px 9px', borderRadius: 999, fontSize: 10.5, fontWeight: 700, color: C.warn300, background: warnFill(0.08), border: warnBorder(0.3) }}>UNAVAILABLE</span>
        </div>
        <span style={{ fontFamily: MONO, fontSize: 34, fontWeight: 600, color: C.faintDim }}>—</span>
        <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 8, lineHeight: 1.5 }}>
          Couldn’t reach the network. This is not a zero — your funds are unchanged.
          {onRetry && <> <span role="button" tabIndex={0} onClick={onRetry} onKeyDown={e => e.key === 'Enter' && onRetry()} style={{ color: C.teal, fontWeight: 700, cursor: 'pointer' }}>Retry</span></>}
        </div>
      </div>
    )
  }

  const zero = balance.microtari === 0n
  return (
    <div style={heroCard}>
      <div style={{ marginBottom: 14 }}>{head(C.teal)}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: MONO, fontSize: 34, fontWeight: 600, letterSpacing: hidden ? '0.08em' : '-0.01em',
          color: zero && !hidden ? C.tealDim : C.bright,
        }}>{hidden ? MASK : fmt6(balance.microtari)}</span>
        <span style={{ fontFamily: MONO, fontSize: 15, color: C.tealDim }}>TARI</span>
      </div>
      <div style={{ fontSize: 12.5, color: C.tealLabel, marginTop: 8 }}>
        {hidden ? 'Hidden from view · tap the eye to show' : 'Hidden on-chain · only you can see this'}
      </div>
    </div>
  )
}

// ── Public row ────────────────────────────────────────────────────────────────

export function PublicRow({ balance, hidden, onRetry }: {
  balance: BalanceView; hidden: boolean; onRetry?: () => void
}) {
  const head = (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <Eye color={C.mutedDim} /><span style={{ ...label, color: C.mutedDim }}>PUBLIC</span>
    </span>
  )
  const shell = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '15px 22px', borderRadius: 14, background: C.raised, border: border(0.18),
  } as const

  if (balance.status === 'loading') {
    return (
      <div style={{ ...shell, display: 'block' }}>
        <div style={{ marginBottom: 10 }}>{head}</div>
        <Skeleton w={130} h={18} fill="rgba(199,208,228,0.1)" />
      </div>
    )
  }

  if (balance.status === 'unavailable') {
    return (
      <div style={{ ...shell, background: C.disabled, border: '1px dashed rgba(120,150,210,0.2)' }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {head}
          <span style={{ fontFamily: MONO, fontSize: 19, color: C.faintDim }}>—</span>
        </span>
        {onRetry && (
          <span role="button" tabIndex={0} onClick={onRetry} onKeyDown={e => e.key === 'Enter' && onRetry()} style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 10,
            background: C.inset, border: border(0.24), fontSize: 12.5, fontWeight: 700, color: C.body, cursor: 'pointer', flexShrink: 0,
          }}><Retry color={C.body} />Retry</span>
        )}
      </div>
    )
  }

  const zero = balance.microtari === 0n
  return (
    <div style={shell}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        {head}
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: MONO, fontSize: 19, fontWeight: 500,
            letterSpacing: hidden ? '0.08em' : undefined,
            color: hidden ? C.bodyDim : zero ? C.faintDim : C.bodyDim,
          }}>{hidden ? MASK_SHORT : fmt6(balance.microtari)}</span>
          <span style={{ fontFamily: MONO, fontSize: 12.5, color: zero && !hidden ? C.ghost : C.faint }}>TARI</span>
        </span>
      </span>
      <span style={{ fontSize: 11.5, color: C.faint, textAlign: 'right', lineHeight: 1.4, flexShrink: 0 }}>
        {zero && !hidden ? <>nothing public<br />right now</> : <>visible to anyone<br />on-chain</>}
      </span>
    </div>
  )
}
