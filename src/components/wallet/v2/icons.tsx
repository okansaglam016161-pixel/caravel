// Icons transcribed from the design canvas. Every path is the design's own.
//
// THE TWO THAT CARRY MEANING: a SHIELD marks private, an EYE marks public. That pairing does more
// work than any label — it is why the overview reads at a glance, and why the direction chips are
// legible without reading them. Everything else here is utility.

interface I { size?: number; color: string; width?: number }

export const Shield = ({ size = 13, color, width = 2.1 }: I) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2 L 20 5.5 V 11 C 20 16.5 16.5 20.5 12 22 C 7.5 20.5 4 16.5 4 11 V 5.5 Z" />
  </svg>
)

export const Eye = ({ size = 12, color, width = 1.9 }: I) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12 C 5 6.5 9 4.5 12 4.5 C 15 4.5 19 6.5 22 12 C 19 17.5 15 19.5 12 19.5 C 9 19.5 5 17.5 2 12 Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const EyeOff = ({ size = 16, color, width = 1.9 }: I) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12 C 5 6.5 9 4.5 12 4.5 C 15 4.5 19 6.5 22 12 C 19 17.5 15 19.5 12 19.5 C 9 19.5 5 17.5 2 12 Z" />
    <path d="M4 4 L 20 20" />
  </svg>
)

/** The direction arrow. Teal for the routine move, amber for the permanent one. */
export const Arrow = ({ color }: { color: string }) => (
  <svg width="18" height="14" viewBox="0 0 24 16" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 8 H 20 M 14 2 L 20 8 L 14 14" />
  </svg>
)

export const Check = ({ size = 22, color }: I) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
)

export const Alert = ({ size = 20, color }: I) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
    <path d="M12 7v6" /><circle cx="12" cy="16.6" r="0.6" fill={color} />
  </svg>
)

export const Copy = ({ size = 13, color }: I) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

export const Retry = ({ size = 12, color }: I) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" />
  </svg>
)

export const Lock = ({ size = 14, color }: I) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10 V 7 a4 4 0 0 1 8 0 v 3" />
  </svg>
)

/** Indeterminate spinner. Uses the app's existing cv-spin keyframes (index.css). */
export const Spinner = ({ size = 13, ring = 2, color = '#2DE0C6' }: { size?: number; ring?: number; color?: string }) => (
  <span style={{
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    border: `${ring}px solid rgba(45,224,198,0.2)`, borderTopColor: color,
    animation: 'cv-spin 0.9s linear infinite', display: 'inline-block',
  }} />
)
