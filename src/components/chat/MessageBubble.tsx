// The text message bubble shared by DM + group views. Reproduces the DM markup EXACTLY for all
// three variants (received / sent / notes-to-self). `senderHeader` is a group-only addition (an
// avatar gutter + sender label above the bubble, with a 'continuation' mode for grouped runs) and
// is never passed by the DM view — so a DM bubble renders byte-identically to before.
//
// EDIT SUPPORT (M3) adds three optional props — `edited`, `actions`, `highlighted`. All are opt-in,
// so a call site that passes none renders exactly as it did before editing existed. M4 wired the
// group sites up too: a sent group bubble now passes all three and a received one passes `edited`,
// with the SAME markup as the DM thread, so an edit reads identically wherever it appears.
//
// `actions` renders INSIDE this component rather than in a wrapper on purpose. The sent/self roots
// carry alignSelf:'flex-end'; wrapping them in a flex row outside would silently reinterpret that
// as VERTICAL alignment. Keeping every alignment decision in one file avoids that class of bug.
//
// The `cv-msg-actionrow` class below is the HOVER TARGET for the affordances: the reveal rules
// (.cv-msg-actionrow:hover .cv-msg-react, and its siblings) live in index.css, global, because both
// chat views mount this component and they never mount at the same time.
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

export default function MessageBubble({ text, timestamp, variant, senderHeader, edited, actions, highlighted, quoted, lid, flashed, reactions }: {
  text: string
  timestamp: number
  variant: 'received' | 'sent' | 'self'
  senderHeader?: SenderHeader   // group received only; undefined for every DM bubble
  edited?: boolean              // renders the "edited" suffix in the meta row
  actions?: ReactNode           // hover affordance (M3: the Edit pencil, replies: the Reply arrow)
  highlighted?: boolean         // this bubble is the one being edited (persistent ring)
  quoted?: ReactNode            // replies v1: the quoted-original preview, rendered ABOVE the text
  // TAP-TO-JUMP (replies v1). `lid` is the jump ANCHOR — set on the bubble box itself rather than on
  // a wrapper, because the sent/self roots carry alignSelf and an outer wrapper would reinterpret it
  // (the same trap the `actions` note above describes). `flashed` is TRANSIENT and separate from
  // `highlighted` on purpose: one is "you landed here", the other is "this is loaded in the composer".
  lid?: string
  flashed?: boolean
  // REACTIONS (C): the pill strip, prebuilt by the call site exactly as `quoted` and `actions` are.
  // It arrives as a node rather than as data because a group tooltip needs display names and a DM's
  // does not — neither the store nor nameFor belongs in this component.
  //
  // WHERE IT GOES, and why it is three separate insertions rather than one wrapper:
  //   - OUTSIDE the `data-lid` box. That box is the jump anchor and carries the flash ring, so
  //     pills inside it would be ringed on a tap-to-jump and would enlarge the target.
  //   - NOT in a wrapper around the roots. The sent/self roots carry alignSelf:'flex-end', which an
  //     outer flex row would silently reinterpret as VERTICAL alignment — the same trap the
  //     `actions` note above describes.
  //   So it is a sibling of the action row inside each root's existing column, between the row and
  //   the meta line. Alignment then falls out of the roots for free: the sent/self column already
  //   sets alignItems:'flex-end', and the received markup is block-flow, so the strip sits left.
  // There are FOUR bubble paths but only THREE insertions: the DM-received and group-received paths
  // share the `bubble` fragment below.
  reactions?: ReactNode
}) {
  // The flash ring must contrast with the bubble it lands on, exactly as the quote panel does. The
  // 'sent' variant is the ONLY teal-filled message surface (--msg-sent), so it takes the light ring;
  // 'self' and 'received' are both dark inset surfaces and keep the teal one. Decided here rather
  // than via a prop because `variant` is already in scope — unlike `quoted`, which arrives as a
  // built node and so has to be told its tone by the call site.
  const flashClass = flashed ? (variant === 'sent' ? 'cv-msg-flash-light' : 'cv-msg-flash') : undefined
  // Outgoing (right, teal, timestamp + delivered check).
  if (variant === 'sent') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <div className={actions ? 'cv-msg-actionrow' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {actions}
          <div data-lid={lid} className={flashClass} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', minWidth: 0, padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'var(--msg-sent)', color: 'var(--text-bright)', fontSize: 15, lineHeight: 1.5, boxShadow: highlighted ? EDIT_RING : undefined }}>
            {quoted}
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 }}>{text}</span>
          </div>
        </div>
        {reactions}
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
          <div data-lid={lid} className={flashClass} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', minWidth: 0, padding: '13px 17px', borderRadius: 14, background: 'var(--surface-inset)', border: '1px solid rgba(var(--border-rgb),0.14)', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, boxShadow: highlighted ? EDIT_RING : undefined }}>
            {quoted}
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 }}>{text}</span>
          </div>
        </div>
        {reactions}
        {edited && (
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 6, marginRight: 4 }}><EditedTag /></div>
        )}
      </div>
    )
  }

  // Incoming (left, timestamp below-left). The bubble + timestamp are identical whether or not a
  // sender header is present.
  //
  // The ACTION ROW is a replies-v1 addition here. Received bubbles never had one — edit is
  // mine-only, so there was no affordance to hang on someone else's message — but Reply is not
  // authorship-gated, so the row now exists on both sides. It MIRRORS the sent layout: the button
  // sits outboard of the bubble, on the side away from the thread edge, which puts it on the RIGHT
  // for a left-aligned bubble and the LEFT for a right-aligned one.
  const bubble = (
    <>
      <div className={actions ? 'cv-msg-actionrow' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div data-lid={lid} className={flashClass} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', minWidth: 0, padding: '13px 17px', borderRadius: '4px 16px 16px 16px', background: 'var(--surface-inset)', border: 'none', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, boxShadow: highlighted ? EDIT_RING : undefined }}>
          {quoted}
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 }}>{text}</span>
        </div>
        {actions}
      </div>
      {reactions}
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
