// Every word the move flow says that differs by direction.
//
// ── WHY THIS FILE IS TWO WORDS LONG ──────────────────────────────────────────
//
// This flow shipped a bug once where the success screen read "Now shielded" after an unshield —
// the wallet telling someone the OPPOSITE of what had just happened to their privacy. The fix at
// the time was a per-direction copy table, which stopped the two branches drifting but still wrote
// each direction's words out by hand, twice, in adjacent object literals. Two literals that must
// mirror each other is exactly the shape that produced the bug.
//
// So the table now holds only the two nouns, and every sentence is DERIVED from them:
//
//     conceal → { from: 'public',  to: 'private' }
//     reveal  → { from: 'private', to: 'public'  }
//
// "Now private" is `Now ${to}`. "Make public" is `Make ${to}`. "Available private" is
// `Available ${from}`. There is no second place where a direction's words are spelled out, so a
// success screen CANNOT say "Now private" after a make-public: it reads the same `to` the header,
// the button, the direction row and the confirmation all read. Swapping them would require
// swapping the source and destination of the move itself.
//
// ── IT IS A .ts, DELIBERATELY ────────────────────────────────────────────────
//
// Vitest collects `src/**/*.test.ts`. Keeping this out of move.tsx means the direction invariants
// can be tested as plain data, with no JSX and no renderer — see moveCopy.test.ts.

export type Dir = 'conceal' | 'reveal'

/**
 * The only place a direction is written down.
 *
 * `conceal` and `reveal` keep the names the crypto layer uses — those are the transaction builders'
 * words and are not a presentation concern. What the USER sees is private and public, and that
 * mapping lives here and nowhere else.
 */
export const DIR = {
  conceal: { from: 'public', to: 'private' },
  reveal: { from: 'private', to: 'public' },
} as const

/** The sheet header, and the confirm button: "Make private" / "Make public". */
export const moveTitle = (d: Dir): string => `Make ${DIR[d].to}`

/** Under the header: "Move public funds into your private balance." */
export const moveBlurb = (d: Dir): string => `Move ${DIR[d].from} funds into your ${DIR[d].to} balance.`

/** Beside the amount field: "Available public". Names the SOURCE — what can be moved. */
export const moveAvailLabel = (d: Dir): string => `Available ${DIR[d].from}`

/** The review row: "To private". */
export const moveDirectionRow = (d: Dir): string => `To ${DIR[d].to}`

/**
 * The success headline: "Now private" / "Now public".
 *
 * THE STRING THE OLD BUG GOT WRONG. It is `to` and nothing else, so it is right whenever the move
 * that ran is the move being reported.
 */
export const moveDone = (d: Dir): string => `Now ${DIR[d].to}`

/** The success sub-line's tail: "moved to your private balance". */
export const moveMovedTo = (d: Dir): string => `moved to your ${DIR[d].to} balance`

/** The moving sub-line's tail: "to private". */
export const moveMovingTo = (d: Dir): string => `to ${DIR[d].to}`
