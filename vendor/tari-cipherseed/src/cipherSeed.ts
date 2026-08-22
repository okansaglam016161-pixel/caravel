// Tari's official `CipherSeed` format (version 2), reproducing
// base_layer/common_types/src/seeds/cipher_seed.rs byte-for-byte, so recovery phrases generated
// here import into (and phrases from) the official wallet daemon/Aurora/desktop wallet.
//
// Layout of the 33-byte enciphered blob: version(1) ‖ [birthday(2) ‖ entropy(16) ‖ mac(5)]
// encrypted(23) ‖ salt(5) ‖ crc32(preceding 29 bytes)(4).
//
// Scope limit: this extension always uses Tari's documented default passphrase
// ("TARI_CIPHER_SEED", used whenever no passphrase is set) rather than exposing a seed-specific
// passphrase as a secret separate from the wallet's unlock password. Importing a phrase that was
// created elsewhere WITH a custom seed passphrase will fail to decrypt here with a clear error.
import { chacha20 } from "@noble/ciphers/chacha.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { crc32 } from "./crc32";
import { keyManagerDomainHasher } from "./domainHash";
import { type MnemonicLanguage, bytesToWords, detectMnemonicLanguage, wordsToBytes } from "./mnemonic";
// Vendored, minimally patched: upstream hash-wasm rejects a zero-length Argon2 password, which
// Tari's CipherSeed format allows explicitly. See vendor/hash-wasm-patched/README.md.
import { argon2d } from "../vendor/hash-wasm-patched/index.esm.js";

const VERSION = 2;
const BIRTHDAY_BYTES = 2;
const ENTROPY_BYTES = 16;
const MAIN_SALT_BYTES = 5;
const ARGON2_SALT_BYTES = 16;
const MAC_BYTES = 5;
const ENCRYPTION_KEY_BYTES = 32;
const MAC_KEY_BYTES = 32;
const CHECKSUM_BYTES = 4;
const ENCIPHERED_BYTES = 1 + BIRTHDAY_BYTES + ENTROPY_BYTES + MAC_BYTES + MAIN_SALT_BYTES + CHECKSUM_BYTES; // 33
const DEFAULT_PASSPHRASE = "TARI_CIPHER_SEED";
const BIRTHDAY_GENESIS_UNIX_SECONDS = 1640995200; // 2022-01-01 00:00:00 UTC
const SECONDS_PER_DAY = 24 * 60 * 60;

export interface WalletSeed {
  birthday: number; // days since BIRTHDAY_GENESIS_UNIX_SECONDS, u16
  entropy: Uint8Array; // 16 bytes
  salt: Uint8Array; // 5 bytes
}

function u16le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Validates the public-API boundary shape of a caller-supplied `WalletSeed` before it's used to derive or
 * encrypt anything. Without this, wrong-length entropy/salt silently changes the enciphered blob's length
 * (rejected downstream, opaquely) and an out-of-range birthday is silently truncated by `u16le` rather than
 * rejected outright. */
function assertValidWalletSeed(seed: WalletSeed): void {
  if (seed.entropy.length !== ENTROPY_BYTES) {
    throw new Error(`Invalid WalletSeed: entropy must be ${ENTROPY_BYTES} bytes, got ${seed.entropy.length}.`);
  }
  if (seed.salt.length !== MAIN_SALT_BYTES) {
    throw new Error(`Invalid WalletSeed: salt must be ${MAIN_SALT_BYTES} bytes, got ${seed.salt.length}.`);
  }
  if (!Number.isInteger(seed.birthday) || seed.birthday < 0 || seed.birthday > 0xffff) {
    throw new Error(`Invalid WalletSeed: birthday must be an integer in [0, 65535] (u16), got ${seed.birthday}.`);
  }
}

function randomBirthday(): number {
  const days = Math.floor((Date.now() / 1000 - BIRTHDAY_GENESIS_UNIX_SECONDS) / SECONDS_PER_DAY);
  return Math.max(0, Math.min(0xffff, days));
}

export function randomWalletSeed(): WalletSeed {
  return {
    birthday: randomBirthday(),
    entropy: crypto.getRandomValues(new Uint8Array(ENTROPY_BYTES)),
    salt: crypto.getRandomValues(new Uint8Array(MAIN_SALT_BYTES)),
  };
}

async function deriveKeys(passphrase: string, salt: Uint8Array): Promise<{ encryptionKey: Uint8Array; macKey: Uint8Array }> {
  const argon2Salt = keyManagerDomainHasher("cipher_seed_pbkdf_salt", 32).chain(salt).finalize().slice(0, ARGON2_SALT_BYTES);
  const mainKey = await argon2d({
    password: utf8ToBytes(passphrase),
    salt: argon2Salt,
    parallelism: 1,
    iterations: 1,
    memorySize: 46 * 1024,
    hashLength: ENCRYPTION_KEY_BYTES + MAC_KEY_BYTES,
    outputType: "binary",
  });
  return { encryptionKey: mainKey.slice(0, ENCRYPTION_KEY_BYTES), macKey: mainKey.slice(ENCRYPTION_KEY_BYTES) };
}

function generateMac(version: number, birthdayBytes: Uint8Array, entropy: Uint8Array, salt: Uint8Array, macKey: Uint8Array): Uint8Array {
  return keyManagerDomainHasher("cipher_seed_mac", 32)
    .chain(new Uint8Array([version]))
    .chain(birthdayBytes)
    .chain(entropy)
    .chain(salt)
    .chain(macKey)
    .finalize()
    .slice(0, MAC_BYTES);
}

function applyStreamCipher(data: Uint8Array, encryptionKey: Uint8Array, salt: Uint8Array): Uint8Array {
  const nonce = keyManagerDomainHasher("cipher_seed_encryption_nonce", 32).chain(salt).finalize().slice(0, 12);
  return chacha20(encryptionKey, nonce, data);
}

/** Enciphers a seed into the 33-byte blob that gets encoded as the 24-word recovery phrase. */
export async function encipherSeed(seed: WalletSeed, passphrase: string = DEFAULT_PASSPHRASE): Promise<Uint8Array> {
  assertValidWalletSeed(seed);
  const { encryptionKey, macKey } = await deriveKeys(passphrase, seed.salt);
  const birthdayBytes = u16le(seed.birthday);
  const mac = generateMac(VERSION, birthdayBytes, seed.entropy, seed.salt, macKey);

  const secretData = applyStreamCipher(concatBytes(birthdayBytes, seed.entropy, mac), encryptionKey, seed.salt);

  const withoutChecksum = concatBytes(new Uint8Array([VERSION]), secretData, seed.salt);
  const checksum = u32le(crc32(withoutChecksum));
  return concatBytes(withoutChecksum, checksum);
}

export class InvalidRecoveryPhraseError extends Error {}

/** Reverses `encipherSeed`. Throws `InvalidRecoveryPhraseError` for any structural or MAC failure
 * (wrong words, wrong version, or a phrase enciphered with a passphrase this extension doesn't
 * support). */
export async function decipherSeed(enciphered: Uint8Array, passphrase: string = DEFAULT_PASSPHRASE): Promise<WalletSeed> {
  if (enciphered.length !== ENCIPHERED_BYTES) {
    throw new InvalidRecoveryPhraseError("Recovery phrase decodes to the wrong length.");
  }
  const version = enciphered[0]!;
  if (version !== VERSION) {
    throw new InvalidRecoveryPhraseError(`Unsupported recovery phrase version ${version}.`);
  }

  const withoutChecksum = enciphered.slice(0, ENCIPHERED_BYTES - CHECKSUM_BYTES);
  const checksum = enciphered.slice(ENCIPHERED_BYTES - CHECKSUM_BYTES);
  const expectedChecksum = u32le(crc32(withoutChecksum));
  if (!constantTimeEqual(checksum, expectedChecksum)) {
    throw new InvalidRecoveryPhraseError("Recovery phrase is invalid (checksum mismatch) — check the word order and spelling.");
  }

  const salt = withoutChecksum.slice(1 + BIRTHDAY_BYTES + ENTROPY_BYTES + MAC_BYTES);
  const { encryptionKey, macKey } = await deriveKeys(passphrase, salt);

  const secretData = applyStreamCipher(withoutChecksum.slice(1, 1 + BIRTHDAY_BYTES + ENTROPY_BYTES + MAC_BYTES), encryptionKey, salt);
  const birthdayBytes = secretData.slice(0, BIRTHDAY_BYTES);
  const entropy = secretData.slice(BIRTHDAY_BYTES, BIRTHDAY_BYTES + ENTROPY_BYTES);
  const mac = secretData.slice(BIRTHDAY_BYTES + ENTROPY_BYTES);

  const expectedMac = generateMac(version, birthdayBytes, entropy, salt, macKey);
  if (!constantTimeEqual(mac, expectedMac)) {
    throw new InvalidRecoveryPhraseError("Couldn't decrypt this recovery phrase — check the word order and spelling.");
  }

  const birthday = birthdayBytes[0]! | (birthdayBytes[1]! << 8);
  return { birthday, entropy, salt };
}

// ---- Higher-level API used by background/index.ts ----

export async function createWalletSeed(
  language: MnemonicLanguage = "english",
): Promise<{ seed: WalletSeed; mnemonic: string }> {
  const seed = randomWalletSeed();
  const enciphered = await encipherSeed(seed);
  return { seed, mnemonic: bytesToWords(enciphered, language).join(" ") };
}

/** Parses and decrypts a 24-word recovery phrase in any of Tari's 7 supported languages — the language is
 * auto-detected from the words themselves (see `detectMnemonicLanguage`), matching upstream's default
 * `from_mnemonic` behavior rather than requiring the caller to know which language a phrase was created in. */
export async function importWalletSeed(mnemonic: string): Promise<WalletSeed> {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 24) throw new InvalidRecoveryPhraseError("Recovery phrase must be exactly 24 words.");
  let enciphered: Uint8Array;
  try {
    const language = detectMnemonicLanguage(words);
    enciphered = wordsToBytes(words, language);
  } catch {
    throw new InvalidRecoveryPhraseError(
      "Recovery phrase contains a word that isn't in any supported language's wordlist, or mixes words from more than one language.",
    );
  }
  return decipherSeed(enciphered);
}

/** Fast, synchronous, passphrase-independent structural check (word count, wordlist membership,
 * version, CRC32) for live input feedback while the user types/pastes — does not run the
 * expensive Argon2d pass, so it can't detect a wrong-but-well-formed phrase (that's what
 * `importWalletSeed` is for, on actual submit). Language is auto-detected, same as `importWalletSeed`. */
export function isPlausibleMnemonic(mnemonic: string): boolean {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 24) return false;
  let enciphered: Uint8Array;
  try {
    const language = detectMnemonicLanguage(words);
    enciphered = wordsToBytes(words, language);
  } catch {
    return false;
  }
  if (enciphered[0] !== VERSION) return false;
  const withoutChecksum = enciphered.slice(0, ENCIPHERED_BYTES - CHECKSUM_BYTES);
  const checksum = enciphered.slice(ENCIPHERED_BYTES - CHECKSUM_BYTES);
  return constantTimeEqual(checksum, u32le(crc32(withoutChecksum)));
}

/** Deterministically re-enciphers a stored seed back into the same mnemonic shown at creation
 * time — reproducible only because `serializeSeed` persists `salt`/`birthday` too, not just
 * `entropy`; a freshly-random salt would produce a different-looking (but equally valid) phrase. */
export async function seedToMnemonic(seed: WalletSeed, language: MnemonicLanguage = "english"): Promise<string> {
  const enciphered = await encipherSeed(seed);
  return bytesToWords(enciphered, language).join(" ");
}

const SERIALIZED_SEED_BYTES = 1 + BIRTHDAY_BYTES + ENTROPY_BYTES + MAIN_SALT_BYTES; // 24

export function serializeSeed(seed: WalletSeed): Uint8Array {
  assertValidWalletSeed(seed);
  return concatBytes(new Uint8Array([VERSION]), u16le(seed.birthday), seed.entropy, seed.salt);
}

export function deserializeSeed(bytes: Uint8Array): WalletSeed {
  if (bytes.length !== SERIALIZED_SEED_BYTES || bytes[0] !== VERSION) {
    throw new Error("Internal error: corrupt stored wallet seed.");
  }
  const birthdayBytes = bytes.slice(1, 1 + BIRTHDAY_BYTES);
  return {
    birthday: birthdayBytes[0]! | (birthdayBytes[1]! << 8),
    entropy: bytes.slice(1 + BIRTHDAY_BYTES, 1 + BIRTHDAY_BYTES + ENTROPY_BYTES),
    salt: bytes.slice(1 + BIRTHDAY_BYTES + ENTROPY_BYTES),
  };
}
