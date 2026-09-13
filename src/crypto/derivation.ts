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
//   MAINNET DELETION: remove the 'bip39' arm of deriveIdentity(), step 3 of detectScheme(), the
//   absent-marker branch of resolveScheme(), and legacyBip39.ts. Nothing else should need touching
//   — no other module in the app is aware that more than one derivation ever existed.

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
 * Turns a phrase into the Tari wallet and the Nostr identity, by the given scheme.
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
  return { wallet, nostr: await nostrFromCipherSeedEntropy(seed.entropy) }
}

async function deriveFromBip39(phrase: string): Promise<WalletIdentity> {
  // Untouched legacy behaviour: one 64-byte BIP-39 seed feeding both branches, exactly as before
  // the migration. See legacyBip39.ts.
  const seed = await seedFromMnemonic(phrase)
  return { wallet: await walletFromSeed(seed), nostr: deriveNostrKeyFromSeed(seed) }
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Both formats are matched case-insensitively on whitespace-separated words. */
function normalise(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

function isValidBip39(phrase: string): boolean {
  return validateMnemonic(normalise(phrase), wordlist)
}
