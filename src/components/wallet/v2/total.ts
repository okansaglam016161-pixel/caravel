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
//
// ── THE GENERATION STAMP, AND WHAT IT ACTUALLY COVERS ───────────────────────
//
// Each balance carries the READ GENERATION that produced it — a counter bumped once per refresh
// and handed to both reads. When the two figures carry different generations they came from
// different refreshes, cannot describe one moment, and are not added.
//
// ── IT LABELS THE REQUEST, NOT THE CHAIN STATE ──────────────────────────────
//
// This is narrower than it first appears, and the correction matters more than the rule. A
// generation says WHICH REFRESH ASKED for a figure. It says nothing about WHICH CHAIN STATE came
// back — and the two reads differ in LAG, not merely in latency: the vault read reflects consensus
// now, while the /utxos listing reflects consensus 60–90 seconds ago. One rescan, both sides
// stamped with the same generation, two different moments in the ledger.
//
// So this rule does NOT catch the case it was written for. Right after a reveal, the fresh public
// figure and the stale private one both come from the same rescan and carry the same stamp; the
// guard passes them, and it was `settling` having to carry no number that finally stopped the
// double-counted total from being drawn.
//
// What it does close, and does close completely, is the HELD-VALUE window. The public row keeps
// showing its previous figure while a new read is in flight, rather than flashing "you have
// nothing" — deliberate, honest staleness for the breakdown. That figure carries the generation it
// was actually read at, so when the scan then completes one generation newer, the pair is caught
// and no total is offered. Nothing else covers that window: no transaction need be pending for it
// to occur, so the settle watches never see it.
//
// Worth keeping for exactly that, and worth not claiming more for.

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
  /** A transaction is committed and the index is catching up (WalletContext's settle window). */
  settling: boolean
  /**
   * A committed transaction of ours passed its deadline and the balances STILL do not reflect it.
   *
   * ── WHY THIS IS UNREADABLE AND NOT SETTLING ──────────────────────────────────
   *
   * Before this existed, a passed deadline flipped `settling` off, and the total went straight to
   * `ready` over the same inconsistent pair it had just spent 150 seconds refusing to add — the
   * wrong figure, now with no spinner and no caption to qualify it. Strictly worse than the bug
   * during the window.
   *
   * It is not `settling` either, and the difference is the one this file exists to protect. Nothing
   * is polling after the deadline, so "a correct number is coming on its own" would be false.
   * Nothing arrives until the user refreshes, which is exactly what `unreadable` is for: no number,
   * a reason, and something to do about it.
   */
  settleLagged: boolean
  /**
   * Which refresh produced each figure — WalletContext's read generation.
   *
   * They are the same number whenever both readings came from the same refresh, and they differ
   * for as long as one side has finished a newer read and the other has not. See the freshness
   * rule below for why that difference is disqualifying rather than merely interesting.
   */
  privateGeneration: number
  publicGeneration: number
}

export type TotalUnreadableReason =
  | 'private-unavailable'
  | 'public-unavailable'
  | 'both-unavailable'
  | 'private-incomplete'
  /** A committed transaction of ours passed its settle deadline and the balances still disagree. */
  | 'settle-lagged'

export type TotalView =
  /** Both sides read cleanly. The only state that shows a number as fact. */
  | { status: 'ready'; microtari: bigint }
  /**
   * Something is in flight, and there is NO NUMBER — deliberately not even an optional one.
   *
   * ── WHY THE FIELD IS GONE RATHER THAN JUST UNSET ─────────────────────────────
   *
   * This variant used to be `{ status: 'settling'; microtari: bigint | null }`, carrying "whatever
   * we can still compute", on the assumption that a settle keeps the reads in `loading` so there
   * would usually be nothing to carry. That assumption was wrong, and the bug it produced is the
   * reason this comment exists: the private scan does not stay loading. It COMPLETES — `done`, not
   * `incomplete`, indistinguishable from any good read — against a listing that still contains the
   * outputs the transaction spent. So a sum was computable for the whole settle window, and both
   * render sites dutifully drew it: a confident 1100.207422 sitting directly above the words
   * "updating after your last move…", for a wallet holding 1050.
   *
   * Settling MEANS the two balances are mid-transition. A total across them is not a rough figure
   * or a provisional one, it is arithmetic on two different moments, and there is no honest way to
   * render it. Removing the field makes that unrepresentable instead of merely unwritten — tsc
   * finds every render site, and no future one can reintroduce the number by accident.
   */
  | { status: 'settling' }
  /** No value yet, and nothing wrong — a first read in progress. */
  | { status: 'loading' }
  /** We cannot give a confident number. `reason` says which side, for the copy. */
  | { status: 'unreadable'; reason: TotalUnreadableReason }

/**
 * Decide what the total may claim, from the same flags the two reads already expose.
 *
 * PRECEDENCE, and why it is this order:
 *   1. unreadable — a definite failure, INCLUDING a lagged settle. Outranks everything, including
 *      work in flight, because "updating…" over a side that is not coming promises a number that
 *      will not arrive.
 *   2. stale pair — the two figures are from different refreshes and cannot be added. Reported as
 *      settling, because the newer read really is on its way.
 *   3. settling   — in flight. NO NUMBER: the balances are mid-transition, so there is nothing
 *      honest to show. This is checked BEFORE the sum, so no total is even computed.
 *   4. loading    — a first read, nothing known yet.
 *   5. ready      — both sides clean, both from the same moment, nothing of ours outstanding.
 *
 * INCOMPLETE IS TREATED AS UNREADABLE, not as a caveated number. A lower bound rendered as a total
 * is the confident-wrong-number case in its purest form: it is plausible, specific, and too small.
 */
export function computeTotal(input: TotalInputs): TotalView {
  const {
    privateBalance, publicBalance, privateIncomplete, settling, settleLagged,
    privateGeneration, publicGeneration,
  } = input

  const privateOut = privateBalance.status === 'unavailable'
  const publicOut = publicBalance.status === 'unavailable'

  // A transaction of ours is missing from these balances and nothing is looking for it any more.
  // Checked with the other definite failures, above everything provisional.
  if (settleLagged) return { status: 'unreadable', reason: 'settle-lagged' }

  if (privateOut && publicOut) return { status: 'unreadable', reason: 'both-unavailable' }
  if (privateOut) return { status: 'unreadable', reason: 'private-unavailable' }
  if (publicOut) return { status: 'unreadable', reason: 'public-unavailable' }

  // Only meaningful once the scan has actually produced a figure — a scan still running has not
  // yet claimed anything, complete or otherwise.
  if (privateIncomplete && privateBalance.status === 'ready') {
    return { status: 'unreadable', reason: 'private-incomplete' }
  }

  // FRESHNESS, before value. Checked here — after the unreadable cases, before any arithmetic —
  // because a mismatch means there is nothing legitimate to compute, not that the computation
  // should be qualified. `sum` below is only ever reached with two figures from one moment.
  if (privateGeneration !== publicGeneration) return { status: 'settling' }

  if (settling) return { status: 'settling' }

  const sum = privateBalance.status === 'ready' && publicBalance.status === 'ready'
    ? privateBalance.microtari + publicBalance.microtari   // BIGINT. Never Number().
    : null

  if (sum === null) return { status: 'loading' }
  return { status: 'ready', microtari: sum }
}

/**
 * One sentence explaining a `—`, for the tap/hover.
 *
 * Says which side and what to do about it. "Unavailable" alone would leave the user with a dash and
 * no next step, which is most of the way back to just showing a wrong number.
 *
 * PRIVATE AND PUBLIC, not shielded and unshielded. These render on the balance hero, directly above
 * a Privacy card whose two rows are labelled Private and Public — so a sentence naming a "shielded
 * balance" would appear to be about some third figure. The words here have to be the words the
 * screen around them uses.
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
    case 'settle-lagged':
      // Says what is true — the money moved, the figures have not caught up — and names the one
      // action that fixes it. Never "something went wrong": nothing did.
      return 'Your last transaction went through, but your balances haven’t caught up yet, so a total would be wrong. Tap Refresh in a moment.'
  }
}

/**
 * The same fact as `private-incomplete`, said where a MAX button is offered.
 *
 * ── WHY THIS LIVES NEXT TO unreadableReasonText ──────────────────────────────
 *
 * They describe ONE condition and must not drift apart. The M9 cold read found the modal making two
 * incompatible claims about the same truncated scan at the same moment: the hero refused a total
 * because "a total would be too low", while MAX — computed from that identical partial set —
 * offered a confident figure with no comment at all. A user reading both learns that the wallet
 * does not know what it knows.
 *
 * MAX IS NOT WITHDRAWN, and that is deliberate. Unlike a total, a lower-bound maximum is still
 * SAFE to act on: every output it was computed from is one we really hold and really can spend, so
 * the amount is spendable — it is only possibly less than the true maximum. Refusing it would block
 * a working action to avoid understating a number. So the figure stays and the uncertainty is
 * stated, which is the honest half of what the total is doing.
 *
 * ONE WORDING, because there is now one vocabulary. This briefly took the noun as a parameter,
 * while the send flow said "private" and the move sheets still said "shielded" — the sentence was
 * shared and the noun was not. Both surfaces speak private and public now, so the knob has no
 * caller and is gone: a parameter that can only be passed one value is a place for the two to
 * drift apart again.
 */
export function incompleteAvailableNote(): string {
  return 'We couldn’t read all of your private balance, so this may be lower than your real maximum. It’s safe to send — there may simply be more.'
}

