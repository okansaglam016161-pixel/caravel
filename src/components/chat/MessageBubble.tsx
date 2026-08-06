// The text message bubble shared by DM + group views. Reproduces the DM markup EXACTLY for all
// three variants (received / sent / notes-to-self). `senderHeader` is a group-only addition (an
// avatar gutter + sender label above the bubble, with a 'continuation' mode for grouped runs) and
// is never passed by the DM view — so a DM bubble renders byte-identically to before.

import type { ReactNode } from 'react'
import { bubbleTime, MONO } from './chatDisplay'

export type SenderHeader = { avatar: ReactNode; label: string } | 'continuation'

export default function MessageBubble({ text, timestamp, variant, senderHeader }: {
  text: string
  timestamp: number
  variant: 'received' | 'sent' | 'self'
  senderHeader?: SenderHeader   // group received only; undefined for every DM bubble
}) {
  // Outgoing (right, teal, timestamp + delivered check).
  if (variant === 'sent') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'var(--msg-sent)', color: 'var(--text-bright)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 6, marginRight: 4 }}>
          {bubbleTime(timestamp)}
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
        </div>
      </div>
    )
  }

  // Notes-to-self (right, rounded, bordered, no timestamp — matches DM verbatim).
  if (variant === 'self') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '62%' }}>
        <div style={{ padding: '13px 17px', borderRadius: 14, background: 'var(--surface-inset)', border: '1px solid rgba(var(--border-rgb),0.14)', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
      </div>
    )
  }

  // Incoming (left, timestamp below-left). The bubble + timestamp are identical whether or not a
  // sender header is present.
  const bubble = (
    <>
      <div style={{ padding: '13px 17px', borderRadius: '4px 16px 16px 16px', background: 'var(--surface-inset)', border: 'none', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)', marginTop: 5, marginLeft: 4 }}>{bubbleTime(timestamp)}</div>
    </>
  )

  // DM received — byte-identical to the previous inline markup.
  if (!senderHeader) {
    return <div style={{ alignSelf: 'flex-start', maxWidth: '62%' }}>{bubble}</div>
  }

  // Group received (Stage 2): avatar gutter + sender label; a 'continuation' aligns without them.
  const cont = senderHeader === 'continuation'
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '72%', display: 'flex', gap: 8 }}>
      <div style={{ width: 28, flexShrink: 0 }}>{!cont && senderHeader.avatar}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        {!cont && <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: 'var(--text-teal-dim)', marginBottom: 3, marginLeft: 4 }}>{senderHeader.label}</div>}
        {bubble}
      </div>
    </div>
  )
}
