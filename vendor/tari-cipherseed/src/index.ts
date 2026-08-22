// Public API surface. See README.md for usage; each module's own header comment documents
// exactly which upstream Rust source it reproduces byte-for-byte.

export {
  type WalletSeed,
  InvalidRecoveryPhraseError,
  randomWalletSeed,
  encipherSeed,
  decipherSeed,
  createWalletSeed,
  importWalletSeed,
  isPlausibleMnemonic,
  seedToMnemonic,
  serializeSeed,
  deserializeSeed,
} from "./cipherSeed";

export { type DerivedAccountKeys, deriveAccountKeys } from "./derivation";

export {
  type MnemonicLanguage,
  MNEMONIC_LANGUAGES,
  UnknownMnemonicLanguageError,
  bytesToWords,
  detectMnemonicLanguage,
  wordsToBytes,
} from "./mnemonic";

export { WORDLIST } from "./wordlist";
export { WORDLIST_CHINESE_SIMPLIFIED } from "./wordlists/chineseSimplified";
export { WORDLIST_FRENCH } from "./wordlists/french";
export { WORDLIST_ITALIAN } from "./wordlists/italian";
export { WORDLIST_JAPANESE } from "./wordlists/japanese";
export { WORDLIST_KOREAN } from "./wordlists/korean";
export { WORDLIST_SPANISH } from "./wordlists/spanish";

// Lower-level primitives, exported for anyone deriving a *different* key branch/label under
// Tari's KeyManagerDomain than the "account"/"view_only_key" pair `deriveAccountKeys` covers.
export { DomainSeparatedHasher, KEY_MANAGER_DOMAIN, KEY_MANAGER_DOMAIN_VERSION, keyManagerDomainHasher } from "./domainHash";
export { crc32 } from "./crc32";
