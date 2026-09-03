// Full-screen view of a decrypted image attachment (images M5).
//
// ⚠️ RENDERED FROM INSIDE MediaMessageCard, NOT HOISTED TO ChatApp — and that is a correctness
// requirement, not a preference.
//
// The object URL it displays is owned by that card's resolver effect (useMediaResolution), which
// revokes it on unmount. If this overlay lived at the app root, switching threads could unmount the
// card, revoke the URL, and leave a live overlay pointing at a dead blob. Rendering it as a child of
// the card means it unmounts WITH the card, so that state is unreachable. `position: fixed` covers
// the viewport regardless of how deep in the DOM it sits, so nothing is lost by keeping it here.
//
// It therefore MINTS NOTHING and REVOKES NOTHING: `url` is borrowed for as long as the overlay is
// open, and closing it must leave the thread's own <img> working. Creating a second URL here would
// be the leak M4 was built to avoid.

import { useEffect, useRef } from 'react'
import { MONO } from './chatDisplay'

export default function ImageLightbox({ url, filename, caption, onClose }: {
  url: string           // BORROWED from the resolver — never created or revoked here
  filename: string
  caption: string
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  // Where focus was before we opened, so it can be handed back on close rather than dumped at the
  // top of the document.
  const returnFocusRef = useRef<Element | null>(null)

  useEffect(() => {
    returnFocusRef.current = document.activeElement
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    // Stop the thread scrolling underneath while the overlay is up.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      ;(returnFocusRef.current as HTMLElement | null)?.focus?.()
    }
  }, [onClose])

  return (
    <div
      onClick={onClose}   // click-outside closes; the image below stops propagation
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        // dvh, not vh: on iOS Safari 100vh is taller than the visible area because of the address
        // bar, which would push the controls off-screen.
        height: '100dvh',
        display: 'flex', flexDirection: 'column',
        background: 'rgba(4,7,12,0.92)', backdropFilter: 'blur(6px)',
      }}
    >
      {/* Toolbar — download + close. Sits above the image so it never overlaps the picture itself. */}
      <div
        onClick={e => e.stopPropagation()}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '14px 18px', flexShrink: 0 }}
      >
        {/* A plain anchor with `download` — the browser's own save, straight from the object URL the
            thread is already using. No re-fetch, no re-decrypt, no second URL.
            KNOWN LIMITATION: iOS Safari has historically ignored `download` for blob: URLs and may
            open the image in a new tab instead. Long-press → Save Image still works there. */}
        <a
          href={url}
          download={filename}
          onClick={e => e.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 9, background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)', color: 'var(--text-body)', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
          Download
        </a>
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close image"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 9, background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)', color: 'var(--text-body)', cursor: 'pointer', padding: 0 }}
        >
          <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {/* The image, scaled to fit whatever room is left. No pan, no zoom, no swipe — deliberate for
          v1; the point is to see the picture at full size. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 18px' }}>
        <img
          src={url}
          alt={caption || 'Image attachment'}
          onClick={e => e.stopPropagation()}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', borderRadius: 6 }}
        />
      </div>

      <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0, padding: '14px 18px 20px', textAlign: 'center' }}>
        {caption
          ? <div style={{ fontSize: 14, color: 'var(--text-body)', lineHeight: 1.45, wordBreak: 'break-word', maxWidth: 640, margin: '0 auto' }}>{caption}</div>
          : <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)' }}>Press Esc or click anywhere to close</div>}
      </div>
    </div>
  )
}
