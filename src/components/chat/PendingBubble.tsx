// The provisional outgoing bubble, shared by the DM and group views: a message that has been
// composed and is either still in flight ("Sending") or has failed with a Retry affordance.
//
// SINGLE SOURCE OF TRUTH ON PURPOSE, same reasoning as useScrollToBottom: this markup lived inline
// in the DM view only, which is why group sends had no optimistic bubble and no failure UI at all.
// Two copies of 25 lines of bubble markup would drift.
//
// Deliberately NOT folded into MessageBubble: that component renders PERSISTED messages
// (received / sent / self) and is keyed off a real CaravelMessage. This one renders a local,
// pre-persistence UI state that has no message id and no timestamp yet. Different lifecycles.

import { MONO } from './chatDisplay'

export type PendingStatus = 'sending' | 'failed'

// Stage-specific failure copy. Absent for a plain text send, which keeps the original defaults.
//
// Images need this because "Couldn't send" is not enough information to act on: failing to DECODE a
// photo, failing to UPLOAD it, and failing to publish the message are three different problems with
// three different responses, and only some of them are worth retrying.
export interface PendingFailure {
  label: string          // short, red — what went wrong
  hint: string | null    // muted line beneath — what the user can do about it, or null
  retryable: boolean     // false hides Retry entirely, rather than offering a button that can't work
}

// A composed message awaiting (or having failed) its send. `id` is local-only — never an event id.
export interface PendingSend {
  id: string
  text: string
  status: PendingStatus
  // When the send was attempted, so the bubble can sit in CHRONOLOGICAL position rather than being
  // pinned to the end of the thread. At the moment of failure those are the same place — this row is
  // the newest thing there is. They only diverge once the user sends or receives something later, at
  // which point the bubble is a historical record and claiming to be newest is simply wrong.
  attemptedAt: number
  failure?: PendingFailure
}

export default function PendingBubble({ text, status, onRetry, onDismiss, failure }: {
  text: string
  status: PendingStatus
  // Omitted when a retry would be unsafe. In groups a partial fan-out is NOT retryable — members
  // who already received the message have no way to dedup a second copy (fresh event ids per send),
  // so Retry is offered only when the send reached nobody.
  onRetry?: () => void
  // Clears the failed bubble. THE ONLY DELIBERATE WAY OUT, and the only one for a terminal failure
  // (an undecodable image shows no Retry at all, so without this the bubble was permanent).
  //
  // Deliberately explicit rather than auto-clearing on a timer or on the next successful send: an
  // error that disappears by itself is worse than one that lingers — look away for ten seconds and
  // the send silently never happened — and a later success has nothing to do with an earlier
  // failure. Matches the failed-edit row on the message-editing branch, so the two converge.
  onDismiss?: () => void
  // Present for image sends. Absent → the text-send defaults below, unchanged.
  failure?: PendingFailure
}) {
  const label = failure?.label ?? 'Couldn’t send'
  // The default hint is only true for a TEXT send — a failed image has nothing in the composer, so
  // an image failure passes its own hint (or null).
  const hint = failure ? failure.hint : 'Your text is kept in the composer.'
  const showRetry = !!onRetry && (failure ? failure.retryable : true)
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '62%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      {status === 'sending' ? (
        <>
          {/* THE ACCENT, HELD BACK. This bubble becomes a solid --msg-sent the moment the send is
              acknowledged, so "sending" has to read as the same colour not yet arrived at rather
              than as a different thing — a translucent accent does that and a neutral grey does
              not. It was a teal gradient until V3; the foundation allows no gradient on the brand,
              and teal is not the brand any more. Stage 3 settles the bubble's shape. */}
          <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'rgba(var(--accent-400-rgb),0.55)', color: 'var(--text-note)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted-dim)', marginTop: 6, marginRight: 4 }}>
            <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.2)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />Sending
          </div>
        </>
      ) : (
        <>
          <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'rgba(var(--danger-rgb),0.06)', border: '1px solid rgba(var(--danger-rgb),0.34)', color: 'var(--text-body)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7, marginRight: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--danger-300)' }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth={2.4} strokeLinecap="round"><circle cx={12} cy={12} r={9} /><path d="M12 8v5M12 16h.01" /></svg>{label}
            </span>
            {showRetry && onRetry && (
              <span onClick={onRetry} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)', fontSize: 11, fontWeight: 700, color: 'var(--danger-300)', cursor: 'pointer' }}>
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--danger-300)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>Retry
              </span>
            )}
            {onDismiss && (
              <span onClick={onDismiss} style={{ fontSize: 11, color: 'var(--text-muted-dim)', cursor: 'pointer' }}>Dismiss</span>
            )}
          </div>
          {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, marginRight: 4, maxWidth: 280, textAlign: 'right', lineHeight: 1.45 }}>{hint}</div>}
        </>
      )}
    </div>
  )
}
