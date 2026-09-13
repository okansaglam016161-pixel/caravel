//   The one-time conversion from the RETIRED store-key scheme to the seed-derived one.
//
//   Until S2, every sealed store was encrypted under PBKDF2(password, a random salt kept in
//   `caravel.storekey.v1`). That salt was shared by every wallet on the device and re-minted on every
//   restore, so restoring any wallet silently stranded whatever the previous one had written. The key
//   now comes from each wallet's own seed (storeKeyFromSeedMaterial, in derivation.ts) and no such
//   record exists.
//
//   Which leaves the devices that already have one. This module opens what the old key sealed and
//   re-seals it under the new one, so a wallet that pre-dates S2 gets its conversations, contacts and
//   history back rather than reading empty.
//
//   ── THIS WHOLE FILE IS TEMPORARY ─────────────────────────────────────────────
//
//   The retired reader and deriver live HERE, not in sessionKey, precisely so that retiring the
//   migration is one file deletion plus one call site. sessionKey is back to what it should always
//   have been: the key's lifetime, and nothing about where the key came from.
//
//   ── SHAPE-AGNOSTIC ON PURPOSE ────────────────────────────────────────────────
//
//   It decrypts and re-encrypts opaque JSON. It never parses a store's contents, never knows a
//   journal from a nickname map, and so cannot corrupt a shape it does not understand. Every store's
//   own parse, defaulting and migrate-on-read logic runs afterwards, unchanged, exactly as it would
//   have on a record that was never converted.
//
//   ── IDEMPOTENT, BECAUSE localStorage HAS NO TRANSACTIONS ─────────────────────
//
//   Ten records are rewritten one at a time. A tab closed in the middle leaves some under the new key
//   and some under the old, and there is no rollback to reach for. So instead of atomicity, this is
//   built to be RE-RUNNABLE: each record is tried under the new key FIRST, which makes an
//   already-converted one a no-op, and the legacy record is left in place unless the whole pass
//   succeeded. A half-finished migration simply finishes on the next unlock.

import { b64Decode } from './base64'
import { open, seal } from './storeCrypto'

// ── The retired parameters record ────────────────────────────────────────────

/** The shape `caravel.storekey.v1` was written in. Nothing writes it any more. */
export interface LegacyKeyParams {
  version: 1
  kdf: 'pbkdf2'
  iterations: number
  salt: string        // base64, 16 random bytes
}

const LEGACY_KEY = 'caravel.storekey.v1'
const SUPPORTED_VERSIONS = [1]
const KEY_BYTES = 32

/** The retired record, or null when there is none this build can read. */
export function loadLegacyKeyParams(): LegacyKeyParams | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(LEGACY_KEY)
  } catch {
    return null   // storage disabled — nothing to migrate that we could reach anyway
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const params = parsed as LegacyKeyParams
  if (!SUPPORTED_VERSIONS.includes(params?.version)) return null
  if (typeof params.salt !== 'string' || !params.salt) return null
  if (typeof params.iterations !== 'number' || !Number.isFinite(params.iterations) || params.iterations < 1) return null
  return params
}

/** Is there anything to convert? Cheap enough to ask on every unlock; false forever after S3 lands. */
export function hasLegacyStoreKey(): boolean {
  return loadLegacyKeyParams() !== null
}

/**
 * The OLD derivation: password + params → 32 raw key bytes, PBKDF2-SHA-256.
 *
 * `iterations` comes from the RECORD rather than a constant, which is what lets a record written at
 * an older work factor still derive the key it was written with.
 */
export async function deriveLegacyStoreKey(password: string, params: LegacyKeyParams): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const salt = b64Decode(params.salt)
  // `salt as BufferSource`: the lib-typing reconciliation walletCrypto documents. No runtime effect.
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: params.iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

// ── What gets converted ──────────────────────────────────────────────────────

/**
 * The ten sealed records, by the namespace each is keyed under.
 *
 * PLAINTEXT STORES ARE ABSENT BY DESIGN, not by oversight: the tombstone, seen-def, deleted-group,
 * account and journal-epoch records were never sealed, so there is nothing to re-key. Listing them
 * would mean rewriting bytes for no reason.
 *
 * THE BLOB CACHE IS ABSENT DELIBERATELY TOO. It is sealed, but it lives in IndexedDB and holds
 * nothing that cannot be fetched again — its own header says a lost entry costs exactly one re-fetch.
 * Moving megabytes of images to save that is not worth the code, so old blobs simply read unreadable
 * and come back from the network. Nothing in this file touches IndexedDB.
 */
const SEALED_BY_PUBKEY = ['messages', 'contacts', 'nicknames', 'groups', 'tariaddr', 'payresolved', 'addrsent']
const SEALED_BY_ADDRESS = ['journal', 'txhistory', 'utxoseen']

export function legacyRecordKeys(pubkeyHex: string, walletAddress: string): string[] {
  return [
    ...SEALED_BY_PUBKEY.map(name => `caravel.${name}.v1.${pubkeyHex}`),
    ...SEALED_BY_ADDRESS.map(name => `caravel.${name}.v1.${walletAddress}`),
  ]
}

/** What one pass did. Returned rather than logged, so the caller decides what to say about it. */
export interface MigrationReport {
  /** Opened under the old key and re-sealed under the new one. */
  migrated: number
  /** Already readable under the new key — a previous pass did it, or the record was never sealed. */
  alreadyReadable: number
  /** Opens under NEITHER key. Left byte-for-byte alone; see the note in migrateStoreKey. */
  stranded: number
  /** No such record on this device. */
  absent: number
  /** A write was refused (quota). The record stays under the old key and the next pass retries it. */
  failed: number
  /** Whether the legacy record was removed, ending the migration for this device. */
  cleared: boolean
}

export interface MigrationInput {
  /** Only ever used to derive the old key. NEVER retained — see the note in migrateStoreKey. */
  password: string
  /** The seed-derived key for this wallet, from deriveIdentity. */
  newKey: Uint8Array
  pubkeyHex: string
  walletAddress: string
}

/**
 * Convert this wallet's sealed records from the old key to the new one.
 *
 * A NO-OP when there is no legacy record, which is every device after this has run once and every
 * device created after S2. Safe to call on every unlock.
 *
 * ── THE CALLER MUST HAVE PROVEN THE PASSWORD ─────────────────────────────────
 *
 * unlock does: decryptMnemonic succeeds before this is reached, so the password is correct by the
 * time it arrives. That matters, because a WRONG password derives a wrong old key, under which every
 * record looks stranded — indistinguishable from genuine stranding by inspection alone.
 *
 * So the clearing rule is deliberately narrower than "we made a pass": the legacy record is removed
 * only when nothing failed to write AND (something actually converted, OR there was nothing stranded
 * to explain). Converting even one record proves the old key was right, which makes the remaining
 * failures real stranding rather than a bad password. Converting NOTHING while records sit unopenable
 * is exactly what a wrong password looks like, so that case keeps the record and tries again — at the
 * cost of one harmless hundred-byte entry on a device that may genuinely have nothing left to
 * recover.
 *
 * THE PASSWORD IS NOT RETAINED. It is a parameter, used once, on the line below. No module state
 * here holds it, and the derived old key goes out of scope with the call.
 */
export async function migrateStoreKey(input: MigrationInput): Promise<MigrationReport> {
  const report: MigrationReport = {
    migrated: 0, alreadyReadable: 0, stranded: 0, absent: 0, failed: 0, cleared: false,
  }

  const params = loadLegacyKeyParams()
  if (!params) return report

  const oldKey = await deriveLegacyStoreKey(input.password, params)

  for (const storageKey of legacyRecordKeys(input.pubkeyHex, input.walletAddress)) {
    let raw: string | null
    try {
      raw = localStorage.getItem(storageKey)
    } catch {
      report.failed++          // storage disabled mid-pass; retry next unlock
      continue
    }
    if (raw === null || raw === '') { report.absent++; continue }

    // NEW KEY FIRST — this is what makes a re-run free. An already-converted record opens here and
    // is left alone, so a pass interrupted halfway does not re-seal what it already sealed.
    //
    // A never-sealed PLAINTEXT record also lands here: open() passes v1 plaintext through without
    // consulting any key. Correct to skip — there is nothing to re-key, and storeIo's migrate-on-read
    // will seal it under the new key the first time its store is loaded.
    if (open(input.newKey, raw).status === 'ok') { report.alreadyReadable++; continue }

    const opened = open(oldKey, raw)
    if (opened.status !== 'ok') {
      // OPENS UNDER NEITHER KEY. Sealed under some third, older salt that was overwritten long before
      // this ran — the very failure this change exists to end. Nothing here can recover it, so the
      // bytes are left exactly as they are rather than tidied away, and the degraded banner already
      // tells the user their history could not be opened.
      report.stranded++
      continue
    }

    try {
      localStorage.setItem(storageKey, seal(input.newKey, opened.json))
      report.migrated++
    } catch {
      report.failed++          // quota: leave it under the old key, retry next unlock
    }
  }

  if (report.failed === 0 && (report.migrated > 0 || report.stranded === 0)) {
    try {
      localStorage.removeItem(LEGACY_KEY)
      report.cleared = true
    } catch { /* storage disabled — the next unlock tries again */ }
  }

  return report
}
