// Persisted Ootle ACCOUNT COMPONENT address, one per wallet identity.
//
// Keyed on the wallet's Tari address, exactly as txHistory.ts keys its sent-transaction log — this
// is per-identity wallet state, so it must not leak across a lock/unlock into a different wallet.
//
// WHAT IS STORED IS PUBLIC. A component address is on-chain and world-readable; there is nothing
// secret here, which is why it lives in its own plain store rather than inside the encrypted
// StoredWallet envelope (that envelope exists to protect the mnemonic, and widening it to carry
// public data would mean decrypting to read something anyone can already see).
//
// WHY STORED AT ALL, rather than computed on demand: the address cannot be derived client-side —
// see accountAddress.ts for why — so the only way to know it is to catch it as it goes past in a
// transaction result. Catching it once and keeping it is the whole point of this file.
//
// ABSENCE IS NORMAL AND MEANS "NOT KNOWN YET", NEVER "ZERO". Wallets that claimed the faucet before
// this shipped have no stored address, and neither does a wallet that has never transacted. Callers
// must treat `null` as unknown and degrade to a neutral state — see M1's read path.

// Same shape as the other per-identity stores: caravel.<name>.v1.<identity>.
function key(walletAddress: string) { return `caravel.account.v1.${walletAddress}` }

/**
 * The stored account component address for this wallet, or `null` if none has been captured.
 *
 * Never throws: a private-mode / disabled-storage browser reads as "not known yet", which is the
 * same degradation as never having transacted.
 */
export function loadAccountAddress(walletAddress: string): string | null {
  if (!walletAddress) return null
  try {
    const raw = localStorage.getItem(key(walletAddress))
    return raw && raw.length > 0 ? raw : null
  } catch { return null }
}

/**
 * Record the account component address for this wallet.
 *
 * FIRST WRITE WINS, deliberately. The address is a pure function of the owner public key, so a
 * second capture can only ever be the same value — unless something upstream went wrong, in which
 * case the stored value is the one that has already been read successfully and the new one is the
 * suspect. Refusing the overwrite keeps a good address good.
 *
 * Empty input is ignored rather than stored, so a failed extraction cannot blank a known address.
 */
export function saveAccountAddress(walletAddress: string, componentAddress: string): void {
  if (!walletAddress || !componentAddress) return
  if (loadAccountAddress(walletAddress)) return
  try { localStorage.setItem(key(walletAddress), componentAddress) } catch { /* quota / private mode */ }
}

/**
 * Forget the stored address for this wallet. Not used by the app today — it exists so a future
 * "re-link account" affordance has a supported way to clear the value instead of reaching into
 * localStorage by hand.
 */
export function clearAccountAddress(walletAddress: string): void {
  if (!walletAddress) return
  try { localStorage.removeItem(key(walletAddress)) } catch { /* private mode */ }
}
