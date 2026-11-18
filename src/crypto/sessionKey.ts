// The STORE KEY — a session-lived symmetric key for encrypting Caravel's local stores at rest.
//
// The key belongs to the chat identity: a random secret kept inside the password-encrypted chat
// record (chatIdentityStore), adopted at create, import and unlock, and dropped on lock. It seals
// every messaging store (messages, contacts, groups, nicknames, payment claims, the outbox…).
//
// ── WHY MODULE STATE AND NOT REACT STATE ─────────────────────────────────────
//
// The consumers are called from OUTSIDE React — addReceivedMessage() from inside a React state
// updater, the stores' own load/write paths — so a context value would be unreachable from
// precisely the places that need it.

// ── Session state ────────────────────────────────────────────────────────────

let key: Uint8Array | null = null

/** The live store key, or `null` while chat is locked. */
export function getStoreKey(): Uint8Array | null {
  return key
}

export function hasStoreKey(): boolean {
  return key !== null
}

/** Adopt a key for this session — always BEFORE any store read begins. */
export function setStoreKey(k: Uint8Array): void {
  key = k
}

/**
 * Drop the key. Called on lock.
 *
 * The buffer is zeroed first. HONESTLY, THAT IS DEFENCE IN DEPTH AND NOT ERASURE: JavaScript offers
 * no guarantee that this is the only copy — a garbage collector may have moved the array, and the
 * password it came from was a JS string that cannot be wiped at all. It costs one memset and closes
 * the most obvious case (a heap snapshot taken after lock), which is worth having as long as nobody
 * reads it as a stronger promise than it is.
 */
export function clearStoreKey(): void {
  key?.fill(0)
  key = null
}
