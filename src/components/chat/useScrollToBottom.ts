// Shared thread auto-scroll: keep the newest message in view, in DM and group threads alike.
//
// SINGLE SOURCE OF TRUTH ON PURPOSE. This started as five inline lines in the DM view that the
// group thread never got, so groups silently didn't scroll. Two paths implementing one behaviour
// is the same shape as the publish/subscribe connect-budget drift — the fix there was one shared
// constant, and the fix here is one shared hook. Any future refinement (e.g. "don't yank the view
// when the user has scrolled up to read history" — deliberately NOT implemented today, because the
// DM view has never done it) lands here once and applies to both.
//
// Returns the ref for a bare anchor element that must be rendered as the LAST child of the
// scrolling container:  <div ref={bottomRef} />

import { useEffect, useRef, type RefObject } from 'react'

// `threadKey` identifies the open thread (peer hex or group id) — changing it re-fires, which is
// what puts a freshly-opened thread at the bottom. Neither view remounts on switch, so this cannot
// rely on mount alone.
//
// `contentKey` re-fires whenever the thread's rendered content could have grown — on send, on
// receive, and (crucially) across the swap of a provisional bubble for the real row. It is a STRING
// rather than the message count it used to be: a count is unchanged across that swap, which left
// image sends short of the bottom by the difference between a filename bubble and a media card. See
// threadContentKey in chatDisplay for the full reasoning; both call sites build it from there so the
// two views cannot drift.
//
// Scalars rather than a deps array: it keeps exhaustive-deps satisfied at the call sites and makes
// the two triggers explicit.
export function useScrollToBottom(threadKey: string | null, contentKey: string): RefObject<HTMLDivElement | null> {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [threadKey, contentKey])
  return bottomRef
}
