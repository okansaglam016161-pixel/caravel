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

/** What the user did. `receive` is written by nothing yet — it is the reconciliation phase's output. */
export type JournalKind = 'send' | 'receive' | 'make-private' | 'make-public' | 'faucet'

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
 * The journal's coverage window.
 *
 * ── WHAT THIS IS ACTUALLY FOR ───────────────────────────────────────────────
 *
 * The reconciliation phase may only call a leftover UTXO a "receive" if the journal is known to
 * have recorded every output this wallet made for itself. That is not true of a wallet that
 * transacted before journalling existed, of a restored wallet on a new device, of a second device,
 * or of a wallet whose storage was cleared. In all of those the journal is simply younger than the
 * funds, and classifying against it would report the user's own change as money from a stranger —
 * which is exactly the failure that got the previous scan-derived Activity reverted.
 *
 * `startedAt` handles the young-journal cases. `degradedAt` handles the dangerous one: every store
 * in this app swallows quota errors, so a write can fail in silence and leave a hole with no other
 * trace. The first failed write stamps this permanently and reconciliation must refuse thereafter.
 */
export interface JournalEpoch {
  /** When journalling began for this wallet. Nothing older than this may be reasoned about. */
  startedAt: number
  /** First moment a journal write failed. Non-null means the record has a hole in it. */
  degradedAt: number | null
}

/**
 * Is the journal trustworthy enough to classify an observation made at `observedAt`?
 *
 * Phase 1 records the epoch and calls this nowhere; the reconciliation phase is its only consumer.
 * It lives here, with the type, so the rule is written down once next to what it reasons about.
 */
export function journalCovers(epoch: JournalEpoch | null, observedAt: number): boolean {
  if (epoch === null) return false          // never journalled — nothing may be claimed
  if (epoch.degradedAt !== null) return false  // a known hole — refuse rather than guess
  return observedAt >= epoch.startedAt
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
