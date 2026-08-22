// Byte-string <-> mnemonic-word codec, reproducing Tari's `to_bytes`/`from_bytes` and
// `MnemonicLanguage` (base_layer/common_types/src/seeds/{mnemonic,mnemonic_wordlists}.rs)
// byte-for-byte for the one length this codebase ever uses it at: exactly 33 bytes <-> 24 words
// (264 bits, divides evenly both ways: 33*8 = 24*11 = 264) — NOT the standard BIP-39 codec. Each
// word encodes 11 bits (log2(2048)); the byte array and the word sequence both represent the same
// 264-bit integer, just in base-256 and base-2048 respectively, least-significant digit first.
// There's no embedded checksum here (CipherSeed's own CRC32 + MAC are the integrity checks — see
// cipherSeed.ts); Tari's own codec instead zero-pads misaligned lengths, a case that can't arise
// for our fixed 33-byte input, so mismatched lengths are treated as a bug and rejected outright
// rather than silently padded.
//
// Tari supports 7 mnemonic languages. Four of them (English, French, Italian, Spanish) store their
// wordlist with diacritics already stripped, and accept an imported word with or without the
// original accents by folding the input through `removeDiacritics` before matching (see
// diacritics.ts) — so "légion"/"legion" both resolve to the same French word. The other three
// (Chinese Simplified, Japanese, Korean) have no Latin diacritics and skip that step. Every
// wordlist is confirmed byte-identical, same order, to Tari's own `MNEMONIC_*_WORDS` constants.
import { removeDiacritics } from "./diacritics";
import { WORDLIST_CHINESE_SIMPLIFIED } from "./wordlists/chineseSimplified";
import { WORDLIST_FRENCH } from "./wordlists/french";
import { WORDLIST_ITALIAN } from "./wordlists/italian";
import { WORDLIST_JAPANESE } from "./wordlists/japanese";
import { WORDLIST_KOREAN } from "./wordlists/korean";
import { WORDLIST_SPANISH } from "./wordlists/spanish";
import { WORDLIST as WORDLIST_ENGLISH } from "./wordlist";

const BITS_PER_WORD = 11;

/** Matches Rust's `MnemonicLanguage` variants (serde `snake_case` rename), including enum iteration order —
 * `detectMnemonicLanguage` tries languages in this exact order, which matters when a word is valid in more than
 * one language's wordlist. */
export type MnemonicLanguage =
  | "chinese_simplified"
  | "english"
  | "french"
  | "italian"
  | "japanese"
  | "korean"
  | "spanish";

export const MNEMONIC_LANGUAGES: readonly MnemonicLanguage[] = [
  "chinese_simplified",
  "english",
  "french",
  "italian",
  "japanese",
  "korean",
  "spanish",
];

const WORDLISTS: Readonly<Record<MnemonicLanguage, readonly string[]>> = {
  chinese_simplified: WORDLIST_CHINESE_SIMPLIFIED,
  english: WORDLIST_ENGLISH,
  french: WORDLIST_FRENCH,
  italian: WORDLIST_ITALIAN,
  japanese: WORDLIST_JAPANESE,
  korean: WORDLIST_KOREAN,
  spanish: WORDLIST_SPANISH,
};

/** Languages whose wordlist is stored diacritic-free and whose imported words are folded through
 * `removeDiacritics` before matching. Matches the Rust source's own match arms exactly — Chinese
 * Simplified, Japanese, and Korean are deliberately excluded (no Latin diacritics to fold). */
const LATIN_DIACRITIC_LANGUAGES: ReadonlySet<MnemonicLanguage> = new Set(["english", "french", "italian", "spanish"]);

const WORD_INDEXES: Readonly<Record<MnemonicLanguage, Map<string, number>>> = Object.fromEntries(
  MNEMONIC_LANGUAGES.map((language) => [language, new Map(WORDLISTS[language].map((w, i) => [w, i]))]),
) as Record<MnemonicLanguage, Map<string, number>>;

export class UnknownMnemonicLanguageError extends Error {}

/** Normalizes a candidate word the same way `find_mnemonic_index_from_word` does: always lowercased, and
 * additionally diacritic-folded for the four Latin-script languages. */
function normalizeForLookup(word: string, language: MnemonicLanguage): string {
  const lower = word.toLowerCase();
  return LATIN_DIACRITIC_LANGUAGES.has(language) ? removeDiacritics(lower) : lower;
}

function findMnemonicIndexFromWord(word: string, language: MnemonicLanguage): number | undefined {
  return WORD_INDEXES[language].get(normalizeForLookup(word, language));
}

/** Detects which language a full mnemonic phrase is written in, reproducing
 * `MnemonicLanguage::detect_language` exactly, including its "try languages the first word matches, in enum
 * order, and accept the first one every other word is also valid in" search strategy (not simply "the language
 * every word matches" computed all at once) and its quirk of comparing words by string equality rather than
 * position when deciding which ones to cross-check. */
export function detectMnemonicLanguage(words: string[]): MnemonicLanguage {
  if (words.length === 0) throw new UnknownMnemonicLanguageError("No words to detect a language from.");

  if (words.length === 1) {
    const word = words[0]!;
    for (const language of MNEMONIC_LANGUAGES) {
      if (findMnemonicIndexFromWord(word, language) !== undefined) return language;
    }
    throw new UnknownMnemonicLanguageError(`"${word}" is not a valid word in any supported language.`);
  }

  for (const word of words) {
    const candidates = MNEMONIC_LANGUAGES.filter((language) => findMnemonicIndexFromWord(word, language) !== undefined);
    for (const language of candidates) {
      const consistent = words.every(
        (compare) => compare === word || findMnemonicIndexFromWord(compare, language) !== undefined,
      );
      if (consistent) return language;
    }
  }

  throw new UnknownMnemonicLanguageError("Could not detect a single consistent language for these words.");
}

export function bytesToWords(bytes: Uint8Array, language: MnemonicLanguage = "english"): string[] {
  if ((bytes.length * 8) % BITS_PER_WORD !== 0) {
    throw new Error(`Internal error: ${bytes.length} bytes does not pack into a whole number of words`);
  }
  const wordlist = WORDLISTS[language];
  let rest = 0n;
  let restBits = 0;
  const words: string[] = [];
  for (const byte of bytes) {
    rest |= BigInt(byte) << BigInt(restBits);
    restBits += 8;
    while (restBits >= BITS_PER_WORD) {
      const index = Number(rest & 0x7ffn);
      const word = wordlist[index];
      if (word === undefined) throw new Error(`Internal error: wordlist index ${index} out of range`);
      words.push(word);
      rest >>= BigInt(BITS_PER_WORD);
      restBits -= BITS_PER_WORD;
    }
  }
  return words;
}

/** Decodes a mnemonic phrase using an explicit language (skips auto-detection — see
 * `detectMnemonicLanguage` for the language-agnostic entry point `cipherSeed.ts` actually uses). */
export function wordsToBytes(words: string[], language: MnemonicLanguage = "english"): Uint8Array {
  if ((words.length * BITS_PER_WORD) % 8 !== 0) {
    throw new Error(`Internal error: ${words.length} words does not pack into a whole number of bytes`);
  }
  const bytes: number[] = [];
  let rest = 0n;
  let restBits = 0;
  for (const rawWord of words) {
    const index = findMnemonicIndexFromWord(rawWord, language);
    if (index === undefined) throw new Error(`"${rawWord}" is not a valid recovery-phrase word in ${language}`);
    rest |= BigInt(index) << BigInt(restBits);
    restBits += BITS_PER_WORD;
    while (restBits >= 8) {
      bytes.push(Number(rest & 0xffn));
      rest >>= 8n;
      restBits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
