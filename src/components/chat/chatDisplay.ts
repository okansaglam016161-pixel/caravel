// Shared chat display helpers — single source of truth for the DM and group views. Moved verbatim
// out of ChatApp.tsx (Stage 1 refactor) so both threads render identity, timestamps, and avatars
// identically. Pure functions + tokens only; no behavior change.

import * as nip19 from 'nostr-tools/nip19'
import { classifyQuoted, quoteSnippet } from './replyCompose'
import type { CaravelMessage } from '../../messaging/types'
import type { CSSProperties } from 'react'
import { compareMessages, sortKey, type MessageOrder } from '../../messaging/types'

export const MONO = "'IBM Plex Mono', monospace"

// Shared style for the per-message hover buttons (the Edit pencil, the Reply arrow). One object, in
// the module both views already share, so the two buttons cannot drift apart visually — they sit
// side by side in the same row, where a 1px difference reads as a mistake. Only the LOOK lives here;
// the hover reveal is in index.css, keyed off .cv-msg-actionrow.
export const ACTION_BTN: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, flexShrink: 0, padding: 0, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-raised)', color: 'var(--text-muted)', cursor: 'pointer' }

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

// ── The reply chip's second line ────────────────────────────────────────────────
//
// What you are replying to, in one line, for the chip inside the composer.
//
// IT REUSES QuotedPreview'S MAPPING RATHER THAN COPYING IT. A reply target is not always text: it
// can be a photo, a payment, or a message that has not arrived yet, and each has an honest
// one-liner. That four-way answer already existed once, in QuotedPreview; passing
// `quoteSnippet(target.plaintext)` straight from the composer would have shown an empty line for a
// photo or a payment, and inlining the mapping at both composers would have made a third and
// fourth copy of it. This reads classifyQuoted and quoteSnippet from replyCompose; it does not
// change them.

/** One line naming what a reply is answering — the quoted text, or what it was instead. */
export function replyChipDetail(target: CaravelMessage | undefined): string {
  const kind = classifyQuoted(target)
  return kind === 'text' ? quoteSnippet(target!.plaintext)
    : kind === 'media' ? 'Photo'
    : kind === 'payment' ? 'Payment'
    : 'Original unavailable'
}

// ── Day grouping (stage 4) ──────────────────────────────────────────────────────
//
// A thread reads as one undated wall without these. The pair is split by TESTABILITY, which is the
// line this file already draws: `isNewDay` is a pure comparison over two epochs and is covered in
// chatDisplay.test.ts; `dayLabel` calls toLocaleDateString and so is locale- and TZ-dependent,
// exactly like compactTime and bubbleTime above, and is left untested for the same reason.
//
// LOCAL CALENDAR DAYS, NOT 24-HOUR BUCKETS. Two messages 30 minutes apart belong to different days
// if a midnight fell between them, and two messages 20 hours apart do not if one did not. That is
// what a reader means by "a new day", and it is why this compares date components rather than
// subtracting.
//
// The views insert dividers at RENDER TIME by walking their own item list; nothing here mutates
// that list, so mergeThreadItems and the ThreadItem union are untouched.

/** True when `ts` falls on a later calendar day than `prev`, in the viewer's own timezone. */
export function isNewDay(prev: number, ts: number): boolean {
  const a = new Date(prev)
  const b = new Date(ts)
  return a.getFullYear() !== b.getFullYear()
    || a.getMonth() !== b.getMonth()
    || a.getDate() !== b.getDate()
}

/** TODAY / YESTERDAY / "MON 4 MAR" — the divider's caption, upper-cased by the design. */
export function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (!isNewDay(ts, now.getTime())) return 'TODAY'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (!isNewDay(ts, yesterday.getTime())) return 'YESTERDAY'
  // The year is included only when it is not the current one — a date that needs it is old enough
  // that its absence would be the thing you noticed.
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear()
    ? { weekday: 'short', day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' }
  return d.toLocaleDateString([], opts).toUpperCase()
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
// TIES BETWEEN A MESSAGE AND A PENDING ROW: the message wins. Array.prototype.sort is stable and
// `messages` is concatenated first, so that falls out rather than needing a comparator branch — but
// it is deliberate, not incidental: a real row beats a provisional one for the same moment.
//
// TIES BETWEEN TWO MESSAGES are broken by compareMessages, NOT left to stability. Received rows
// carry whole-second send times, so a burst sent inside one second ties here routinely, and leaving
// it to stability would silently make the rendered order depend on the caller having pre-sorted with
// the same comparator. This function decides its own order instead.
export type ThreadItem<M, P> =
  | { kind: 'message'; at: number; message: M }
  | { kind: 'pending'; at: number; pending: P }

export function mergeThreadItems<M extends MessageOrder, P extends { attemptedAt: number }>(
  messages: readonly M[],
  pending: readonly P[],
): ThreadItem<M, P>[] {
  const items: ThreadItem<M, P>[] = [
    // `at` merges the two kinds onto one axis: a message's clamped send time against a pending
    // row's attempt time, both our-clock-or-sender-clock instants of "when this was written".
    ...messages.map(message => ({ kind: 'message' as const, at: sortKey(message), message })),
    ...pending.map(p => ({ kind: 'pending' as const, at: p.attemptedAt, pending: p })),
  ]
  return items.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    if (a.kind === 'message' && b.kind === 'message') return compareMessages(a.message, b.message)
    return 0    // message-vs-pending: 0 keeps the stable message-first rule above
  })
}

// The auto-scroll trigger for a thread: changes whenever the rendered content could have grown.
//
// A BARE COUNT IS NOT ENOUGH, which is what broke image sends. `messages.length + pending.length` is
// IDENTICAL either side of a successful send — the provisional row is removed in the same commit the
// real one is added — so the scroll fired for the pending bubble and never again. Text got away with
// it because a provisional text bubble and a real one are the same height. An image does not: a
// ~50px filename bubble is replaced by a card up to 400px tall, and the thread was left that far
// short of the bottom.
//
// Including each pending row's STATUS also catches 'sending' → 'failed', where the bubble grows by a
// label, a hint and its buttons — so a failure that arrives after a long upload is scrolled into
// view rather than appearing just below the fold.
export function threadContentKey(
  messages: readonly unknown[],
  pending: readonly { status: string }[],
): string {
  return `${messages.length}:${pending.map(p => p.status).join(',')}`
}

// Filename offered when saving an image out of the lightbox (images M5).
//
// The decrypted bytes have no name of their own — the original filename is deliberately never sent
// (it would leak "IMG_4821.HEIC" or worse to the recipient, and the whole pipeline re-encodes to a
// new format anyway). So one is composed from the message's own timestamp, which is stable: saving
// the same image twice offers the same name rather than a new one each second.
//
// Extension comes from the POST-processing MIME, since that is what the bytes actually are.
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
}

export function mediaFilename(mime: string, timestamp: number): string {
  const ext = EXTENSION_BY_MIME[(mime || '').toLowerCase()] ?? 'img'
  const d = new Date(timestamp)
  // Local time, not ISO/UTC: the name should match when the user remembers receiving it. Padded so
  // names sort correctly in a file listing.
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `caravel-${stamp}.${ext}`
}

// Stable avatar gradient per peer — the five avatar-token pairs
// (blue/slate/violet/green/amber), assigned by hash of the contact key. The order is load-bearing:
// changing it re-colours every existing contact, because the hash indexes into this array.
const AVATARS = [
  { grad: 'var(--avatar-blue)', color: 'var(--avatar-blue-ink)' },
  { grad: 'var(--avatar-slate)', color: 'var(--avatar-slate-ink)' },
  { grad: 'var(--avatar-violet)', color: 'var(--avatar-violet-ink)' },
  { grad: 'var(--avatar-green)', color: 'var(--avatar-green-ink)' },
  { grad: 'var(--avatar-amber)', color: 'var(--avatar-amber-ink)' },
]
export function avatarFor(peerHex: string) {
  let h = 0
  for (let i = 0; i < peerHex.length; i++) h = (h * 31 + peerHex.charCodeAt(i)) >>> 0
  return AVATARS[h % AVATARS.length]
}
