//   The ONLY module that knows a Caravel recovery phrase can be one of two formats.
//
//   Caravel now issues Tari's own CipherSeed phrases, which official Tari wallets can import. Every
//   wallet created before that switch used BIP-39 with a Caravel-specific key derivation, and those
//   wallets must keep opening at exactly the same address and Nostr identity — so both paths live
//   here, side by side, until BIP-39 is dropped for mainnet.
//
//   Both formats are 24 English words drawn from the SAME 2048-word list (Tari's English wordlist
//   is byte-identical to BIP-39's), so a phrase cannot be identified by looking at it. They are
//   told apart structurally, and the asymmetry in how strongly each self-identifies drives the
//   whole design:
//
//     CipherSeed  33 bytes: version byte (must be 2) + CRC32 over the preceding 29.  ~2^-40
//     BIP-39      32 bytes of entropy + a single checksum byte.                      ~2^-8
//
//   MAINNET DELETION: remove the 'bip39' arm of deriveIdentity(), the 'bip39' arm of
//   storeKeyForPhrase(), step 3 of detectScheme(), the absent-marker branch of resolveScheme(), and
//   legacyBip39.ts. Nothing else should need touching — no other module in the app is aware that
//   more than one derivation ever existed.

import { entropyToMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { Network } from '@tari-project/ootle'
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import {
  DomainSeparatedHasher,
  deriveAccountKeys,
  importWalletSeed,
  isPlausibleMnemonic,
} from 'tari-cipherseed'
import { deriveNostrKeyFromSeed, type NostrIdentity } from './nostrCrypto'
import { seedFromMnemonic, walletFromSeed } from './legacyBip39'
import type { StoredWallet } from './walletCrypto'

/** How a stored phrase becomes keys. Persisted in StoredWallet.scheme. */
export type DerivationScheme = 'cipherseed' | 'bip39'

/**
 * What detectScheme() can conclude about a phrase whose provenance we don't know.
 * 'ambiguous' is deliberately NOT resolved here — see detectScheme().
 */
export type DetectedScheme = DerivationScheme | 'ambiguous' | 'invalid'

export interface WalletIdentity {
  wallet: SecretKeyWallet
  nostr: NostrIdentity
  /**
   * The key every sealed local store is encrypted under, for THIS wallet.
   *
   * Returned from here rather than derived beside it because this is where the seed material already
   * is: the CipherSeed entropy after importWalletSeed, or the 64-byte seed after seedFromMnemonic.
   * Deriving it anywhere else means paying for that material twice — Argon2d, in the CipherSeed case
   * — to arrive at the same bytes. See storeKeyFromSeedMaterial.
   */
  storeKey: Uint8Array
}

/**
 * The account index Caravel derives at, for CipherSeed wallets.
 *
 * Verified against tari_ootle_walletd 0.39.0: on first start with an imported phrase the daemon
 * sweeps key indices upward and marks the FIRST recovered account as the default — index 0. Derive
 * anywhere else and an imported Caravel phrase would open a real, empty, WRONG account in official
 * Tari software, which looks exactly like lost funds. Pinned by cipherSeedInterop.test.ts.
 */
const ACCOUNT_INDEX = 0

/**
 * Caravel's own hashing domain for deriving a Nostr identity from CipherSeed entropy.
 *
 * FROZEN. Once any CipherSeed wallet exists, changing this string — or the label, or the byte
 * length below — silently changes every npub derived from it: new identity, contacts gone, chat
 * history orphaned, with no error to explain it. Pinned by a golden vector in derivation.test.ts.
 *
 * Deliberately Caravel's own namespace rather than Tari's KeyManagerDomain: this is not a Tari key
 * and has no business claiming a Tari domain.
 */
const NOSTR_DOMAIN = 'com.caravel.nostr'
const NOSTR_DOMAIN_VERSION = 1
const NOSTR_LABEL = 'nostr_entropy'
/** 16 bytes = BIP-39's 128-bit entropy size, which encodes to a 12-word mnemonic. */
const NOSTR_ENTROPY_BYTES = 16

/**
 * Caravel's own hashing domain for the STORE KEY — the symmetric key every sealed local store is
 * encrypted under at rest.
 *
 * FROZEN, exactly as frozen as NOSTR_DOMAIN above and for a worse failure. Change this string, the
 * version, the label or the byte length, and every wallet on every device derives a DIFFERENT store
 * key from the same phrase: messages, contacts, nicknames, groups, the journal and the transaction
 * history all stop decrypting at once, with no error anywhere. The stores read as empty, the
 * never-clobber guards then refuse to write over them, and the user is left with a wallet that has
 * lost its history and cannot record new history either. Pinned by golden vectors in
 * derivation.test.ts — if those fail, the derivation drifted; do not update them.
 *
 * ── DERIVED FROM THE WALLET SEED, NEVER FROM THE NOSTR KEY ───────────────────
 *
 * The Nostr secret is the tempting input: uniform across both schemes, already in hand, no arms
 * needed. It is the wrong one, because `nsec` is MEANT to leave — exporting it to another Nostr
 * client is an ordinary thing to do, and it must not also hand over the key to every message on
 * disk. This is the mirror image of the argument nostrFromCipherSeedEntropy already makes in the
 * other direction, where entropy is hashed BEFORE it can be exported as words. There is a test
 * asserting this rather than a comment hoping for it.
 *
 * ── ROTATION: RESERVED, NOT BUILT ────────────────────────────────────────────
 *
 * STORE_LABEL is rotation 0, and stays byte-identical forever. A future rotation N would use
 * `store_key.r<N>`, chosen by a plaintext per-identity counter — plaintext because a counter is not
 * a secret, per-identity because rotating one wallet must not disturb another.
 *
 * The counter belongs in the LABEL precisely so that LOSING IT IS NOT A STRANDING PATH: a reader
 * tries 0, then 1, then 2, and one of them opens the record. That is the whole lesson of the salt
 * this derivation replaces — a single unrecoverable input, silently re-minted, took every store with
 * it. Nothing here implements rotation; this is the shape it has to fit when it does, so that
 * shipping it never has to change the label for rotation 0.
 */
const STORE_DOMAIN = 'com.caravel.store'
const STORE_DOMAIN_VERSION = 1
/** Rotation 0. Read the rotation note above before ever writing a second value here. */
const STORE_LABEL = 'store_key'
/** 32 bytes — the key width storeCrypto's XChaCha20-Poly1305 takes. */
const STORE_KEY_BYTES = 32

// ── Scheme resolution: for a wallet we already stored ────────────────────────

export interface ResolvedScheme {
  scheme: DerivationScheme
  /**
   * True when the stored record carried no marker and we had to establish the scheme from the
   * phrase itself. The caller should persist the resolved scheme so the next unlock is a plain
   * lookup. Purely an optimisation for legacy wallets; a correctness repair in the self-heal case.
   */
  markerWasMissing: boolean
}

/**
 * Decides how a STORED phrase should be derived. Deterministic, and deliberately not the same
 * thing as detectScheme(): here we have a record we wrote ourselves, so we trust what we recorded
 * instead of re-deriving the answer from content every unlock.
 *
 * That matters. Content detection is excellent (~2^-40) but not free of risk, and there is no
 * reason to take even that risk on a phrase whose format we already know. It also means an existing
 * BIP-39 user pays no Argon2d cost at unlock — the CipherSeed path is never entered for them.
 *
 * The absent-marker case is not a guess either: the field was introduced WITH CipherSeed support,
 * so any record lacking it was written when BIP-39 was the only thing that existed.
 *
 * @throws if the record has no marker and the phrase is not valid under either format — that means
 *   the stored blob is corrupt, and inventing an answer would open some arbitrary wallet silently.
 */
export function resolveScheme(stored: StoredWallet, phrase: string): ResolvedScheme {
  if (stored.scheme === 'cipherseed' || stored.scheme === 'bip39') {
    return { scheme: stored.scheme, markerWasMissing: false }
  }

  // No marker. Expected for every pre-migration wallet, whose phrase must be valid BIP-39: it
  // either came from createMnemonic() (generateMnemonic, checksum-valid by construction) or from
  // restore, which rejects a phrase that fails detectScheme before ever storing it. Both
  // entry points are closed, so this check cannot be dodged by a real wallet.
  if (isValidBip39(phrase)) return { scheme: 'bip39', markerWasMissing: true }

  // Not valid BIP-39, so it cannot be a legacy wallet. If it parses as CipherSeed then this is a
  // CipherSeed wallet that lost its marker (a partial write, a hand-edited record); adopting it and
  // rewriting the marker is a repair, not a guess, because the BIP-39 check above already ruled out
  // the only other thing it could have been.
  if (isPlausibleMnemonic(phrase)) return { scheme: 'cipherseed', markerWasMissing: true }

  throw new Error(
    'Stored wallet is unreadable: the saved recovery phrase is not valid under any supported format.',
  )
}

// ── Scheme detection: for a phrase a user just typed ─────────────────────────

/**
 * Works out which format an UNTRUSTED phrase is in — the restore path, where a phrase arrives with
 * no provenance and could have come from an official Tari wallet, from old Caravel, or from a typo.
 *
 * Order is not stylistic. CipherSeed is checked first because its structural check is roughly four
 * billion times stronger (version byte + CRC32, ~2^-40) than BIP-39's single checksum byte (~2^-8).
 * Reversing the order would misread roughly 1 in 256 genuine CipherSeed phrases as BIP-39 and
 * silently derive the wrong wallet. In this order the equivalent mistake needs a ~2^-40 collision.
 *
 * The CipherSeed check here is the cheap one — word count, wordlist membership, version byte and
 * CRC32. It does NOT run Argon2d, so detection stays instant and a wrong-format phrase is rejected
 * before any expensive work happens.
 */
export function detectScheme(phrase: string): DetectedScheme {
  const words = normalise(phrase).split(' ').filter(Boolean)
  if (words.length !== 24) return 'invalid'
  const normalised = words.join(' ')

  const looksCipherSeed = isPlausibleMnemonic(normalised)
  const looksBip39 = isValidBip39(normalised)

  // A phrase satisfying BOTH is a ~2^-40 coincidence that should never be observed. It is reported
  // rather than silently resolved: with funds involved, "cannot happen" and "undefined behaviour"
  // are different things, and the honest move is to ask the user which wallet they meant.
  if (looksCipherSeed && looksBip39) return 'ambiguous'
  if (looksCipherSeed) return 'cipherseed'
  if (looksBip39) return 'bip39'
  return 'invalid'
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * Turns a phrase into the Tari wallet, the Nostr identity, and the store key, by the given scheme.
 *
 * THE STORE KEY RIDES ALONG because the seed material it needs is computed here anyway. That is not
 * tidiness: deriving it separately would re-run importWalletSeed's Argon2d for a value this function
 * already has the input for, doubling the cost of every unlock to reach identical bytes.
 *
 * The scheme is a parameter rather than something this function sniffs: callers already know it,
 * either from the stored marker (resolveScheme) or from an explicit detection the user has
 * confirmed (detectScheme). Re-deriving it here would reintroduce guessing at the exact point
 * where a wrong answer costs the most.
 */
export async function deriveIdentity(
  phrase: string,
  scheme: DerivationScheme,
): Promise<WalletIdentity> {
  const normalised = normalise(phrase)
  return scheme === 'cipherseed'
    ? deriveFromCipherSeed(normalised)
    : deriveFromBip39(normalised)
}

async function deriveFromCipherSeed(phrase: string): Promise<WalletIdentity> {
  // ─────────────────────────────────────────────────────────────────────────
  //  R1 — DO NOT WRAP THIS IN try/catch AND FALL BACK TO BIP-39.
  //
  //  importWalletSeed throws InvalidRecoveryPhraseError when the MAC does not verify, which means
  //  "this IS a CipherSeed phrase and it is wrong" — a typo, a mis-transcription, or a phrase
  //  created with a custom seed passphrase. It does NOT mean "try the other format".
  //
  //  Retrying as BIP-39 here would take a valid CipherSeed phrase with one bad word and silently
  //  open a different, empty, fully functional wallet — no error, no clue, the user's funds and
  //  chat identity apparently gone. This throw is the single line between safe and stranding a
  //  wallet. Pinned by the keystone test in derivation.test.ts.
  // ─────────────────────────────────────────────────────────────────────────
  const seed = await importWalletSeed(phrase)

  const { ownerSecret, viewSecret } = deriveAccountKeys(seed.entropy, ACCOUNT_INDEX)
  const wallet = SecretKeyWallet.fromSecretKey(ownerSecret, Network.Esmeralda, viewSecret)
  return {
    wallet,
    nostr: await nostrFromCipherSeedEntropy(seed.entropy),
    // Free: `seed.entropy` is already here, and the hash is Blake2b over 16 bytes.
    storeKey: storeKeyFromSeedMaterial(seed.entropy),
  }
}

async function deriveFromBip39(phrase: string): Promise<WalletIdentity> {
  // Untouched legacy behaviour: one 64-byte BIP-39 seed feeding both branches, exactly as before
  // the migration. See legacyBip39.ts.
  const seed = await seedFromMnemonic(phrase)
  return {
    wallet: await walletFromSeed(seed),
    nostr: deriveNostrKeyFromSeed(seed),
    // The same 64-byte seed, hashed under Caravel's store domain — never used as a key directly.
    storeKey: storeKeyFromSeedMaterial(seed),
  }
}

// ── Nostr identity for CipherSeed wallets ───────────────────────────────────

/**
 * CipherSeed has no BIP-39 seed to feed NIP-06, so one is constructed from the wallet's entropy:
 *
 *   entropy(16) ──domain-separated Blake2b──▶ nostrEntropy(16) ──BIP-39──▶ 12 words ──▶ NIP-06
 *
 * The domain-separation step is the load-bearing part. Feeding the wallet entropy straight into
 * BIP-39 would also work cryptographically, but the resulting 12-word phrase WOULD ENCODE THE
 * WALLET'S SPENDING ENTROPY — anyone who shared their "Nostr phrase" would be handing over their
 * funds. Hashing first makes it a one-way derivative that is safe to export on its own.
 *
 * Everything downstream is standard and already audited: BIP-39 encoding and seed stretching from
 * @scure/bip39, then deriveNostrKeyFromSeed() unchanged — the same NIP-06 path legacy wallets use.
 *
 * Note the portability that CipherSeed costs us regardless of this choice: because the RECOVERY
 * phrase is no longer BIP-39, no external NIP-06 client can rebuild this identity from the 24
 * words. The 12-word phrase derived here can, which is why deriving it this way leaves that door
 * open for a future export feature.
 */
async function nostrFromCipherSeedEntropy(entropy: Uint8Array): Promise<NostrIdentity> {
  const nostrEntropy = new DomainSeparatedHasher(
    NOSTR_DOMAIN,
    NOSTR_DOMAIN_VERSION,
    NOSTR_LABEL,
    32,
  )
    .chain(entropy)
    .finalize()
    .slice(0, NOSTR_ENTROPY_BYTES)

  const seed = await mnemonicToSeed(entropyToMnemonic(nostrEntropy, wordlist))
  return deriveNostrKeyFromSeed(seed)
}

// ── The store key ───────────────────────────────────────────────────────────

/**
 * Seed material → the 32-byte store key. Pure, synchronous, and the whole of the derivation.
 *
 * SYNCHRONOUS BECAUSE IT CAN BE. This is Blake2b over a few dozen bytes where the design it replaces
 * paid PBKDF2 at 600 000 iterations. That cost bought the PASSWORD's involvement, and the password is
 * exactly what had to go: a store key derived from it changes whenever the password changes, and
 * restore always sets a new password — which is how a restored wallet used to lose its own history
 * the moment it came back.
 *
 * NOT A KDF, AND IT DOES NOT NEED TO BE. A KDF exists to stretch a LOW-entropy secret. The input here
 * is the wallet's own seed material, high-entropy by construction, so a domain-separated hash is the
 * correct primitive — the same one Tari's key manager and Caravel's own Nostr derivation already
 * apply to the same kind of input.
 *
 * WHAT PROTECTS THE STORES AT REST, said plainly because it changed: no longer the password directly,
 * but the seed — which is itself behind the password, inside the wallet record. An attacker holding
 * only the disk must still break that record's PBKDF2 to reach this input, so the work per password
 * guess is what it always was. An attacker holding the PHRASE by other means no longer needs the
 * password to read local history. That is the deliberate, accepted price of a phrase that always
 * recovers its own data, and no user-facing copy may imply otherwise.
 */
export function storeKeyFromSeedMaterial(material: Uint8Array): Uint8Array {
  return new DomainSeparatedHasher(STORE_DOMAIN, STORE_DOMAIN_VERSION, STORE_LABEL, STORE_KEY_BYTES)
    .chain(material)
    .finalize()
}

/**
 * A phrase and its scheme → that wallet's store key.
 *
 * TWO-ARMED FOR THE SAME REASON deriveIdentity is: the two formats hand over different seed material,
 * and this file is the only one allowed to know that. CipherSeed gives 16 bytes of entropy, BIP-39
 * gives the 64-byte seed, and each is fed in AS THE FORMAT PRODUCES IT — no truncation, no
 * re-encoding — so each scheme's golden vector pins the real thing.
 *
 * The arms therefore hash different material, so the same 24 words under the two schemes yield
 * different store keys. That is correct rather than an edge to be smoothed over: they are different
 * wallets, with different addresses and different npubs, whose stores are already namespaced apart on
 * disk.
 *
 * NOT WHAT THE APP CALLS. deriveIdentity hands back the same key from material it already holds, and
 * that is the path create, unlock and restore take — this one re-derives the seed from scratch, which
 * would double the cost of every unlock for identical bytes.
 *
 * It stays because it is the STANDALONE PROVER: the golden vectors are asserted through it, and a
 * test asserts deriveIdentity agrees with it. That pairing is what keeps the pinned values pinned to
 * the live path rather than to a function nothing runs.
 */
export async function storeKeyForPhrase(phrase: string, scheme: DerivationScheme): Promise<Uint8Array> {
  const normalised = normalise(phrase)
  if (scheme === 'cipherseed') {
    return storeKeyFromSeedMaterial((await importWalletSeed(normalised)).entropy)
  }
  // LEGACY (BIP-39) ONLY — goes with the 'bip39' arm of deriveIdentity() when BIP-39 support is
  // dropped for mainnet. The 64-byte seed is the same one deriveFromBip39 feeds to the wallet and to
  // NIP-06; here it is hashed under Caravel's store domain, never used as a key directly.
  return storeKeyFromSeedMaterial(await seedFromMnemonic(normalised))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Both formats are matched case-insensitively on whitespace-separated words. */
function normalise(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

function isValidBip39(phrase: string): boolean {
  return validateMnemonic(normalise(phrase), wordlist)
}
