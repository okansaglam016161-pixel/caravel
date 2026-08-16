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

// The on-screen box for an image attachment (images M4): fit (width × height) inside maxW × maxH,
// preserving aspect ratio.
//
// This is the spine of the media card, not a cosmetic detail. The SAME box is rendered in every
// state — loading, retrying, ready, failed — using dimensions recorded at send time, so the decoded
// image drops into space already reserved. Without it, a thread of loading images would jerk the
// scroll position every time one resolved.
//
// Falls back to 4:3 for a ref carrying no dimensions: extractMedia deliberately lets those through,
// since a missing width does not stop an image being fetched and decrypted.
export function mediaBoxSize(width: number, height: number, maxW: number, maxH: number): { w: number; h: number } {
  // Either dimension missing means we know nothing about the shape, so fall back to a FULL-SIZE 4:3
  // box rather than to the literal numbers 4 and 3 — which would reserve a four-pixel box and defeat
  // the whole purpose. (Both are defaulted together by extractMedia, but a half-valid pair must not
  // produce a nonsense aspect either.)
  const known = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
  const srcW = known ? width : maxW
  const srcH = known ? height : (maxW * 3) / 4
  let w = Math.min(maxW, srcW)
  let h = Math.round((w * srcH) / srcW)
  if (h > maxH) {
    h = maxH
    w = Math.round((h * srcW) / srcH)
  }
  // Floors of 1: an extreme aspect ratio must never round a side to zero, which would collapse the
  // box and reintroduce the layout jump this function exists to prevent.
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

// One chronologically-ordered list of a thread's real messages and its provisional (sending/failed)
// bubbles, so both views render a single pass instead of appending pending rows at the end.
//
// WHY THIS EXISTS: pending bubbles used to render in a separate map AFTER the messages, which pinned
// them to the bottom of the thread forever. Correct for an in-flight send — it IS the newest thing —
// but a FAILED entry lingers, and every later message pushed it further out of place until it sat
// below messages sent long after it, still claiming to be the most recent thing in the thread.
//
// ONE RULE COVERS BOTH STATUSES, which is why there is no special-casing here: a 'sending' entry is
// by construction the newest, so ordering by time puts it at the bottom anyway. Only the
// after-the-fact case changes.
//
// TIES: messages sort before pending at the same instant. Array.prototype.sort is stable and
// `messages` is concatenated first, so that falls out rather than needing a comparator branch — but
// it is deliberate, not incidental: a real row beats a provisional one for the same moment.
export type ThreadItem<M, P> =
  | { kind: 'message'; at: number; message: M }
  | { kind: 'pending'; at: number; pending: P }

export function mergeThreadItems<M extends { timestamp: number }, P extends { attemptedAt: number }>(
  messages: readonly M[],
  pending: readonly P[],
): ThreadItem<M, P>[] {
  const items: ThreadItem<M, P>[] = [
    ...messages.map(message => ({ kind: 'message' as const, at: message.timestamp, message })),
    ...pending.map(p => ({ kind: 'pending' as const, at: p.attemptedAt, pending: p })),
  ]
  return items.sort((a, b) => a.at - b.at)
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
