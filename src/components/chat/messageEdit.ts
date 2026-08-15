// Pure logic for the per-message edit UI (M3) — kept out of ChatApp so the rules are testable
// rather than tangled in render. Nothing here touches React, the store, or the wire.
//
// The optimistic layer lives here too. WalletContext.editMessage deliberately updates the store
// only once a relay has ACCEPTED the edit (M2), so between Save and that acceptance there is
// nothing in `messages` to render. An in-flight map covers exactly that window: it holds the new
// text while the publish is outstanding, and the bubble falls back to the stored text the moment
// the flight settles — on success because the store now has the same text, on failure because the
// edit never left the device and the bubble must SNAP BACK rather than keep showing a lie.

import type { CaravelMessage } from '../../messaging/types'

export type EditFlightStatus = 'saving' | 'failed'

export interface EditFlight {
  text: string
  status: EditFlightStatus
}

// logicalId → flight. Keyed by logical id, not message id, because that is the handle the wire and
// WalletContext.editMessage both use.
export type EditFlightMap = Record<string, EditFlight>

// Which rows offer the Edit affordance. MINE-ONLY, and from M4 the same rule for DMs and groups —
// the `!groupId` exclusion is gone, because a group send has minted and carried a shared logicalId
// since M2 and M4 added the fan-out that names it:
//   direction 'sent'  — you can only edit your own message; a peer's row would be refused by the
//                       store's authorship guard anyway, so offering it would be a lie. In a GROUP
//                       this clause is also the security-relevant one: every member legitimately
//                       learns the logicalId of every group message, so this is what stops the UI
//                       ever offering to rewrite another member's bubble (the receive-side
//                       authorship guard in applyEdit independently rejects it on every device).
//   !system           — a group-leave notice has no prose; its text is composed at render time.
//                       Load-bearing from M4: those rows only exist in group threads.
//   logicalId present — messages sent before M2 have no shared handle, so no edit can name them.
//                       This resolves itself as old messages age out; the affordance is simply
//                       absent rather than shown disabled.
//   !payment          — payment rows render as PaymentMessageCard and never reach MessageBubble;
//                       asserted anyway so the rule reads completely in one place.
//
// Not checked here, deliberately: whether the row's GROUP is still active. That is a send-time
// concern with a different answer (WalletContext.editMessage refuses a non-active group), and a
// non-active group's thread is not rendered at all — so there is no bubble to hang this off.
export function canEditMessage(m: CaravelMessage): boolean {
  return m.direction === 'sent'
    && !m.system
    && !!m.logicalId
    && !m.payment
}

// True when the edit is worth sending: non-empty after trimming, and actually different from what
// is already stored. Blocking an unchanged save keeps a no-op from burning a revision number.
export function isEditSubmittable(original: string, next: string): boolean {
  const trimmed = next.trim()
  return trimmed.length > 0 && trimmed !== original.trim()
}

export function beginFlight(map: EditFlightMap, logicalId: string, text: string): EditFlightMap {
  return { ...map, [logicalId]: { text, status: 'saving' } }
}

// Success drops the entry entirely — the store now holds this text, so the stored row is the
// single source of truth again. Failure keeps it, flipped to 'failed', so the row can offer Retry
// with the text the user actually typed.
export function settleFlight(map: EditFlightMap, logicalId: string, ok: boolean): EditFlightMap {
  const flight = map[logicalId]
  if (!flight) return map
  if (ok) {
    const next = { ...map }
    delete next[logicalId]
    return next
  }
  return { ...map, [logicalId]: { text: flight.text, status: 'failed' } }
}

export function clearFlight(map: EditFlightMap, logicalId: string): EditFlightMap {
  if (!map[logicalId]) return map
  const next = { ...map }
  delete next[logicalId]
  return next
}

export function flightFor(m: CaravelMessage, map: EditFlightMap): EditFlight | undefined {
  return m.logicalId ? map[m.logicalId] : undefined
}

// The text to render. Only a SAVING flight overrides the stored text: a failed one must show the
// original again, because that is what both devices actually hold.
export function displayTextFor(m: CaravelMessage, map: EditFlightMap): string {
  const flight = flightFor(m, map)
  return flight?.status === 'saving' ? flight.text : m.plaintext
}
