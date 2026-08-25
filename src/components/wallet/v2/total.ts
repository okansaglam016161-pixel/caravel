// The combined balance, and the rules for when we are allowed to show one.
//
// ── SUMMING IS VALID, AND THAT WAS NOT OBVIOUS ────────────────────────────────
//
// Private and public TARI are the SAME resource — verified on-chain: the account vault holds
// `Stealth { address: resource_0101…0101, revealed_amount }` and the stealth UTXOs carry the same
// resource hex, at the same divisibility of 6. So a total is a real quantity, exactly 1:1, not an
// invented aggregate. Earlier milestones deliberately never summed them, but that was a clarity
// choice about hierarchy, not a protocol constraint.
//
// ── THE ONLY RULE THAT MATTERS: NEVER A CONFIDENT WRONG NUMBER ────────────────
//
// The two balances do not fail the same way, and neither failure is visible in the arithmetic:
//
//   * The private scan can be INCOMPLETE. walletScanner sets `incomplete` when the indexer returns
//     a full page, meaning there may be outputs it could not see — so the figure is a LOWER BOUND,
//     not a balance. Summing a lower bound produces a total that is quietly too small.
//   * The public read can be UNAVAILABLE. That is "we do not know", deliberately distinct from
//     zero — collapsing them would tell someone they have nothing when they may have a great deal.
//
// A total computed across either of those is wrong while looking authoritative, which is the one
// outcome worth engineering against. So the total degrades to `unreadable`, and — this is the part
// that makes it useful rather than merely safe — THE BREAKDOWN BENEATH STAYS. Each side keeps its
// own state, so a user seeing "—" can look one line down and see which half is the problem.
//
// ── "UPDATING" AND "—" ARE DIFFERENT CLAIMS ──────────────────────────────────
//
// Both are non-numbers, and conflating them is the subtle failure this file exists to prevent:
//
//   updating…   something IS in flight. A move committed and the index is catching up; a correct
//               number is coming on its own.
//   —           nothing is pending. We simply cannot read one side, and no amount of waiting
//               fixes it. There may be an action to take (retry, refresh).
//
// Showing "updating…" over an unreadable balance promises a number that will never arrive. So
// UNREADABLE WINS over settling: a definite failure outranks work in progress.

/** What either balance can be — mirrors the shipped ScanState / RevealedState split. */
export type BalanceStatus =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; microtari: bigint }

export interface TotalInputs {
  privateBalance: BalanceStatus
  /** walletScanner's `incomplete` — the private figure is a lower bound, not a balance. */
  privateIncomplete: boolean
  publicBalance: BalanceStatus
  /** A move is committed and the index is catching up (the useBalanceSettle window). */
  settling: boolean
}

export type TotalUnreadableReason =
  | 'private-unavailable'
  | 'public-unavailable'
  | 'both-unavailable'
  | 'private-incomplete'

export type TotalView =
  /** Both sides read cleanly. The only state that shows a number as fact. */
  | { status: 'ready'; microtari: bigint }
  /**
   * Something is in flight. `microtari` is whatever we can still compute — usually `null`, because
   * a settle triggers a rescan and the reads go back to loading while it runs.
   */
  | { status: 'settling'; microtari: bigint | null }
  /** No value yet, and nothing wrong — a first read in progress. */
  | { status: 'loading' }
  /** We cannot give a confident number. `reason` says which side, for the copy. */
  | { status: 'unreadable'; reason: TotalUnreadableReason }

/**
 * Decide what the total may claim, from the same flags the two reads already expose.
 *
 * PRECEDENCE, and why it is this order:
 *   1. unreadable — a definite failure. Outranks everything, including work in flight, because
 *      "updating…" over an unreadable side promises a number that is not coming.
 *   2. settling   — in flight; a correct number arrives on its own.
 *   3. loading    — a first read, nothing known yet.
 *   4. ready      — both sides clean.
 *
 * INCOMPLETE IS TREATED AS UNREADABLE, not as a caveated number. A lower bound rendered as a total
 * is the confident-wrong-number case in its purest form: it is plausible, specific, and too small.
 */
export function computeTotal(input: TotalInputs): TotalView {
  const { privateBalance, publicBalance, privateIncomplete, settling } = input

  const privateOut = privateBalance.status === 'unavailable'
  const publicOut = publicBalance.status === 'unavailable'

  if (privateOut && publicOut) return { status: 'unreadable', reason: 'both-unavailable' }
  if (privateOut) return { status: 'unreadable', reason: 'private-unavailable' }
  if (publicOut) return { status: 'unreadable', reason: 'public-unavailable' }

  // Only meaningful once the scan has actually produced a figure — a scan still running has not
  // yet claimed anything, complete or otherwise.
  if (privateIncomplete && privateBalance.status === 'ready') {
    return { status: 'unreadable', reason: 'private-incomplete' }
  }

  const sum = privateBalance.status === 'ready' && publicBalance.status === 'ready'
    ? privateBalance.microtari + publicBalance.microtari   // BIGINT. Never Number().
    : null

  if (settling) return { status: 'settling', microtari: sum }
  if (sum === null) return { status: 'loading' }
  return { status: 'ready', microtari: sum }
}

/**
 * One sentence explaining a `—`, for the tap/hover.
 *
 * Says which side and what to do about it. "Unavailable" alone would leave the user with a dash and
 * no next step, which is most of the way back to just showing a wrong number.
 */
export function unreadableReasonText(reason: TotalUnreadableReason): string {
  switch (reason) {
    case 'both-unavailable':
      return 'Neither balance could be read just now, so there’s no total to show. Tap Refresh to try again.'
    case 'private-unavailable':
      return 'Your private balance couldn’t be read, so the total isn’t known. Your public balance below is unaffected.'
    case 'public-unavailable':
      return 'Your public balance couldn’t be read, so the total isn’t known. Your private balance below is unaffected.'
    case 'private-incomplete':
      return 'We couldn’t read all of your private balance, so a total would be too low. The figures below are what we can see.'
  }
}
