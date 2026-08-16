// Encrypted image attachment in a thread (images M4). Replaces M3's MediaPlaceholder wholesale.
//
// THE SIZED BOX IS THE SPINE. Every state — loading, retrying, ready, failed — renders in a box of
// the SAME dimensions, computed from the ref's own width/height (recorded at send time, before
// encryption). So the image drops into space already reserved and nothing reflows when it lands
// mid-scroll. Without that, a thread of loading images would jump every time one resolved.
//
// Shared by the DM and group threads, like MessageBubble. Sent and received differ only in alignment
// and corner radius — unlike a payment, an image has no per-direction CONTENT difference, so there
// are no separate Sent/Received components.

import { useState, type ReactNode } from 'react'
import type { CaravelMessage, MediaRef } from '../../messaging/types'
import { useMediaResolution } from '../../hooks/useMediaResolution'
import { bubbleTime, mediaBoxSize, mediaFilename, MONO } from './chatDisplay'
import ImageLightbox from './ImageLightbox'

// Stand-in for a row with no media, so the hook can be called unconditionally (rules of hooks) on a
// path that then renders nothing. MODULE-LEVEL and frozen on purpose: an object literal built inside
// the component would get a fresh identity every render and re-fire the resolver's effect each time.
// Its blank `x` makes the effect a no-op regardless.
const NO_MEDIA: MediaRef = { url: '', key: '', nonce: '', mime: '', x: '', ox: '', width: 0, height: 0, size: 0 }

// The box fits inside this envelope while preserving the image's aspect ratio.
const MAX_W = 320
const MAX_H = 400

// Honest copy per failure reason. NONE of these imply the image is present, and Retry appears only
// where retrying could actually change the outcome.
//
// `gone` is the one users will really hit — the blob host purged it — so it reads as a fact about
// the world rather than an error the user caused or can fix.
const FAILURE_COPY: Record<string, string> = {
  gone: 'Image is no longer available',
  corrupt: 'Image failed its integrity check',
  undecryptable: 'Image couldn’t be decrypted',
  too_large: 'Image is too large to display',
  network_error: 'Couldn’t load image',
}

function Frame({ w, h, sent, children }: { w: number; h: number; sent: boolean; children: ReactNode }) {
  return (
    <div style={{
      width: w, height: h, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 9,
      borderRadius: sent ? '16px 6px 16px 16px' : '6px 16px 16px 16px',
      background: 'var(--surface-inset)',
      border: '1px solid rgba(var(--border-rgb),0.14)',
    }}>
      {children}
    </div>
  )
}

const spinner = (
  <span style={{ width: 20, height: 20, borderRadius: '50%', border: '2.2px solid rgba(var(--teal-500-rgb),0.2)', borderTopColor: 'var(--teal-500)', animation: 'cv-spin 0.9s linear infinite' }} />
)

const brokenIcon = (
  <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="var(--text-faint-dim)" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <rect x={3} y={3} width={18} height={18} rx={2} /><path d="M3 15l5-4 4 3 3-2 6 5" /><path d="M3 3l18 18" />
  </svg>
)

export default function MediaMessageCard({ message }: { message: CaravelMessage }) {
  const media = message.media
  // Defensive: the dispatch sites only render this when `media` is set, but the non-null assertion
  // would be the one thing standing between a malformed row and a crashed thread.
  const { state, retry } = useMediaResolution(media ?? NO_MEDIA)
  // Lightbox open state lives HERE, not in ChatApp — the overlay borrows this card's object URL, so
  // it must unmount with this card. See ImageLightbox for the full reasoning.
  const [expanded, setExpanded] = useState(false)
  if (!media) return null

  const sent = message.direction === 'sent'
  const caption = message.plaintext.trim()
  const { w, h } = mediaBoxSize(media.width, media.height, MAX_W, MAX_H)

  let body: ReactNode
  if (state.kind === 'ready') {
    body = (
      <img
        src={state.url}
        alt={caption || 'Image attachment'}
        onClick={() => setExpanded(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', cursor: 'zoom-in' }}
      />
    )
  } else if (state.kind === 'loading' || state.kind === 'retrying') {
    body = (
      <>
        {spinner}
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)' }}>
          {state.kind === 'retrying' ? 'Reaching the host…' : 'Decrypting…'}
        </span>
      </>
    )
  } else {
    body = (
      <>
        {brokenIcon}
        <span style={{ fontSize: 12, color: 'var(--text-muted-dim)', textAlign: 'center', padding: '0 14px', lineHeight: 1.4 }}>
          {FAILURE_COPY[state.reason] ?? 'Couldn’t load image'}
        </span>
        {/* Retry ONLY where retrying can change the outcome. gone/corrupt/undecryptable/too_large all
            return the identical answer on a second attempt, so offering a button there would be a lie. */}
        {state.reason === 'network_error' && (
          <span onClick={retry} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, background: 'rgba(var(--border-rgb),0.1)', border: '1px solid rgba(var(--border-rgb),0.22)', fontSize: 11.5, fontWeight: 700, color: 'var(--text-body-dim)', cursor: 'pointer' }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>
            Retry
          </span>
        )}
      </>
    )
  }

  return (
    <div style={{ alignSelf: sent ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
      <Frame w={w} h={h} sent={sent}>{body}</Frame>
      {/* Only reachable once the bytes are decrypted, so `state.url` is always a live borrow here. */}
      {expanded && state.kind === 'ready' && (
        <ImageLightbox
          url={state.url}
          filename={mediaFilename(media.mime, message.timestamp)}
          caption={caption}
          onClose={() => setExpanded(false)}
        />
      )}
      {caption && (
        <div style={{ marginTop: 7, fontSize: 14, color: 'var(--text-body)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: w }}>
          {caption}
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 11,
        color: 'var(--text-faint-dim)', marginTop: 6,
        justifyContent: sent ? 'flex-end' : 'flex-start', width: w,
      }}>
        {bubbleTime(message.timestamp)}
        {sent && <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>}
      </div>
    </div>
  )
}
