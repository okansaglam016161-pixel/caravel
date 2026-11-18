// "1,234 Users Live": the live user count (userCount.ts) as a small green pill with a dot.
//
// Renders nothing until a relay has answered with a number, and nothing at zero (a launch-day page
// saying "0 Users Live" helps nobody). Never an error. Fades in when it arrives.

import { userCountLabel } from './userCount'

export default function UserCountPill({ count }: { count: number | null }) {
  if (count === null || count <= 0) return null
  return (
    <span className="cv-lp-count" style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
      background: 'var(--lp-green-wash)', color: 'var(--lp-green)',
      fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--lp-green)', flexShrink: 0 }} />
      {userCountLabel(count)}
    </span>
  )
}
