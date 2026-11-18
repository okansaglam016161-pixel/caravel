// "1,234 Users Live": the live user count (userCount.ts), with a green dot that pulses.
//
// SHAPED LIKE THE TOP BAR'S "Launch Caravel" BUTTON (same height, radius, padding, type) but quiet:
// surface ground, hairline border, normal text, so it never reads as a second button. Its 1px border
// is taken out of the padding (9/17 against the button's 10/18) to keep the height identical.
//
// Renders nothing until a relay has answered with a number, and nothing at zero (a launch-day page
// saying "0 Users Live" helps nobody). Never an error. Fades in when it arrives; the pulse is CSS
// (.cv-lp-live-dot in LandingPage) and stops under prefers-reduced-motion.

import { userCountLabel } from './userCount'

export default function UserCountPill({ count }: { count: number | null }) {
  if (count === null || count <= 0) return null
  return (
    <span className="cv-lp-count" style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, boxSizing: 'border-box',
      padding: '9px 17px', borderRadius: 10, border: '1px solid var(--border)',
      background: 'var(--surface)', color: 'var(--text-primary)',
      fontFamily: 'inherit', fontSize: 14, fontWeight: 600, lineHeight: 'normal',
      fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    }}>
      <span aria-hidden="true" className="cv-lp-live-dot" />
      {userCountLabel(count)}
    </span>
  )
}
