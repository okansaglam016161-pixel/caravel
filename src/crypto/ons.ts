import { INDEXER_URL } from './indexerConfig'
import { NETWORK_BUSY_MESSAGE } from './indexerRetry'
//   ONS (Ootle Name Service) integration for Caravel.
//
//   READ side only in this module: resolve an @name to a Nostr pubkey via the keyless public
//   indexer (no wallet, no key, no fee), so users can find each other by name in compose-new.
//   The live registry component is config passed to createOnsClient — nothing is hardcoded in the
//   library itself. The register (write) side lives in the wallet UI and uses the browser signer.

import { createOnsClient, type BrowserSigner, type NameRecord } from '@ootle/name-service'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { Network, WasmStealthCrypto } from '@tari-project/ootle'
import { scanOwnedUtxos } from './stealthUtxos'
import { withFeeMargin } from './feeProbe'
import { loadSelectionExcludedIds, newReservationToken, releaseCoins, reserveCoins } from './coinReservations'
import { confirmer } from './quote'
import { loadSpentOutputs, markLocked, promoteToSpent } from './spentOutputs'
import * as nip19 from 'nostr-tools/nip19'

/**
 * The live ONS registry on esmeralda.
 *
 * REDEPLOYED for Ootle 0.42, on template_ceb0ef6b… (tari_template_lib 0.33). The 0.39 registry
 * (component_fe93e87e…, template_66a7034e…) is gone — 404 on both indexers — and 0.42 needs
 * templates rebuilt against the 0.42 crates anyway. This is the fresh instantiation, verified live
 * on both indexers: new() and a register commit with Accept, and a keyless resolve returns the name.
 * (Before that: ONS-2's component_0e70f16a…, wiped by an earlier esmeralda reset.)
 *
 * A REDEPLOY IS A NEW ADDRESS, ALWAYS. Nothing migrates: every name registered against the old
 * registry is gone with it, and this constant is the only place Caravel learns where the registry
 * lives — so it must be updated in lockstep with any republish of the template.
 *
 * NOT EXPORTED. Its one consumer is the client below it; nothing outside this module has ever
 * needed the address, and the `ons` client is what callers actually want.
 */
const ONS_COMPONENT =
  'component_0109d5287493affc06ec8902fcbf85bd2362832580feeac2a70cba7e5ac6da4d'

/**
 * Configured client. The same indexer Caravel reads everywhere else; network defaults to Esmeralda.
 *
 * ONE NODE, not the union: name resolution is a point read of a registry component, and the ONS
 * client owns its own requests. If this ever needs the multi-node treatment it wants the same
 * fallback the wallet's point reads use — see indexerConfig.pointRead — not a union.
 */
export const ons = createOnsClient({
  component: ONS_COMPONENT,
  indexerUrl: INDEXER_URL,
})

/** Normalise a compose input to a bare ONS name: strip a leading `@`, lowercase. */
export function toOnsName(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase()
}

/**
 * Convert a stored `"nostr"` record value (npub bech32 OR 64-char hex) to x-only pubkey hex.
 *
 * NOT EXPORTED: `resolveOnsNameToHex` is the one caller, and it is the shape a consumer wants —
 * this is the step in the middle of it, not a service of its own.
 */
function nostrValueToHex(value: string): string | null {
  const v = value.trim()
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase()
  try {
    const d = nip19.decode(v)
    if (d.type === 'npub') return d.data
  } catch {
    /* not an npub */
  }
  return null
}

export type OnsResolveErrorKind = 'empty' | 'unreachable' | 'not-found' | 'no-key'

export interface OnsResolveResult {
  ok: boolean
  hex?: string
  error?: string
  // Typed so the compose UI can render each failure to its own distinct card (the branches below
  // already distinguish these cases; this just labels them).
  errorKind?: OnsResolveErrorKind
}

/** Resolve an `@name`/bare name to a Nostr pubkey hex, with user-facing messages. Keyless. */
export async function resolveOnsNameToHex(rawInput: string): Promise<OnsResolveResult> {
  const name = toOnsName(rawInput)
  if (!name) return { ok: false, error: 'Enter an npub or @name.', errorKind: 'empty' }
  let value: string | null
  try {
    value = await ons.resolveToNostr(name)
  } catch {
    return { ok: false, error: 'Could not reach the name registry — check your connection and try again.', errorKind: 'unreachable' }
  }
  if (!value) return { ok: false, error: `No @${name} found.`, errorKind: 'not-found' }
  const hex = nostrValueToHex(value)
  if (!hex) return { ok: false, error: `"@${name}" has no valid Nostr key on record.`, errorKind: 'no-key' }
  return { ok: true, hex }
}

// ── register (write) ──────────────────────────────────────────────────────────

/**
 * Local name-policy check mirroring the contract's validate_name (so we fail fast before a fee).
 *
 * THE MESSAGES ARE THE PRODUCT'S, NOT THE CONTRACT'S. The rules are the contract's — 32 bytes, ASCII
 * lowercase [a-z0-9_-] — and they live here so there is one place that says what a name may be. The
 * sentences are written for the person typing, and every surface renders what this returns rather
 * than translating it, because a view that rewrites its validator's copy is how two wordings start
 * to disagree about one rule.
 */
export function validateOnsName(name: string): string | null {
  if (!name) return 'Enter a name.'
  if (name.length > 32) return 'Too long, 32 characters max.'
  if (!/^[a-z0-9_-]+$/.test(name)) return 'Only lowercase letters, numbers, hyphen and underscore.'
  return null
}

/** Why a courtesy availability read failed. Only one way, but labelled — see below. */
export type OnsAvailabilityErrorKind = 'unreachable'

export interface OnsAvailabilityResult {
  ok: boolean
  /**
   * Present iff `ok`. ABSENT ON FAILURE, and that is the whole shape of this type: a read that
   * never happened has no answer to report, so there is no `false` lying around for a caller to
   * render as "taken". This used to return `{ available: false }` on a network error — a registry
   * we could not reach and a name somebody else owns, reported as the same value.
   */
  available?: boolean
  error?: string
  /** Present iff `!ok`. Lets the failure render as its own state rather than as a taken name. */
  errorKind?: OnsAvailabilityErrorKind
}

/**
 * Courtesy availability preview via a keyless indexer read.
 *
 * A PREVIEW, AND NEVER A GUARANTEE. This asks the indexer what the registry looked like a moment
 * ago; the contract decides at submit, atomically, and it is the only authority. Between a check
 * and a registration somebody else can take the name — the transaction is then rejected on-chain
 * and the fee is spent anyway, which is the outcome the register flow's own result states own.
 * Nothing built on this may say a name IS yours, only that it was free when we looked.
 */
export async function checkOnsAvailable(name: string): Promise<OnsAvailabilityResult> {
  try {
    return { ok: true, available: !(await ons.isRegistered(name)) }
  } catch (e) {
    return {
      ok: false,
      errorKind: 'unreachable',
      error: (e as Error).message || 'Could not reach the name registry — try again.',
    }
  }
}

/**
 * HOW A REGISTRATION ENDED, as a label rather than as prose.
 *
 * The browser writer classifies the chain's answer properly — Accept, AcceptFeeRejectRest, Reject,
 * Timeout — and then throws a SENTENCE, so the classification dies at this boundary and only English
 * survives. These four labels carry it across, so a screen can render an outcome instead of matching
 * a string. The matching happens once, here, with tests.
 *
 *   'accepted'       the chain applied it. The ONLY path to a success screen.
 *   'fee-burned'     the fee left the wallet and no name was written. WHY IS NOT KNOWN — see below.
 *   'timed-out'      we stopped waiting. NOT a failure: it may well have landed.
 *   'not-submitted'  refused before anything was sent. Nothing happened and no fee moved.
 *
 * WHY 'fee-burned' CLAIMS NO CAUSE. The writer's message for this outcome asserts "the fee was too
 * low", but it builds that sentence from the outcome alone — it captures the chain's actual reason
 * into `reason` and then discards it. A name taken between check and submit panics INSIDE the
 * register instruction, after the fee instructions have already run, which is exactly this outcome:
 * so the sentence is wrong precisely when somebody has lost a name. We do not repeat a cause we
 * cannot verify. Callers that want to know whether the name went instead ASK — a second keyless
 * availability read costs nothing and is evidence rather than inference.
 *
 * (The real fix belongs in ootle-name-service's browser-writer, which should carry `reason` into
 * that message or throw a typed error. That is a change in the other repo and a re-vendor.)
 */
export type OnsRegisterOutcome = 'accepted' | 'fee-burned' | 'timed-out' | 'not-submitted'

export interface OnsRegisterResult {
  ok: boolean
  txId?: string
  fee?: bigint
  error?: string
  /** Always present. `ok` is `outcome === 'accepted'`; the label is what the three failures need. */
  outcome?: OnsRegisterOutcome
}

/**
 * Why a fee estimate failed. Each has a different thing to do about it.
 *
 *   no-private        the wallet has no spendable PRIVATE output at all. The fee is paid from one,
 *                     so a wallet holding only public funds cannot register until it makes some
 *                     private. Read through Caravel's own scan (see caravelFeeSource), so this is a
 *                     real zero — never "the old one-page scan did not reach your coins".
 *   private-settling  the same empty set, but this wallet has outputs LOCKED in its spend record: a
 *                     transaction it sent has not settled, and its change is not spendable yet.
 *   fragmented        private funds exist but no single output covers the fee.
 *   unreachable       the network did not answer (or answered in a way we do not recognise).
 *   policy            the name itself is not allowed.
 */
export type OnsEstimateErrorKind = 'no-private' | 'private-settling' | 'fragmented' | 'unreachable' | 'policy'

/**
 * A registration priced AND built, ready to send. The confirm screen shows `feeMicroTari` — exactly
 * what is charged — and `submit` sends the very transaction that was priced (ootle-name-service
 * prepareRegisterWithNostr: one fee input, one dry run, one real build; no rebuild at submit).
 */
export interface OnsPreparedRegistration {
  feeMicroTari: bigint
  /** The stealth output the fee is paid from — the one coin this registration spends. */
  feeInputId: string
  /** Free dry run of a twin at the same fee; accepted only when the requirement is within it. */
  simulate: () => Promise<{ accepted: boolean; requiredFee?: bigint; reason?: string }>
  /** When it was priced. Past QUOTE_MAX_AGE_MS the confirm check refuses it (crypto/quote). */
  preparedAt: number
  /**
   * The confirm-time check: quote age, the fee coin still unspent, and a dry run of the final
   * transaction at the exact fee. Throws QuoteChanged — NOTHING SENT — when it no longer holds.
   */
  confirm: () => Promise<void>
  /** Let go of the fee coin this prepare reserved (cancel, or before re-pricing). Idempotent. */
  release: () => void
  /**
   * Send it, once — the confirm check first, unless confirm() just passed. Every on-chain outcome
   * comes back labelled, as registerOnsName's does; the one throw is QuoteChanged, and it means
   * nothing was sent.
   */
  submit: () => Promise<OnsRegisterResult>
}

export interface OnsEstimateResult {
  ok: boolean
  /** Present iff `ok`: the priced, built registration the confirm screen submits. */
  prepared?: OnsPreparedRegistration
  /** The µtTARI budget to reveal for the fee — the estimated network cost plus the shared margin (feeProbe.withFeeMargin). This
   *  is the amount the user actually pays (the whole revealed budget is consumed; overcharge is not
   *  refunded), so it's what we show on the confirm gate. */
  feeMicroTari?: bigint
  error?: string
  /** Present iff `!ok`. Lets each problem render its own instruction instead of one generic card. */
  errorKind?: OnsEstimateErrorKind
}

/**
 * Turn the writer's estimate failure into a label. THE STRING MATCHING LIVES HERE AND NOWHERE ELSE.
 *
 * These are the browser writer's own messages, thrown from a vendored build, so they are stable for
 * a given vendoring and the spec pins them. Anything unrecognised falls to 'unreachable', which is
 * the honest default: an estimate we could not complete for a reason we do not recognise is not a
 * claim about this wallet's balance. The raw message is carried through either way, so nothing is
 * swallowed.
 */
function classifyEstimateError(message: string, senderAddress: string): OnsEstimateErrorKind {
  if (message.includes('No confidential UTXOs found')) {
    const locked = Object.values(loadSpentOutputs(senderAddress).records).some(r => r.status === 'locked')
    return locked ? 'private-settling' : 'no-private'
  }
  if (message.includes("Can't fund the fee from one UTXO")) return 'fragmented'
  return 'unreachable'
}

/**
 * Where the writer's fee input comes from: CARAVEL'S OWN SPENDABLE SET, not the writer's.
 *
 * THE BUG THIS REPLACES. The vendored writer found private outputs with its own scan — ONE request
 * for the 1000 OLDEST rows of ONE indexer's `/utxos`. Past a thousand unspent outputs on the
 * network, a wallet whose private coins are all recent saw none of them, and CNS said "needs a
 * balance" to a wallet holding ~2000 tTARI private. The send path had stopped reading `/utxos` that
 * way long ago; this path never got the fix because it never used the send path's scan.
 *
 * So it uses it now: `scanOwnedUtxos`, exactly as confidentialSend calls it — every page, every
 * indexer, by-id recovery, the receive walk, and the spend record excluded. CNS and a send can no
 * longer disagree about which coins this wallet has. The writer's selection is unchanged (the
 * smallest single output larger than the budget), and so is the fee math: this changes only WHICH
 * set it selects from. The writer takes it through BrowserSigner.ownedUtxos — a local patch until the
 * ONS client took it upstream (ootle-name-service 0263c14); see vendor/ons/dist/VENDOR_INFO.
 */
function caravelFeeSource(wallet: SecretKeyWallet, senderAddress: string): Pick<BrowserSigner, 'ownedUtxos'> {
  return {
    ownedUtxos: async () => {
      const crypto = new WasmStealthCrypto(Network.Esmeralda)
      const viewSecret = await wallet.getViewSecret()
      return scanOwnedUtxos(crypto, viewSecret, {
        // Spent, on the wire, or held by another prepared transaction — see crypto/coinReservations.
        excluded: loadSelectionExcludedIds(senderAddress),
        walletAddress: senderAddress,
      })
    },
  }
}

/**
 * Price AND build the registration of `name` + its nostr record, WITHOUT committing anything — a
 * dry run, nothing spent. Returns the fee (cost + the shared margin, feeProbe.withFeeMargin), which
 * is exactly what is charged and what the confirm screen shows, and `prepared`, whose `submit`
 * sends the very transaction that was priced.
 */
export async function estimateOnsRegistration(
  wallet: SecretKeyWallet,
  senderAddress: string,
  name: string,
  ownNpub: string,
): Promise<OnsEstimateResult> {
  const policy = validateOnsName(name)
  if (policy) return { ok: false, errorKind: 'policy', error: policy }
  const lock = feeInputLock(senderAddress)
  try {
    const writer = await ons.withBrowserSigner({
      wallet, senderAddress, ...caravelFeeSource(wallet, senderAddress), onSubmitted: lock.onSubmitted,
    })
    const prepared = await writer.prepareRegisterWithNostr(name, ownNpub, withFeeMargin)
    const preparedAt = Date.now()
    const check = confirmer({
      preparedAt,
      simulate: async () => {
        const v = await prepared.simulate()
        return v.accepted ? { accepted: true } : { accepted: false, kind: /^Required fees/.test(v.reason ?? '') ? 'underpaid' : 'reject', reason: v.reason }
      },
      inputs: { ids: [prepared.feeInputId] },
    })
    // HELD until submitted, released or expired, so a send or a reveal prepared meanwhile cannot
    // select the coin this registration's fee comes from. See crypto/coinReservations.
    const reservation = newReservationToken()
    reserveCoins(senderAddress, [prepared.feeInputId], reservation)
    const release = () => releaseCoins(senderAddress, reservation)
    return {
      ok: true,
      feeMicroTari: prepared.feeMicroTari,
      prepared: {
        feeMicroTari: prepared.feeMicroTari,
        feeInputId: prepared.feeInputId,
        simulate: () => prepared.simulate(),
        preparedAt,
        confirm: check.confirm,
        release,
        submit: async () => {
          await check.ensureConfirmed()
          try {
            return await settleRegistration(lock, () => prepared.submit())
          } finally {
            // Submitted (the spend record's lock took over) or refused before sending: either way
            // the review-time hold is done.
            release()
          }
        },
      },
    }
  } catch (e) {
    const message = (e as Error).message || 'Could not estimate the fee.'
    return { ok: false, errorKind: classifyEstimateError(message, senderAddress), error: message }
  }
}

/**
 * The fee input goes into the spend record, like every other spend: locked the moment the writer
 * has submitted, before its ~30 s result poll — the window in which a send or a reveal could
 * otherwise select the same output and have the chain reject it after taking its fee.
 */
function feeInputLock(senderAddress: string) {
  const state = { txId: null as string | null }
  return {
    state,
    onSubmitted: (txId: string, spentInputIds: string[]) => {
      state.txId = txId
      markLocked(senderAddress, spentInputIds, txId)
    },
    promote: () => { if (state.txId) promoteToSpent(senderAddress, state.txId) },
  }
}

/**
 * Run a registration submit and label what happened. Then, for the lock taken at submit:
 *
 *   Accept            → promote. The output is spent.
 *   FeeIntentCommit   → promote, TOO. The fee input sits in the FEE instructions, and a fee-only
 *                       commit is precisely the one where those committed: the output is consumed
 *                       and the change exists. lockSweep would map this verdict to `release`
 *                       (right for inputs in the body, wrong for this one), so it is settled here,
 *                       where the outcome is known, rather than left for the sweep.
 *   anything else     → KEEP. A plain Reject or a timeout is not something this can read with
 *                       confidence from a sentence; lockSweep resolves the lock against the chain.
 */
async function settleRegistration(
  lock: ReturnType<typeof feeInputLock>,
  send: () => Promise<{ transactionId: string; fee: bigint }>,
): Promise<OnsRegisterResult> {
  try {
    const res = await send()
    lock.promote()
    return { ok: true, outcome: 'accepted', txId: res.transactionId, fee: res.fee }
  } catch (e) {
    const message = (e as Error).message || 'Registration failed.'
    if (message.includes('the fee was still spent')) lock.promote()
    return { ok: false, outcome: classifyRegisterOutcome(message), txId: txIdFrom(message), error: message }
  }
}

/**
 * Register `name` for this wallet and set its "nostr" record to the wallet's own npub, in one
 * atomic on-chain transaction (client-signed, fee paid from a confidential UTXO), revealing exactly
 * `feeBudget`. The ONE-SHOT form, for a caller with a budget already in hand; the confirm screen
 * submits {@link estimateOnsRegistration}'s `prepared` instead, so what it sends is what it priced.
 * On-chain uniqueness is the final authority; a name free at preview can still be taken.
 */
export async function registerOnsName(
  wallet: SecretKeyWallet,
  senderAddress: string,
  name: string,
  ownNpub: string,
  feeBudget: bigint,
): Promise<OnsRegisterResult> {
  const policy = validateOnsName(name)
  // REFUSED BEFORE ANYTHING WAS SENT. No transaction exists, no fee moved, and a screen must be able
  // to say that rather than implying a failed write.
  if (policy) return { ok: false, outcome: 'not-submitted', error: policy }

  // The fee input is locked at submit and settled by outcome — see feeInputLock / settleRegistration.
  const lock = feeInputLock(senderAddress)
  return settleRegistration(lock, async () => {
    const writer = await ons.withBrowserSigner({
      wallet, senderAddress, ...caravelFeeSource(wallet, senderAddress), onSubmitted: lock.onSubmitted,
    })
    return writer.submitRegisterWithNostr(name, ownNpub, feeBudget)
  })
}

/**
 * Turn the writer's rejection sentence back into the outcome it was built from. As with the estimate
 * classifier: the matching lives here, once, pinned by the spec.
 *
 * A THROW THAT REACHES HERE IS NOT NECESSARILY A REJECTION. It also covers a transport failure mid-
 * submission, where we never learned what the chain did. That is the same not-knowing as a timeout
 * and gets the same label, because the alternative is telling somebody their registration failed
 * when it may be sitting on the ledger. `'timed-out'` is the honest default for this whole family.
 */
function classifyRegisterOutcome(message: string): OnsRegisterOutcome {
  // BOTH REJECTION SHAPES SPENT THE FEE, and it is worth writing down why, because only one of them
  // says so. AcceptFeeRejectRest is the explicit case: the fee committed, the rest did not. A plain
  // Reject looks like it might have cost nothing — but the writer only ever sees a Reject INSIDE
  // `execution_result.finalize.result`, which means the transaction was executed, and the fee
  // instructions are the first instructions in it (stealth transfer → bucket → PayFeeFromBucket,
  // built before the ONS calls). A transaction the chain got far enough to reject has already paid.
  if (message.includes('the fee was still spent') || message.includes('was rejected on-chain')) return 'fee-burned'
  // THE ONE FAILURE THAT IS A DEFINITE "NOTHING SENT": the writer's busy-indexer retry ran out
  // (Ootle 0.43 rate limits). Every attempt was refused before processing, and the writer only
  // resubmits after checking the fee input is still unspent — so no transaction exists and no fee
  // moved. Its "may already have gone through" sibling deliberately stays below, as NOT KNOWING.
  if (message === NETWORK_BUSY_MESSAGE) return 'not-submitted'
  // Everything else is NOT KNOWING: the poll gave up, or the submission threw before we learned what
  // the chain did. Both may well have landed, so neither may be called a failure.
  return 'timed-out'
}

/** The writer embeds the transaction id as `(tx …)`. Pulled out so every fee-spending outcome can
 *  show its reference — which is the only thing that makes a burned fee checkable afterwards. */
function txIdFrom(message: string): string | undefined {
  return /\(tx ([^)\s]+)\)/.exec(message)?.[1]
}

// ── owned names (reverse lookup) ────────────────────────────────────────────────

export type { NameRecord }

/**
 * WHY THE TWO FAILURES ARE LABELLED, AND LABELLED SEPARATELY.
 *
 * Reading your names can fail before it ever reaches the network — deriving the owner key is a
 * wallet operation, not a registry read — and the two say different things to a person. "Could not
 * reach the registry" is worth retrying; "could not work out which identity you are" is not. They
 * used to share one catch and one sentence, so a caller could only ever offer the wrong one.
 *
 * MIRRORS OnsResolveErrorKind above: the same flag + optionals + labelled kind. The union-shaping
 * stays with the consumer, exactly as the compose modal shapes the resolve path's result.
 */
export type OnsOwnedErrorKind = 'unreachable' | 'no-identity'

export interface OwnedNamesResult {
  ok: boolean
  /**
   * Present iff `ok`. AN EMPTY ARRAY IS A REAL ANSWER — this wallet owns no names — and is never a
   * stand-in for a read that failed. A caller that treats `!names?.length` as "nothing here" has
   * re-created the bug this shape exists to prevent: an unreachable registry rendering as an empty
   * one, which invites somebody to claim a name they already hold.
   */
  names?: NameRecord[]
  error?: string
  /** Present iff `!ok`. Lets each failure render to its own state instead of one generic card. */
  errorKind?: OnsOwnedErrorKind
}

function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * The @names this wallet owns. Derives the owner key (the wallet's Ristretto public key, the same
 * identity recorded on-chain as a name's owner) and filters the registry by it — keyless, on-chain,
 * and identical on any device for the same wallet.
 *
 * ALL FOUR OUTCOMES ARE DISTINCT, and that is the whole point of this function's shape:
 *
 *   { ok: true,  names: […] }                          one or several — the full list, never the first
 *   { ok: true,  names: [] }                            owns none — a real answer about the chain
 *   { ok: false, errorKind: 'unreachable' }             the registry could not be read
 *   { ok: false, errorKind: 'no-identity' }             this wallet's key could not be derived
 *
 * The list is NOT re-sorted here. The reader already sorts it by name (client/src/reader.ts), so
 * there is one ordering in one place rather than two that can disagree.
 *
 * NO REGISTRATION DATE, AND NOTHING TO MAKE ONE FROM. The contract's NameRecord is {owner, records}
 * and holds no time field; the NameRegistered event carries only the name; the indexer's substate
 * `version` counts the whole registry's writes, not one name's. The only timestamp that exists is
 * the local journal's, which is this device's clock at the moment we ACTED — "never a peer's, never
 * a chain's" (journal.ts) — so it is not a registration date. The field is ABSENT rather than null,
 * so nothing downstream can quietly fill it and call it one.
 */
export async function ownedOnsNames(wallet: SecretKeyWallet): Promise<OwnedNamesResult> {
  // TWO TRY BLOCKS, NOT ONE. A single catch around both calls is what let a wallet failure return
  // the registry's sentence and a registry failure return the wallet's. The split is the fix.
  let ownerHex: string
  try {
    ownerHex = bytesToHex(await wallet.getPublicKey())
  } catch (e) {
    return {
      ok: false,
      errorKind: 'no-identity',
      error: (e as Error).message || 'Could not read this wallet’s identity key.',
    }
  }

  try {
    return { ok: true, names: await ons.namesForOwner(ownerHex) }
  } catch (e) {
    return {
      ok: false,
      errorKind: 'unreachable',
      error: (e as Error).message || 'Could not reach the name registry — try again.',
    }
  }
}
