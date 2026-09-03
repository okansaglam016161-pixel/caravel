// Full-screen view of a decrypted image attachment (images M5), drawn to Caravel Chat V3 §9A.
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
//
// ── EVERY COLOUR IN HERE IS A LITERAL, AND THAT IS THE DESIGN ────────────────────────────────────
//
// §9A: "the scrim is a literal near-black in both themes, so the lightbox has one composition, not
// two theme variants." Nothing below reads a role token, so unlike the payment card there is no
// data-theme pin to apply and nothing to flip when the app's theme changes — a hardcoded value here
// is the specified answer, not a missing token. The one place to check if this ever looks wrong is
// that the scrim is OPAQUE: it covers the thread completely, which is why it carries no
// backdrop-filter (a blur behind an opaque fill paints nothing and costs a fullscreen GPU pass).

import { useEffect, useRef } from 'react'
import { dayLabel, bubbleTime, readableSize, MONO } from './chatDisplay'

const SCRIM = '#0A0F17'
const INK = '#E7EDF5'      // toolbar + filename
const META_INK = '#67788E' // size · date

// "2.4 MB · Today 14:32" — the footer's second half.
//
// `bytes` is MediaRef.size, which counts CIPHERTEXT: the plaintext plus AES-GCM's 16-byte tag. At
// the KB/MB granularity readableSize renders, that overhead never changes the figure, so quoting it
// as the image's size is honest. A ref carrying size 0 (extractMedia lets those through) drops the
// size rather than claiming "0 B".
//
// Locale- and timezone-dependent, and so left untested for the same reason compactTime, bubbleTime
// and dayLabel are — see the note on those in chatDisplay.
function metaLine(bytes: number, timestamp: number): string {
  const day = dayLabel(timestamp)
  // dayLabel is upper-cased for the thread's day dividers; §9A draws this line in sentence case.
  const when = day === 'TODAY' ? 'Today' : day === 'YESTERDAY' ? 'Yesterday' : day
  const stamp = `${when} ${bubbleTime(timestamp)}`
  return bytes > 0 ? `${readableSize(bytes)} · ${stamp}` : stamp
}

// A ghost control on the scrim: white at 6%, 12% on hover (.cv-lightbox-btn in index.css, since
// :hover has no inline-style equivalent). No border — §9A gives these a fill and nothing else.
const GHOST: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 10, background: 'rgba(255,255,255,0.06)', border: 'none',
  color: INK, cursor: 'pointer',
}

export default function ImageLightbox({ url, filename, caption, size, width, height, timestamp, onClose }: {
  url: string           // BORROWED from the resolver — never created or revoked here
  filename: string
  caption: string
  size: number          // MediaRef.size — ciphertext bytes; see metaLine
  width: number         // post-downscale pixel dimensions, 0 when the ref carried none
  height: number
  timestamp: number
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
      onClick={onClose}   // click-outside closes; the frame below stops propagation
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        // dvh, not vh: on iOS Safari 100vh is taller than the visible area because of the address
        // bar, which would push the controls off-screen.
        height: '100dvh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '64px 24px 40px', background: SCRIM,
      }}
    >
      {/* Toolbar — download + close. §9A floats it in the scrim's top-right corner rather than
          reserving a row for it, so the picture gets the full height. */}
      <div
        onClick={e => e.stopPropagation()}
        style={{ position: 'absolute', top: 16, right: 16, display: 'flex', alignItems: 'center', gap: 8 }}
      >
        {/* A plain anchor with `download` — the browser's own save, straight from the object URL the
            thread is already using. No re-fetch, no re-decrypt, no second URL.
            KNOWN LIMITATION: iOS Safari has historically ignored `download` for blob: URLs and may
            open the image in a new tab instead. Long-press → Save Image still works there. */}
        <a
          className="cv-lightbox-btn"
          href={url}
          download={filename}
          onClick={e => e.stopPropagation()}
          style={{ ...GHOST, gap: 7, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M12 15l-4-4M12 15l4-4" /><path d="M4 21h16" /></svg>
          Download
        </a>
        <button
          className="cv-lightbox-btn"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close image"
          style={{ ...GHOST, width: 33, height: 33, padding: 0 }}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {/* The image and its footer as ONE shrink-wrapping column, so the footer is exactly as wide as
          the picture — the alignment §9A draws.
          ASPECT-RATIO IS DOING REAL WORK HERE, not decoration. The image shrinks on the main axis to
          fit the height left over; without a ratio its auto width would stay at the intrinsic size
          and object-fit would letterbox inside an oversized element box, leaving the footer wider
          than the visible picture. With a ratio, a shrunk height drives the width, so the element
          box always equals the painted box and this column tracks it. Refs carrying no dimensions
          fall back to object-fit. */}
      <div
        onClick={e => e.stopPropagation()}
        style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0, maxWidth: '100%', maxHeight: '100%' }}
      >
        <img
          src={url}
          alt={caption || 'Image attachment'}
          style={{
            display: 'block', flex: '0 1 auto', minHeight: 0,
            width: 'auto', maxWidth: '100%', objectFit: 'contain',
            aspectRatio: width > 0 && height > 0 ? `${width} / ${height}` : undefined,
            borderRadius: 12, boxShadow: '0 24px 64px -16px rgba(0,0,0,0.7)',
          }}
        />
        {/* `width: 0` keeps this row out of the column's max-content width — otherwise a long
            filename, not the picture, would decide how wide the column is — and `minWidth: 100%`
            then stretches it back across whatever width the image settled on. */}
        <div style={{ width: 0, minWidth: '100%', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filename}</span>
            <span style={{ flexShrink: 0, fontSize: 11.5, color: META_INK }}>{metaLine(size, timestamp)}</span>
          </div>
          {/* §9A draws no caption slot, but a Caravel image can carry one and it is the sender's
              own words — it stays, subordinate to the filename row above it. */}
          {caption && (
            <div style={{ marginTop: 10, fontSize: 13.5, color: '#A3B4C8', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{caption}</div>
          )}
        </div>
      </div>
    </div>
  )
}
