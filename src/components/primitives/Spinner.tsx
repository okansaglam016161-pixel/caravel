//   Spinner — teal ring, token-driven. Sizes: xs (in-button), sm, md.
//   Consumes: --teal-500, --teal-500-rgb. Animation: cv-spin (index.css).

import type { CSSProperties } from 'react'

export type SpinnerSize = 'xs' | 'sm' | 'md'

const DIMENS: Record<SpinnerSize, { px: number; dur: string }> = {
  xs: { px: 14, dur: '0.8s' },
  sm: { px: 20, dur: '0.8s' },
  md: { px: 26, dur: '1.1s' },
}

interface SpinnerProps {
  size?: SpinnerSize
  /** Override the ring/top colour (e.g. muted inside a busy button). Defaults to teal. */
  tone?: 'teal' | 'muted'
  style?: CSSProperties
}

export default function Spinner({ size = 'sm', tone = 'teal', style }: SpinnerProps) {
  const { px, dur } = DIMENS[size]
  const ring = tone === 'muted' ? 'rgba(var(--border-rgb), 0.25)' : 'rgba(var(--teal-500-rgb), 0.2)'
  const top = tone === 'muted' ? 'var(--text-faint-dim)' : 'var(--teal-500)'
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: px,
        height: px,
        borderRadius: '50%',
        border: `2px solid ${ring}`,
        borderTopColor: top,
        animation: `cv-spin ${dur} linear infinite`,
        ...style,
      }}
    />
  )
}
