import { useId } from 'react'

interface LogoProps {
  size?: number
}

export default function Logo({ size = 30 }: LogoProps) {
  const gradId = useId()
  return (
    <svg viewBox="0 0 44 44" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accL,#5CEAD6)" />
          <stop offset="1" stopColor="var(--accD,#12A594)" />
        </linearGradient>
      </defs>
      <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill={`url(#${gradId})`} />
      <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="var(--acc,#2DE0C6)" opacity={0.45} />
      <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="var(--acc,#2DE0C6)" />
    </svg>
  )
}
