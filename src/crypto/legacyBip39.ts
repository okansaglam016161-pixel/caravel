//   LEGACY BIP-39 derivation — DELETE THIS FILE AT MAINNET.
//
//   Every wallet created before the CipherSeed migration derives its Tari keys through this exact
//   path. The bytes below were moved out of walletCrypto.ts VERBATIM — not reimplemented, not
//   tidied, not "improved" — because an existing user's funds and identity depend on them
//   producing precisely what they produced before. A behavioural change here would not throw: it
//   would silently open a different, empty wallet at a different address with a different Nostr
//   identity. src/crypto/derivationAnchors.test.ts pins the output and is the proof this move
//   changed nothing.
//
//   Do not refactor this file. Do not tidy it. It exists to be deleted, whole, when BIP-39 support
//   is dropped for mainnet — at which point the re-exports at the bottom of walletCrypto.ts and
//   the 'bip39' arm of derivation.ts go with it.

import { mnemonicToSeed } from '@scure/bip39'
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { Network } from '@tari-project/ootle'

// ── Mnemonic → Tari SecretKeyWallet ─────────────────────────────────────────
// BIP-39 seed (64 bytes via PBKDF2-HMAC-SHA512) → domain-separated into two
// independent Ristretto255 scalars: SHA-512(seed‖0x01) mod L = ownerSecretKey,
// SHA-512(seed‖0x02) mod L = viewOnlySecret. The 0x01/0x02 domain bytes ensure
// the two keys are fully independent even though they share the same seed.

// Ristretto255 scalar field order (little-endian). A secret key must be in [0, L).
// Raw BIP-39 seed bytes fail ~9% of the time; proper hash-to-scalar (RFC 8032 §5.2.5)
// always yields a valid canonical scalar.
const RISTRETTO_L =
  7237005577332262213973186563042994240857116359379907606001950938285454250989n

function reduceModL(bytes: Uint8Array): Uint8Array {
  // Interpret bytes as a little-endian unsigned integer, reduce mod L.
  let n = 0n
  for (let i = 0; i < bytes.length; i++) n += BigInt(bytes[i]) << (8n * BigInt(i))
  const s = n % RISTRETTO_L
  const out = new Uint8Array(32)
  let tmp = s
  for (let i = 0; i < 32; i++) { out[i] = Number(tmp & 0xffn); tmp >>= 8n }
  return out
}

// Derive a pair of valid Ristretto scalars from a BIP-39 seed via domain-separated
// SHA-512 → mod-L reduction. This is deterministic: same mnemonic → same scalars
// → same otl_esm_ address. Domain bytes 0x01/0x02 ensure owner ≠ view.
async function seedToOotleKeys(seed: Uint8Array): Promise<{ ownerSecretKey: Uint8Array; viewOnlySecret: Uint8Array }> {
  const ownerInput = new Uint8Array(seed.length + 1)
  ownerInput.set(seed)
  ownerInput[seed.length] = 0x01

  const viewInput = new Uint8Array(seed.length + 1)
  viewInput.set(seed)
  viewInput[seed.length] = 0x02

  const [ownerHash, viewHash] = await Promise.all([
    crypto.subtle.digest('SHA-512', ownerInput),
    crypto.subtle.digest('SHA-512', viewInput),
  ])

  return {
    ownerSecretKey: reduceModL(new Uint8Array(ownerHash)),
    viewOnlySecret: reduceModL(new Uint8Array(viewHash)),
  }
}

export async function seedFromMnemonic(mnemonic: string): Promise<Uint8Array> {
  return mnemonicToSeed(mnemonic.trim().toLowerCase())
}

export async function walletFromSeed(seed: Uint8Array): Promise<SecretKeyWallet> {
  const { ownerSecretKey, viewOnlySecret } = await seedToOotleKeys(seed)
  return SecretKeyWallet.fromSecretKey(ownerSecretKey, Network.Esmeralda, viewOnlySecret)
}

export async function walletFromMnemonic(mnemonic: string): Promise<SecretKeyWallet> {
  return walletFromSeed(await seedFromMnemonic(mnemonic))
}
