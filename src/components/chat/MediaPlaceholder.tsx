// Placeholder for an encrypted image attachment (images M3).
//
// A DELIBERATE STOPGAP, to be replaced wholesale — not extended — by the resolver milestone. It
// fetches nothing, decrypts nothing and caches nothing. It exists because the wire landed before the
// renderer, and without it a media message would be a BLANK BUBBLE: a captionless image sends a
// single space (the NIP-44 one-byte floor), which renders as an empty bubble that reads as a bug
// rather than as an image waiting to load.
//
// Its own file rather than living in ChatApp because BOTH threads need it — a group image would be
// just as blank in GroupThread. Same reason MessageBubble and PendingBubble are shared.
//
// The box is sized from the ref's own width/height, so when the resolver replaces this the image
// drops into exactly the space already reserved and the thread does not jump.

import type { CaravelMessage } from '../../messaging/types'
import { bubbleTime, MONO } from './chatDisplay'

export default function MediaPlaceholder({ message }: { message: CaravelMessage }) {
  const media = message.media
  if (!media) return null
  const sent = message.direction === 'sent'
  const caption = message.plaintext.trim()
  // Keep the aspect ratio; fall back to 4:3 for a ref carrying no dimensions (extractMedia lets a
  // partially-valid ref through, defaulting the non-load-bearing fields).
  const ratio = media.width > 0 && media.height > 0 ? media.height / media.width : 0.75
  const width = Math.min(280, media.width || 280)

  return (
    <div style={{ alignSelf: sent ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
      <div style={{
        width, height: Math.round(width * ratio), maxHeight: 320,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
        borderRadius: 14, border: '1.5px dashed rgba(var(--border-rgb),0.3)', background: 'var(--surface-inset)',
      }}>
        <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="var(--text-faint-dim)" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <rect x={3} y={3} width={18} height={18} rx={2} /><circle cx={8.5} cy={8.5} r={1.5} /><path d="M21 15l-5-5L5 21" />
        </svg>
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)' }}>Image · not yet displayed</span>
      </div>
      {caption && (
        <div style={{ marginTop: 6, fontSize: 14, color: 'var(--text-body)', wordBreak: 'break-word' }}>{caption}</div>
      )}
      <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)', marginTop: 5 }}>{bubbleTime(message.timestamp)}</div>
    </div>
  )
}
