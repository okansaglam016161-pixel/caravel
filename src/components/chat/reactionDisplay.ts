// Pure logic for the reactions UI (C) — the sibling of replyCompose.ts / messageEdit.ts, and kept
// out of the two chat views for the same reason: the DM thread and the group thread render the same
// pills from the same rows, and a rule that lives in render drifts. Nothing here touches React, the
// store or the wire.

import type { CaravelMessage, ReactionEntry } from '../../messaging/types'
import { MAX_LIVE_REACTIONS_PER_REACTOR } from '../../messaging/messageStore'

// Which rows offer the React affordance. NOT mine-only — reacting to someone else's message is the
// whole point — which it shares with canReplyTo and not with canEditMessage:
//   !system           — a group-leave notice has no content to react to; its text is composed at
//                       render time from the sender's name.
//   logicalId present — a reaction travels as a LOGICAL id, so a message sent before M2 has no
//                       handle one could name. Ages out on its own; the affordance is simply absent.
//   !payment / !media — text only in v1. Both render as their own cards, which have nowhere to draw
//                       a pill, so the applier refuses reactions on them too (isReactableTarget).
//                       Enforcing it on both sides is deliberate: this is the predicate half.
//
// DELIBERATELY A SEPARATE FUNCTION FROM canReplyTo, despite matching it clause for clause (F18).
// The clauses agree today for DIFFERENT reasons — a reply excludes media because quoting an image
// wants a thumbnail rather than a text snippet, a reaction excludes it because MediaMessageCard has
// no pill slot — and collapsing them into one predicate would erase both rationales into whichever
// comment survived. They are free to diverge; a shared function would have to be unpicked first.
export function canReactTo(m: CaravelMessage): boolean {
  return !m.system
    && !!m.logicalId
    && !m.payment
    && !m.media
}

// One emoji's worth of pill: how many people used it, whether I am one of them, and who they are.
export interface ReactionSummary {
  emoji: string
  count: number
  mine: boolean
  // Reactor pubkeys, in the same stable order the count was taken in. The CALL SITE turns these
  // into names — a group thread has nameFor, a DM does not, and neither concern belongs in here or
  // in MessageBubble.
  who: string[]
}

// Live rows only, oldest first. `at` is a LOCAL clock (see ReactionEntry), so this orders by when
// THIS device saw each reaction — which is what a reader expects from a pill strip, and is
// presentation rather than truth. The emoji tiebreak keeps the order total, so a render never
// depends on the array's incidental storage order.
function liveSorted(rows: readonly ReactionEntry[]): ReactionEntry[] {
  return rows
    .filter(r => !r.removed)
    .slice()
    .sort((a, b) => (a.at - b.at) || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0))
}

// Roll a message's reaction rows up into the pills to draw.
//
// TWO FILTERS, both of which the applier already enforces, applied again here on purpose:
//   - `removed` rows are dropped. They are retained in storage forever so the seq high-water
//     survives (ReactionEntry), and they must never be drawn.
//   - each person is capped at MAX_LIVE_REACTIONS_PER_REACTOR live reactions, keeping their
//     EARLIEST under the sort above. applyReactionByLogicalId tombstones a third before it is ever
//     stored, so this cannot normally fire; it is here so that a row written by some future or
//     misbehaving version still renders within the rule instead of silently widening the strip.
//     Deterministic rather than "whichever two came first in the array", which is why the sort is
//     total — but `at` is a local clock, so two devices holding the same rows agree on the count
//     and may disagree on which two a third-reaction outlier lost (F2, and only in that case).
export function aggregateReactions(m: CaravelMessage, mePubkeyHex: string): ReactionSummary[] {
  if (!m.reactions || m.reactions.length === 0) return []

  const perReactor = new Map<string, ReactionEntry[]>()
  for (const r of liveSorted(m.reactions)) {
    const held = perReactor.get(r.by)
    if (!held) { perReactor.set(r.by, [r]); continue }
    if (held.length < MAX_LIVE_REACTIONS_PER_REACTOR) held.push(r)
  }

  // Group by emoji, keeping first-seen emoji order so the strip is stable as counts change: a pill
  // must not jump position because somebody else joined it.
  const byEmoji = new Map<string, ReactionSummary>()
  for (const r of [...perReactor.values()].flat().sort((a, b) => (a.at - b.at) || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0))) {
    const found = byEmoji.get(r.emoji)
    if (found) {
      found.count++
      found.who.push(r.by)
      if (r.by === mePubkeyHex) found.mine = true
      continue
    }
    byEmoji.set(r.emoji, { emoji: r.emoji, count: 1, mine: r.by === mePubkeyHex, who: [r.by] })
  }
  return [...byEmoji.values()]
}

// The emoji I currently hold on a message, live only. Drives the quick-set: which buttons read as
// already-picked, and whether a NEW one would exceed the allowance.
export function myReactions(m: CaravelMessage, mePubkeyHex: string): string[] {
  if (!m.reactions) return []
  return liveSorted(m.reactions).filter(r => r.by === mePubkeyHex).slice(0, MAX_LIVE_REACTIONS_PER_REACTOR).map(r => r.emoji)
}

// Am I already holding my full allowance on this message? The quick-set greys out everything I am
// NOT already holding when this is true, so the limit is visible up front rather than a silent
// refusal after a round trip.
//
// The "not already holding" half is deliberately left to the caller rather than folded in as
// reactionBlocked(message, me, emoji): the popover has to make that distinction per BUTTON anyway
// (a held emoji stays live, because tapping it removes rather than adds a third), so a per-emoji
// predicate here would be computed once and then re-derived six times.
export function atReactionLimit(m: CaravelMessage, mePubkeyHex: string): boolean {
  return myReactions(m, mePubkeyHex).length >= MAX_LIVE_REACTIONS_PER_REACTOR
}
