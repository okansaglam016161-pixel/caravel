//   ONS (Ootle Name Service) integration for Caravel.
//
//   READ side only in this module: resolve an @name to a Nostr pubkey via the keyless public
//   indexer (no wallet, no key, no fee), so users can find each other by name in compose-new.
//   The live registry component is config passed to createOnsClient — nothing is hardcoded in the
//   library itself. The register (write) side lives in the wallet UI and uses the browser signer.

import { createOnsClient, type NameRecord } from '@ootle/name-service'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import * as nip19 from 'nostr-tools/nip19'

/**
 * The live ONS registry on esmeralda.
 *
 * REDEPLOYED for Ootle 0.39. The ONS-2 registry (component_0e70f16a…) and the template behind it
 * were destroyed by the esmeralda reset — both return 404 — and 0.39 would have required a rebuild
 * regardless, since `Amount`'s CBOR encoding changed and templates must be rebuilt against the new
 * `tari_template_lib`. This is the fresh instantiation, on template_66a7034e…, verified live:
 * register + set_record commit, and a keyless resolve returns the record.
 *
 * A REDEPLOY IS A NEW ADDRESS, ALWAYS. Nothing migrates: every name registered against the old
 * registry is gone with it, and this constant is the only place Caravel learns where the registry
 * lives — so it must be updated in lockstep with any republish of the template.
 */
export const ONS_COMPONENT =
  'component_fe93e87e362a263ee65d382047b5adcc92c2a1dc08051a770032aefdda45c787'

/** Configured client. Same indexer Caravel already uses for UTXOs; network defaults to Esmeralda. */
export const ons = createOnsClient({
  component: ONS_COMPONENT,
  indexerUrl: 'https://ootle-indexer-a.tari.com',
})

/** True if a compose input should be treated as an ONS name (an `@name`, or a bare non-npub word). */
export function looksLikeOnsName(raw: string): boolean {
  const s = raw.trim()
  return s.length > 0 && !s.startsWith('npub1')
}

/** Normalise a compose input to a bare ONS name: strip a leading `@`, lowercase. */
export function toOnsName(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase()
}

/** Convert a stored `"nostr"` record value (npub bech32 OR 64-char hex) to x-only pubkey hex. */
export function nostrValueToHex(value: string): string | null {
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
    return { ok: false, error: 'Could not reach the ONS registry — check your connection and try again.', errorKind: 'unreachable' }
  }
  if (!value) return { ok: false, error: `No ONS name "@${name}" found.`, errorKind: 'not-found' }
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
      error: (e as Error).message || 'Could not reach the ONS registry — try again.',
    }
  }
}

export interface OnsRegisterResult {
  ok: boolean
  txId?: string
  fee?: bigint
  error?: string
}

export interface OnsEstimateResult {
  ok: boolean
  /** The µtTARI budget to reveal for the fee — the estimated network cost plus a small margin. This
   *  is the amount the user actually pays (the whole revealed budget is consumed; overcharge is not
   *  refunded), so it's what we show on the confirm gate. */
  feeMicroTari?: bigint
  error?: string
}

/** A small safety margin over the raw estimate. The whole budget is consumed on-chain (overcharge is
 *  not refunded), so keep it minimal — just enough to absorb tiny drift between estimate and submit. */
function withOnsFeeMargin(required: bigint): bigint {
  const margin = (required * 2n) / 100n // +2%
  return required + (margin > 100n ? margin : 100n)
}

/**
 * Estimate the fee (µtTARI) to register `name` + its nostr record, WITHOUT committing anything —
 * a simulated dry-run on the network, nothing spent. Returns the budget to reveal (estimate + a
 * small margin), which is what to show the user before they confirm.
 */
export async function estimateOnsRegistration(
  wallet: SecretKeyWallet,
  senderAddress: string,
  name: string,
  ownNpub: string,
): Promise<OnsEstimateResult> {
  const policy = validateOnsName(name)
  if (policy) return { ok: false, error: policy }
  try {
    const writer = await ons.withBrowserSigner({ wallet, senderAddress })
    const { feeMicroTari } = await writer.estimateRegisterWithNostr(name, ownNpub)
    return { ok: true, feeMicroTari: withOnsFeeMargin(feeMicroTari) }
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Could not estimate the fee.' }
  }
}

/**
 * Register `name` for this wallet and set its "nostr" record to the wallet's own npub, in one
 * atomic on-chain transaction (client-signed, fee paid from a confidential UTXO). `feeBudget` is the
 * µtTARI the user approved (from {@link estimateOnsRegistration}) — revealed exactly. On-chain
 * uniqueness is the final authority; a name free at preview can still be taken.
 */
export async function registerOnsName(
  wallet: SecretKeyWallet,
  senderAddress: string,
  name: string,
  ownNpub: string,
  feeBudget: bigint,
): Promise<OnsRegisterResult> {
  const policy = validateOnsName(name)
  if (policy) return { ok: false, error: policy }
  try {
    const writer = await ons.withBrowserSigner({ wallet, senderAddress })
    const res = await writer.submitRegisterWithNostr(name, ownNpub, feeBudget)
    return { ok: true, txId: res.transactionId, fee: res.fee }
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Registration failed.' }
  }
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
      error: (e as Error).message || 'Could not reach the ONS registry — try again.',
    }
  }
}
