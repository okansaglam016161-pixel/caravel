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
  failure?: PendingFailure
}

export default function PendingBubble({ text, status, onRetry, failure }: {
  text: string
  status: PendingStatus
  // Omitted when a retry would be unsafe. In groups a partial fan-out is NOT retryable — members
  // who already received the message have no way to dedup a second copy (fresh event ids per send),
  // so Retry is offered only when the send reached nobody.
  onRetry?: () => void
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
          <div style={{ padding: '13px 17px', borderRadius: '16px 4px 16px 16px', background: 'linear-gradient(160deg, rgba(28,122,110,0.55), rgba(18,101,90,0.55))', color: 'var(--text-note)', fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
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
          </div>
          {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, marginRight: 4, maxWidth: 280, textAlign: 'right', lineHeight: 1.45 }}>{hint}</div>}
        </>
      )}
    </div>
  )
}
