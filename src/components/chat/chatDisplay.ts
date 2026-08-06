// Shared chat display helpers — single source of truth for the DM and group views. Moved verbatim
// out of ChatApp.tsx (Stage 1 refactor) so both threads render identity, timestamps, and avatars
// identically. Pure functions + tokens only; no behavior change.

import * as nip19 from 'nostr-tools/nip19'

export const MONO = "'IBM Plex Mono', monospace"

// npub1abcdefg…wxyz — never throws (blank/invalid hex falls back to raw prefix).
export function truncNpub(peerHex: string): string {
  try {
    const npub = nip19.npubEncode(peerHex)
    return npub.slice(0, 12) + '…' + npub.slice(-4)
  } catch { return peerHex.slice(0, 10) + '…' }
}

// Two-letter avatar initials from a nickname; "··" when we only have an npub.
export function initialsFor(nickname: string | undefined): string {
  if (!nickname) return '··'
  const parts = nickname.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return nickname.trim().slice(0, 2).toUpperCase()
}

// Compact list timestamp: time today, weekday within a week, else month/day.
export function compactTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if ((now.getTime() - ts) < 7 * 86_400_000) {
    return d.toLocaleDateString([], { weekday: 'short' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Full time shown under each message bubble.
export function bubbleTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Stable avatar gradient per peer — the design's 5 avatar-token pairs (teal/slate/plum/moss/amber),
// assigned by hash of the contact key.
const AVATARS = [
  { grad: 'var(--avatar-teal)', color: 'var(--avatar-teal-ink)' },
  { grad: 'var(--avatar-slate)', color: 'var(--avatar-slate-ink)' },
  { grad: 'var(--avatar-plum)', color: 'var(--avatar-plum-ink)' },
  { grad: 'var(--avatar-moss)', color: 'var(--avatar-moss-ink)' },
  { grad: 'var(--avatar-amber)', color: 'var(--avatar-amber-ink)' },
]
export function avatarFor(peerHex: string) {
  let h = 0
  for (let i = 0; i < peerHex.length; i++) h = (h * 31 + peerHex.charCodeAt(i)) >>> 0
  return AVATARS[h % AVATARS.length]
}
