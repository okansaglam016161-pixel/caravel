// The activity journal's record type — what the wallet writes down about the things IT does.
//
// ── WHY A LOCAL JOURNAL EXISTS AT ALL ────────────────────────────────────────
//
// A confidential output carries no sender, so the chain cannot tell an incoming payment from our
// own change. That blindness is about OTHER PEOPLE's actions. About the user's own, the wallet has
// perfect knowledge at the moment they happen — the recipient, the amount, the direction, the fee,
// the transaction id, and the commitments of the outputs it is about to create for itself. Until
// now it threw nearly all of that away and re-derived a thin version from two other stores.
//
// This module is the record. It writes down what is known WHEN it is known, because most of it is
// unrecoverable afterwards: a fee is not retrievable once the receipt ages out, and an output's
// commitment is not recomputable at all once the builder's closure is gone.
//
// ── THE TWO RULES THIS FILE IS BUILT AROUND ──────────────────────────────────
//
// 1. AN UNKNOWN NUMBER IS `null`, NEVER `0n`. Same rule the balance layer holds: a zero the wallet
//    cannot vouch for is worse than no figure. There is no `?? 0n` anywhere in this module and
//    there must never be one.
//
// 2. `[]` AND `null` MEAN DIFFERENT THINGS on `selfOutputIds`, and the difference is the whole
//    value of the field. See its doc comment.

/**
 * What the user did.
 *
 * `receive` is written by nothing yet — it is the reconciliation phase's output.
 *
 * `chat-payment` is RECORDED BUT NEVER DISPLAYED in wallet Activity. It exists because a chat
 * payment creates a change output back to this wallet, and an output nobody recorded reads later
 * as money from a stranger. Recording it is bookkeeping; showing it would be the compartment leak
 * we are deliberately not making. See activity.ts, which returns no row for it.
 */
export type JournalKind =
  | 'send' | 'receive' | 'make-private' | 'make-public' | 'faucet'
  | 'chat-payment' | 'ons-register'

/**
 * How it ended.
 *
 * `pending` is a REAL, TERMINAL-CAPABLE STATE, not a transient one. An entry is written before
 * submission and patched afterwards, so a closed tab or a crashed page leaves a `pending` row
 * saying "you attempted this and we never learned the outcome". That is the honest floor, and it
 * is what the previous behaviour — no record at all — could not express.
 */
export type JournalOutcome = 'pending' | 'committed' | 'rejected' | 'timeout' | 'failed'

/** Which balance a value moved out of or into. `external` is somebody else's wallet, or the faucet. */
export type Side = 'private' | 'public' | 'external'

/**
 * Who was on the other end.
 *
 * `value` HOLDS THE FULL ADDRESS. The store this replaces kept a pre-rendered sentence — "Sent to
 * otl_esm_1t…f4a2" — which is prose, not data: it cannot be searched, re-formatted or recovered,
 * and the address in it was already truncated beyond use. Truncation is a render concern.
 */
export interface Counterparty {
  kind: 'address' | 'npub' | 'faucet' | 'self'
  value: string
}

export interface JournalEntry {
  /**
   * Our own id, generated BEFORE submission and stable across the two-phase write.
   *
   * NOT the txId: at the moment the first half of the entry is written there is no txId yet, and
   * on a send that throws there never will be. Keying on something the network supplies would mean
   * the failures we most want recorded are the ones that cannot be.
   */
  id: string
  kind: JournalKind
  /** `Date.now()` when the action was INITIATED, on our clock. Never a peer's, never a chain's. */
  timestamp: number
  /** Null until the network returns one — and null forever if we never got that far. */
  txId: string | null
  outcome: JournalOutcome
  /** NULLABLE, AND NEVER INVENTED. Null is "not known", never zero. */
  amountMicrotari: bigint | null
  /** Known at action time and unrecoverable later, which is the whole reason it is recorded here. */
  feeMicrotari: bigint | null
  from: Side | null
  to: Side | null
  counterparty: Counterparty | null
  note: string | null
  /**
   * How we know this.
   *
   * Three provenances will merge in the display phase and they do not deserve equal trust: a row we
   * journalled ourselves cannot be moved or altered by anyone, a chat-linked row carries a
   * counterparty's clamped timestamp, and a reconciled row is an inference. Recording the source
   * per row is what lets a later phase treat them differently instead of flattening them.
   */
  source: 'local-journal' | 'chat-ref' | 'chain'
  /**
   * Substate ids of the outputs THIS ACTION CREATED FOR US.
   *
   * ── THE FIELD THE RECONCILIATION PHASE IS FOR ───────────────────────────────
   *
   * The scan returns every UTXO this wallet owns and cannot say which are ours by construction.
   * Subtracting the ids recorded here leaves the ones somebody else sent us. That subtraction is
   * exact rather than statistical, because the wallet builds all of its own outputs client-side and
   * their commitments are readable from the outputs statement before submission.
   *
   * `[]` AND `null` ARE NOT THE SAME and collapsing them would silently corrupt the result:
   *
   *   []    we know this action created no output for us — an exact-cover send, a public send.
   *         Safe to subtract: there is nothing to subtract.
   *   null  we could not determine them. A hole. Anything left over after subtracting may be our
   *         own output that we failed to record, so nothing may be classified from it.
   */
  selfOutputIds: string[] | null
}

/** The fields a caller supplies up front, before anything has been submitted. */
export type JournalDraft = Omit<JournalEntry, 'id' | 'timestamp' | 'outcome' | 'txId'>
  & Partial<Pick<JournalEntry, 'txId'>>

/** What a completed (or failed) action patches back in. */
export interface JournalPatch {
  outcome: JournalOutcome
  txId?: string | null
  amountMicrotari?: bigint | null
  feeMicrotari?: bigint | null
  selfOutputIds?: string[] | null
}

/**
 * Every action that can create a UTXO this wallet owns.
 *
 * ── A LIST, NOT A BOOLEAN, AND THAT IS THE POINT ─────────────────────────────
 *
 * "Is coverage complete" could have been one flag. It is a set of names measured against this
 * array because the failure this guards against is a FUTURE one: someone adds a sixth way to
 * create an owned output and does not journal it. With a flag, every existing epoch keeps claiming
 * completeness and the new action's change output silently becomes a phantom receive. With this,
 * adding a member here instantly makes every stored epoch incomplete — the wallet stops
 * classifying until the new action is actually recorded, which is the safe direction and requires
 * no migration to get right.
 *
 * `send` covers both paths deliberately. The private path creates change; the public path creates
 * nothing for us. They are one action either way, and journalled by one call site.
 */
export const OUTPUT_CREATING_ACTIONS = [
  'send',
  'make-private',
  'make-public',
  'faucet',
  /** A payment sent from chat. Recorded for subtraction only, never displayed in wallet Activity. */
  'chat-payment',
  /** An @name registration. Spends one UTXO and returns exactly one change output to us. */
  'ons-register',
] as const

export type OutputCreatingAction = (typeof OUTPUT_CREATING_ACTIONS)[number]

/** Does this set name every way an owned output can come into existence? */
export function coverageComplete(covers: readonly OutputCreatingAction[]): boolean {
  return OUTPUT_CREATING_ACTIONS.every(a => covers.includes(a))
}

/**
 * The journal's coverage window.
 *
 * ── TWO DIFFERENT QUESTIONS, AND BOTH MUST BE YES ───────────────────────────
 *
 * HEALTH — `startedAt` and `degradedAt` — asks whether the journal recorded what it was ASKED to
 * record. A wallet that transacted before journalling existed, one restored on a new device, a
 * second device, or one whose storage was cleared all fail this, and classifying against any of
 * them would report the user's own change as money from a stranger.
 *
 * COVERAGE — `covers` and `coverageCompleteAt` — asks whether it was asked to record EVERYTHING.
 * A perfectly healthy journal that was never told about chat payments or @name registrations
 * reports full health while missing their change outputs, which is exactly the failure mode. That
 * is why the two are separate fields and not one.
 *
 * `coverageCompleteAt` is the moment the second became true, and it is the threshold the guard
 * actually uses — it is always at or after `startedAt`, so it is the stricter of the two.
 */
export interface JournalEpoch {
  /** When journalling began for this wallet. Nothing older than this may be reasoned about. */
  startedAt: number
  /** First moment a journal write failed. Non-null means the record has a hole in it. */
  degradedAt: number | null
  /**
   * Which output-creating actions this journal records.
   *
   * Empty on every epoch written before coverage tracking existed — which is the correct default
   * and the safe direction: no coverage, nothing classifiable, no migration required.
   */
  covers: OutputCreatingAction[]
  /** When `covers` first became complete. Null while it is not. */
  coverageCompleteAt: number | null
}

/**
 * May an observation made at `observedAt` be reasoned about?
 *
 * The epoch half of the classification guard: healthy, complete, and after completeness. The other
 * half is set membership — `isPreEpoch` in utxoLedger — and reconciliation requires BOTH. That is
 * deliberate rather than redundant: this one compares timestamps, and a timestamp can be fooled by
 * an app that was closed or a scan that came back truncated, both of which make an old UTXO look
 * new. The baseline set cannot be fooled that way. Two independent guards, failing in the same
 * direction.
 */
export function journalCovers(epoch: JournalEpoch | null, observedAt: number): boolean {
  if (epoch === null) return false               // never journalled — nothing may be claimed
  if (epoch.degradedAt !== null) return false    // a known hole — refuse rather than guess
  if (!coverageComplete(epoch.covers)) return false
  if (epoch.coverageCompleteAt === null) return false
  // The stricter of the two thresholds. Anything first seen before coverage completed may be the
  // change output of an action nobody was recording at the time.
  return observedAt >= epoch.coverageCompleteAt
}

/**
 * Entries that COMMITTED but never recorded what they created.
 *
 * ── A HOLE THE DATA SHOWS BY ITSELF ─────────────────────────────────────────
 *
 * An action that landed on chain made whatever outputs it made whether or not we managed to write
 * them down. `selfOutputIds: null` on a committed entry is therefore not a missing detail — it is
 * an output of ours somewhere in the owned set with nothing to subtract it, which is precisely
 * what a later scan reads as money from a stranger.
 *
 * WHY THIS RATHER THAN DEGRADING THE EPOCH. Degradation is permanent and deliberately so, which
 * makes it the wrong tool for a condition that can be repaired: the @name capture reads its
 * outputs from a transaction result that stays fetchable, so a failure there is a network blip,
 * not a lost fact. Deriving the hole from the journal means a retry that fills the entry in
 * clears the guard by itself, and a tab closed mid-read is caught on the next load without needing
 * to have been caught at the time. It also cannot be forgotten at a call site — there is no flag
 * anyone has to remember to set.
 *
 * `pending` and `timeout` entries are NOT holes. Neither is known to have committed, so neither is
 * known to have created anything; if one later turns out to have landed, the UTXO it produced is
 * unaccounted and the baseline is what covers it.
 */
export function unresolvedOutputs(journal: readonly JournalEntry[]): JournalEntry[] {
  return journal.filter(e =>
    e.outcome === 'committed' &&
    e.selfOutputIds === null &&
    // A receive is somebody else's output; it never had self-outputs to record.
    e.kind !== 'receive',
  )
}

/** Is every committed action's output set accounted for? Reconciliation requires this. */
export function outputsFullyAccounted(journal: readonly JournalEntry[]): boolean {
  return unresolvedOutputs(journal).length === 0
}

/** A local id. `randomUUID` where available, with a fallback for older/insecure contexts. */
export function newJournalId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `j_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** Fill a draft into a complete entry. The one place `id`, `timestamp` and `pending` are set. */
export function draftToEntry(draft: JournalDraft, now = Date.now()): JournalEntry {
  return {
    id: newJournalId(),
    timestamp: now,
    txId: draft.txId ?? null,
    outcome: 'pending',
    kind: draft.kind,
    amountMicrotari: draft.amountMicrotari,
    feeMicrotari: draft.feeMicrotari,
    from: draft.from,
    to: draft.to,
    counterparty: draft.counterparty,
    note: draft.note,
    source: draft.source,
    selfOutputIds: draft.selfOutputIds,
  }
}

/**
 * Apply a patch.
 *
 * ONLY EVER ADDS KNOWLEDGE. A patch that omits a field leaves the existing value alone, and a
 * patch may not turn a known figure back into `null` — an action that reported an amount and then
 * failed to report a fee must not lose the amount. Callers pass what they learned, not a whole row.
 */
export function applyPatch(entry: JournalEntry, patch: JournalPatch): JournalEntry {
  return {
    ...entry,
    outcome: patch.outcome,
    txId: patch.txId ?? entry.txId,
    amountMicrotari: patch.amountMicrotari ?? entry.amountMicrotari,
    feeMicrotari: patch.feeMicrotari ?? entry.feeMicrotari,
    selfOutputIds: patch.selfOutputIds !== undefined ? patch.selfOutputIds : entry.selfOutputIds,
  }
}
