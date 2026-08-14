// The text message bubble shared by DM + group views. Reproduces the DM markup EXACTLY for all
// three variants (received / sent / notes-to-self). `senderHeader` is a group-only addition (an
// avatar gutter + sender label above the bubble, with a 'continuation' mode for grouped runs) and
// is never passed by the DM view — so a DM bubble renders byte-identically to before.
//
// EDIT SUPPORT (M3) adds three optional props — `edited`, `actions`, `highlighted`. All are opt-in,
// so every existing call site (both GroupThread sites included) renders exactly as it did, and the
// group path cannot show an edit affordance by construction: it simply never passes them.
//
// `actions` renders INSIDE this component rather than in a wrapper on purpose. The sent/self roots
// carry alignSelf:'flex-end'; wrapping them in a flex row outside would silently reinterpret that
// as VERTICAL alignment. Keeping every alignment decision in one file avoids that class of bug.
// Only the markup slot lives here — all edit STATE stays in ChatApp, matching PendingBubble's split.

import type { ReactNode } from 'react'
import { bubbleTime, MONO } from './chatDisplay'

export type SenderHeader = { avatar: ReactNode; label: string } | 'continuation'

// Ring drawn around the bubble currently loaded in the composer, so it is never ambiguous which
// message an edit is about.
const EDIT_RING = '0 0 0 2px rgba(var(--teal-500-rgb),0.55)'

// "edited" suffix for the meta row. Deliberately says nothing about delivery: on the sender's side
// it means the edit was sent from this device, on the recipient's that it arrived. Neither side can
// honestly claim more (best-effort — see MessagingProvider.sendEdit).
function EditedTag() {
  return <span style={{ fontStyle: 'italic' }}>· edited</span>
}

export default function MessageBubble({ text, timestamp, variant, senderHeader, edited, actions, highlighted }: {
  text: string
  timestamp: number
  variant: 'received' | 'sent' | 'self'
  senderHeader?: SenderHeader   // group received only; undefined for every DM bubble
  edited?: boolean              // renders the "edited" suffix in the meta row
  actions?: ReactNode           // hover affordance (M3: the Edit pencil); markup only
  highlighted?: boolean         // this bubble is the one being edited
}) {
  // Outgoing (right, teal, timestamp + delivered check).
  if (variant === 'sent') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <div className={actions ? 'cv-msg-actionrow' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {actions}
          <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'var(--msg-sent)', color: 'var(--text-bright)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', boxShadow: highlighted ? EDIT_RING : undefined, minWidth: 0 }}>{text}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 6, marginRight: 4 }}>
          {bubbleTime(timestamp)}
          {edited && <EditedTag />}
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M18 7l-8 8-4-4" /></svg>
        </div>
      </div>
    )
  }

  // Notes-to-self (right, rounded, bordered, no timestamp — matches DM verbatim).
  // The meta row is added ONLY when edited: the variant has never shown one, and suppressing the
  // label instead would make self-threads the one place an edit leaves no trace.
  if (variant === 'self') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <div className={actions ? 'cv-msg-actionrow' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {actions}
          <div style={{ padding: '13px 17px', borderRadius: 14, background: 'var(--surface-inset)', border: '1px solid rgba(var(--border-rgb),0.14)', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', boxShadow: highlighted ? EDIT_RING : undefined, minWidth: 0 }}>{text}</div>
        </div>
        {edited && (
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 6, marginRight: 4 }}><EditedTag /></div>
        )}
      </div>
    )
  }

  // Incoming (left, timestamp below-left). The bubble + timestamp are identical whether or not a
  // sender header is present.
  const bubble = (
    <>
      <div style={{ padding: '13px 17px', borderRadius: '4px 16px 16px 16px', background: 'var(--surface-inset)', border: 'none', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
      {edited ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)', marginTop: 5, marginLeft: 4 }}>
          {bubbleTime(timestamp)}<EditedTag />
        </div>
      ) : (
        <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)', marginTop: 5, marginLeft: 4 }}>{bubbleTime(timestamp)}</div>
      )}
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
