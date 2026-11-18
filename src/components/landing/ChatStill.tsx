// The landing page's chat pictures: a still of a Caravel conversation, drawn to the approved landing
// design (Main.dc.html) on the app's own theme tokens. Two windows use these pieces: the hero's Mira
// thread (the default export, with a confidential-payment card) and the Questions section's thread
// with Caravel (LandingPage).
//
// DECORATION, NOT UI: `inert` takes every window out of focus, clicks and the accessibility tree.
// Colours that the app has no role token for (the avatar wash, the RECEIVED green) are the landing's
// own scoped variables, set per theme in LandingPage's CSS (`--lp-*`).

import type { CSSProperties, ReactNode } from 'react'
import LogoTile from '../primitives/LogoTile'
import { TICKER } from '../../sapient/units'

const MONO = 'var(--font-mono)'

/** The window: surface card with a hairline border. `chrome` adds the three-dot title bar. */
export function StillWindow({ children, chrome = false, shadow = false, style }: {
  children: ReactNode; chrome?: boolean; shadow?: boolean; style?: CSSProperties
}) {
  return (
    <div inert style={{
      minWidth: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20,
      overflow: 'hidden', textAlign: 'left', ...(shadow ? { boxShadow: 'var(--e3)' } : {}), ...style,
    }}>
      {chrome && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          {[0, 1, 2].map(i => <span key={i} style={{ width: 9, height: 9, borderRadius: 999, background: 'var(--border)' }} />)}
        </div>
      )}
      {children}
    </div>
  )
}

/** The thread header: an avatar, the name, and a one-line status under it. */
export function StillHeader({ avatar, name, status }: { avatar: ReactNode; name: string; status: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 22px', borderBottom: '1px solid var(--border)' }}>
      {avatar}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>{name}</span>
        <span style={{ fontSize: 12.5, color: 'var(--text-body-dim)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>{status}</span>
      </div>
    </div>
  )
}

/** The thread body, on the page ground. */
export function StillBody({ children, padding, gap }: { children: ReactNode; padding: string; gap: number }) {
  return (
    <div style={{ padding, display: 'flex', flexDirection: 'column', gap, background: 'var(--surface-void)' }}>
      {children}
    </div>
  )
}

/** One bubble. `in` = theirs (surface, left); `out` = yours (brand blue, right). */
export function Bubble({ side, children, maxWidth = '78%', weight, lineHeight = 1.45 }: {
  side: 'in' | 'out'; children: ReactNode; maxWidth?: string; weight?: number; lineHeight?: number
}) {
  const mine = side === 'out'
  return (
    <div style={{
      alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth, padding: '11px 15px',
      borderRadius: mine ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
      background: mine ? 'var(--accent-400)' : 'var(--surface)',
      color: mine ? '#FFFFFF' : 'var(--text-primary)',
      border: mine ? 'none' : '1px solid var(--border)',
      fontSize: 15, lineHeight, fontWeight: weight,
    }}>{children}</div>
  )
}

/** Caravel's round avatar: the brand tile, circular. */
export function CaravelAvatar({ size = 32 }: { size?: number }) {
  return <LogoTile size={size} style={{ borderRadius: '50%' }} />
}

const Lock = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)

/** A received confidential payment, as the chat draws one. */
function PaymentStill() {
  return (
    <div style={{
      alignSelf: 'flex-start', width: 260, maxWidth: '85%', boxSizing: 'border-box',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
      padding: '16px 18px', boxShadow: 'var(--e1)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-body-dim)' }}>Confidential payment</span>
        <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--lp-green)' }}>RECEIVED</span>
      </div>
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>250</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-body-dim)' }}>{TICKER}</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--text-body-dim)' }}>Amount hidden on chain</div>
    </div>
  )
}

/** The hero's window: a thread with Mira, carrying a received payment. */
export default function ChatStill() {
  return (
    <StillWindow chrome shadow>
      <StillHeader
        avatar={
          <span style={{
            width: 36, height: 36, borderRadius: 999, flexShrink: 0,
            background: 'var(--lp-avatar-bg)', color: 'var(--lp-avatar-ink)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 13,
          }}>MI</span>
        }
        name="Mira"
        status={<><Lock />End-to-end encrypted</>}
      />
      <StillBody padding="24px 22px 28px" gap={12}>
        <Bubble side="in">Here&rsquo;s my half of dinner, sent it right here</Bubble>
        <PaymentStill />
        <Bubble side="out">Got it, thank you</Bubble>
        <Bubble side="in">So much easier</Bubble>
      </StillBody>
    </StillWindow>
  )
}
