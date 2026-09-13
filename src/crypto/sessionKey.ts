// The STORE KEY — a session-lived symmetric key for encrypting Caravel's local stores at rest.
//
// ── WHAT THIS MODULE IS NOW: THE KEY'S LIFETIME, NOT ITS DERIVATION ──────────
//
// The key is DERIVED IN derivation.ts, from the wallet's own seed — see storeKeyFromSeedMaterial
// there. What is left here is the part that was always right: holding one key for the length of an
// unlocked session, handing it to the stores that ask, and dropping it on lock.
//
// NOTHING ABOUT THE OLD SCHEME IS LEFT HERE. The reader for the retired `caravel.storekey.v1`
// record, and the PBKDF2 derivation that went with it, live in storeKeyMigration.ts — together, so
// that retiring the migration is one file deletion rather than an archaeology exercise across two.
//
// ── WHY MODULE STATE AND NOT REACT STATE ─────────────────────────────────────
//
// The eventual consumers are all called from OUTSIDE React: journalStore's write path (invoked by
// send/move/faucet call sites that never go through a setter), journalSnapshot() behind
// useSyncExternalStore, and addReceivedMessage() from inside a React state updater. A context value
// would be unreachable from precisely the places that need it. Module scope is what those stores
// already use for the same reason — see journalStore's `listeners`/`cachedEntries`, and
// WalletContext's own nostrSecretKeyRef.
//
// ── WHY THERE IS NO LONGER A SALT OF ITS OWN ─────────────────────────────────
//
// There used to be: one random salt in localStorage, and a store key of PBKDF2(password, salt). The
// argument for it was real — the store key and the seed key had to be independent derivations, so
// that recovering one did not hand over the other. What that argument missed is what happens to the
// salt.
//
// ONE SALT, SHARED BY EVERY WALLET ON THE DEVICE, RE-MINTED ON EVERY RESTORE. So restoring a second
// wallet silently stranded the first one's messages, contacts, nicknames, groups, journal and
// transaction history: sealed under a key whose only input had just been overwritten. No detection,
// no signal, no way back. Restoring the SAME wallet did it too, because restore always mints a new
// password and a new salt.
//
// The key now comes from the wallet's OWN SEED, so every wallet has its own, nothing is shared, and
// a phrase always re-derives the key its data was sealed with. Independence is kept — a hash under
// Caravel's store domain is not the seed key and cannot be walked back to it — without a stored
// input that can be lost.
//
// IT ALSO COSTS NOTHING. The old design paid a second 600 000-iteration PBKDF2 on every unlock; the
// new one is a Blake2b over material deriveIdentity already holds, so unlock does one key derivation
// where it used to do two. Measured across the change: CipherSeed 121.7ms to 49.2ms, BIP-39 70.5ms
// to 15.5ms.
//
// Devices that still hold stores sealed the old way are converted by storeKeyMigration.ts, once,
// losslessly, at unlock.

// ── Session state ────────────────────────────────────────────────────────────

let storeKey: Uint8Array | null = null

/** The live store key, or `null` while locked. */
export function getStoreKey(): Uint8Array | null {
  return storeKey
}

export function hasStoreKey(): boolean {
  return storeKey !== null
}

/**
 * Adopt a derived key for this session. Called by create, unlock and restore — always BEFORE
 * adoptIdentity, so that no store read can ever observe an unlocked wallet with no key.
 */
export function setStoreKey(key: Uint8Array): void {
  storeKey = key
}

/**
 * Drop the key. Called from lock(), beside the other identity clears.
 *
 * The buffer is zeroed first. HONESTLY, THAT IS DEFENCE IN DEPTH AND NOT ERASURE: JavaScript offers
 * no guarantee that this is the only copy — a garbage collector may have moved the array, and the
 * password it came from was a JS string that cannot be wiped at all. It costs one memset and closes
 * the most obvious case (a heap snapshot taken after lock), which is worth having as long as nobody
 * reads it as a stronger promise than it is.
 */
export function clearStoreKey(): void {
  storeKey?.fill(0)
  storeKey = null
}
