//   ONS (Ootle Name Service) integration for Caravel.
//
//   READ side only in this module: resolve an @name to a Nostr pubkey via the keyless public
//   indexer (no wallet, no key, no fee), so users can find each other by name in compose-new.
//   The live registry component is config passed to createOnsClient — nothing is hardcoded in the
//   library itself. The register (write) side lives in the wallet UI and uses the browser signer.

import { createOnsClient } from '@ootle/name-service'
import type { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import * as nip19 from 'nostr-tools/nip19'

/** The live ONS registry on esmeralda (ONS-2 deployment). */
export const ONS_COMPONENT =
  'component_0e70f16ad20e1c1b92f035d1e6f4b69c6c4c774ed309c2eb9e2c42c01279994a'

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

/** Local name-policy check mirroring the contract's validate_name (so we fail fast before a fee). */
export function validateOnsName(name: string): string | null {
  if (!name) return 'Enter a name.'
  if (name.length > 32) return 'Too long (max 32 characters).'
  if (!/^[a-z0-9_-]+$/.test(name)) return 'Only lowercase letters, digits, "_" and "-" are allowed.'
  return null
}

/** Courtesy availability preview via a keyless indexer read. The contract is the final authority. */
export async function checkOnsAvailable(name: string): Promise<{ available: boolean; error?: string }> {
  try {
    const taken = await ons.isRegistered(name)
    return { available: !taken }
  } catch {
    return { available: false, error: 'Could not reach the ONS registry — try again.' }
  }
}

export interface OnsRegisterResult {
  ok: boolean
  txId?: string
  fee?: bigint
  error?: string
}

/**
 * Register `name` for this wallet and set its "nostr" record to the wallet's own npub, in one
 * atomic on-chain transaction (client-signed, fee paid from a confidential UTXO). The wallet must
 * be funded. On-chain uniqueness is the final authority — a name free at preview can still be taken.
 */
export async function registerOnsName(
  wallet: SecretKeyWallet,
  senderAddress: string,
  name: string,
  ownNpub: string,
): Promise<OnsRegisterResult> {
  const policy = validateOnsName(name)
  if (policy) return { ok: false, error: policy }
  try {
    const writer = await ons.withBrowserSigner({ wallet, senderAddress })
    const res = await writer.registerWithNostr(name, ownNpub)
    return { ok: true, txId: res.transactionId, fee: res.fee }
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Registration failed.' }
  }
}
