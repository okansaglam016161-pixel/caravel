// Search over the curated emoji set (B) — pure, so the picker's one piece of real logic is testable
// without a component harness (there is none in the tree; see MessageBubble, which has no test
// either). The sibling of composerInsert.ts.

import type { EmojiEntry } from './emojiData'

// Substring match over KEYWORDS ONLY, plus an exact match on the character itself so that pasting
// or typing an emoji into the box finds it.
//
// Deliberately a single trimmed term rather than an AND over whitespace-separated words: keywords
// are single words, so a multi-word query would have to match a keyword PAIR to mean anything, and
// the almost-working version of that ("red heart" silently matching nothing) is worse than a plain,
// predictable substring. If multi-term search is ever wanted it should come with phrase keywords,
// not with a splitter bolted on here.
//
// RANKED, in two bands: entries whose keyword STARTS WITH the query come before entries that merely
// contain it, each band keeping the curated order. That is what puts 👍 ('thumbsup') at the front
// for "thu" instead of leaving it behind whatever happens to be listed first. The sort is stable in
// every engine that matters (Array.prototype.sort has been required to be stable since ES2019), so
// the curated order really is the tiebreak rather than an accident.
//
// An EMPTY query returns everything, in curated order — the picker shows its categories then.
export function searchEmoji(all: readonly EmojiEntry[], query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...all]

  const prefix: EmojiEntry[] = []
  const contains: EmojiEntry[] = []
  for (const e of all) {
    if (e.char === q || e.char === query.trim()) { prefix.push(e); continue }
    if (e.keywords.some(k => k.startsWith(q))) { prefix.push(e); continue }
    if (e.keywords.some(k => k.includes(q))) contains.push(e)
  }
  return [...prefix, ...contains]
}
