//   Tests for the format-aware derivation layer: scheme resolution, scheme detection, both
//   derivation paths, and the CipherSeed Nostr identity.
//
//   The most important test in this file — arguably in the repo — is the R1 keystone below. Read
//   that one first.

import { describe, expect, it } from 'vitest'
import { DomainSeparatedHasher, importWalletSeed } from 'tari-cipherseed'
import {
  type DerivationScheme,
  detectScheme,
  deriveIdentity,
  resolveScheme,
  storeKeyForPhrase,
  storeKeyFromSeedMaterial,
} from './derivation'
import type { StoredWallet } from './walletCrypto'

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)))

// A CipherSeed phrase, proven byte-for-byte against tari_ootle_walletd 0.39.0.
const CIPHERSEED =
  'leopard shove teach odor aim ginger atom occur siren avoid hungry hidden cannon mistake electric material lawsuit manage gym slight where list soon hover'

// A checksum-VALID legacy BIP-39 phrase — BIP-39's canonical all-zero-entropy 24-word vector.
// Used wherever detection or scheme resolution is under test, because those paths turn on the
// checksum and so need a phrase a real wallet could actually have.
const BIP39 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

// The phrase from docs/DERIVATION.md, whose address and npub are pinned in
// derivationAnchors.test.ts. NOTE: it is deliberately NOT checksum-valid — @scure's mnemonicToSeed
// does not verify the checksum, so it derives fine and pins the legacy output perfectly, but
// Caravel's own restore screen would reject it. It is a derivation fixture, not a wallet phrase, so
// it is used ONLY where derivation output is asserted and never in a detection test.
const BIP39_DOC_ANCHOR =
  'test test test test test test test test test test test test ' +
  'test test test test test test test test test test test junk'

// A REAL, structurally perfect CipherSeed phrase that cannot be decrypted with Tari's default
// passphrase, because it was enciphered with a custom one ("TestPassphrase123" — from the upstream
// package's own golden vectors). Its version byte and CRC32 verify, so every cheap structural check
// passes and detection correctly calls it CipherSeed; only the MAC — computed from the Argon2d
// keys — reveals that it cannot be opened. That makes it the one fixture that actually exercises
// the MAC-failure path, which is what the keystone below is about.
const CIPHERSEED_MAC_FAILS =
  'gate gadget survey sell great card favorite achieve island surge dice build satisfy chase negative shrimp soap crew hawk next divert robust balance quit'

const storedWith = (scheme?: DerivationScheme): StoredWallet => ({
  version: 1,
  kdf: 'pbkdf2',
  iterations: 600_000,
  salt: 'c2FsdA==',
  iv: 'aXY=',
  ciphertext: 'Y3Q=',
  ...(scheme ? { scheme } : {}),
})

// ════════════════════════════════════════════════════════════════════════════
//  R1 KEYSTONE
// ════════════════════════════════════════════════════════════════════════════
//
//  If exactly one test in this repo must never be deleted, weakened, or made to "just work", it is
//  this one.
//
//  A CipherSeed phrase that fails to decrypt must FAIL. It must not be retried as BIP-39. Both
//  formats are 24 words from the same wordlist, so a BIP-39 retry would very often succeed — and
//  succeeding is the disaster. The user would land in a real, empty, fully functional wallet at a
//  different address with a different Nostr identity, with no error and nothing on screen to
//  suggest anything went wrong. Their funds and chat history would simply appear to be gone.
//
//  Throwing is loud, recoverable, and correct. Falling back is silent and strands the wallet.
// ════════════════════════════════════════════════════════════════════════════
describe('R1 keystone — CipherSeed failure must never fall back to BIP-39', () => {
  it('cipherseed_mac_failure_is_terminal_never_falls_back', async () => {
    // Sanity: this phrase really does pass every cheap structural check, so the ONLY thing standing
    // between it and a wrong wallet is that we refuse to retry after the MAC fails.
    expect(detectScheme(CIPHERSEED_MAC_FAILS)).toBe('cipherseed')

    await expect(deriveIdentity(CIPHERSEED_MAC_FAILS, 'cipherseed')).rejects.toThrow()

    // And prove the negative directly: whatever the BIP-39 path WOULD have produced for this phrase
    // must never be what a caller receives. If a fallback were ever introduced, the call above would
    // resolve instead of rejecting and this is the wallet the user would silently be handed.
    let fellBackTo: string | null = null
    try {
      const { wallet } = await deriveIdentity(CIPHERSEED_MAC_FAILS, 'cipherseed')
      fellBackTo = await wallet.getAddress()
    } catch {
      /* expected — the throw is the whole point */
    }
    expect(fellBackTo).toBeNull()
  }, 30_000)

  it('a CipherSeed phrase with two words swapped is rejected, not silently re-read as BIP-39', async () => {
    // Swapping words corrupts the 33-byte payload, so this one is caught EARLIER than the MAC — at
    // the CRC32 checksum, during detection. Both guards matter: detection stops the malformed case,
    // the terminal throw above stops the structurally-valid-but-undecryptable case. Neither path
    // has a route to the BIP-39 derivation.
    const swapped = CIPHERSEED.replace('list soon hover', 'list hover soon')
    expect(swapped).not.toBe(CIPHERSEED)
    expect(detectScheme(swapped)).toBe('invalid')
    await expect(deriveIdentity(swapped, 'cipherseed')).rejects.toThrow()
  }, 30_000)

  it('a one-word typo in a CipherSeed phrase never resolves to a wallet', async () => {
    const typo = CIPHERSEED.replace('leopard', 'leisure')
    expect(detectScheme(typo)).not.toBe('bip39')
    await expect(deriveIdentity(typo, 'cipherseed')).rejects.toThrow()
  }, 30_000)
})

// ── Scheme detection ────────────────────────────────────────────────────────

describe('detectScheme', () => {
  it('identifies a CipherSeed phrase', () => {
    expect(detectScheme(CIPHERSEED)).toBe('cipherseed')
  })

  it('identifies a legacy BIP-39 phrase', () => {
    expect(detectScheme(BIP39)).toBe('bip39')
  })

  it('identifies every daemon-verified CipherSeed vector as CipherSeed', () => {
    // Sampled across both interop directions — none of them may be mistaken for BIP-39.
    const vectors = [
      'cake edge usual omit blanket boy combine slim exact debris eternal elevator maid hero angle sunset logic outside shy mistake stay game useless client',
      'doctor wolf absent home video edit dust credit spike bike gorilla exhaust enemy exit cause match vast found boat three average inch giraffe involve',
      'able caution child other assault pool stereo ghost worry exhibit hand science rib enough bread very basic vault immense scale size banana marriage quit',
    ]
    for (const phrase of vectors) expect(detectScheme(phrase), phrase.slice(0, 24)).toBe('cipherseed')
  })

  it('rejects a phrase with the wrong word count', () => {
    expect(detectScheme(CIPHERSEED.split(' ').slice(0, 23).join(' '))).toBe('invalid')
    expect(detectScheme(`${CIPHERSEED} extra`)).toBe('invalid')
    expect(detectScheme('')).toBe('invalid')
  })

  it('rejects a phrase containing a word outside the wordlist', () => {
    expect(detectScheme(CIPHERSEED.replace('leopard', 'notaword'))).toBe('invalid')
  })

  it('rejects a BIP-39 phrase whose checksum does not verify', () => {
    // Real words, right count, wrong checksum — the classic mis-transcription.
    expect(detectScheme(BIP39.replace(/art$/, 'zoo'))).toBe('invalid')
    // The docs/DERIVATION.md fixture lands here too: it derives, but it does not verify, so restore
    // would refuse it. Recorded as a test so that stays a known property rather than a surprise.
    expect(detectScheme(BIP39_DOC_ANCHOR)).toBe('invalid')
  })

  it('is insensitive to case and surrounding whitespace', () => {
    expect(detectScheme(`  ${CIPHERSEED.toUpperCase()}  `)).toBe('cipherseed')
    expect(detectScheme(`\n ${BIP39}\t`)).toBe('bip39')
  })

  it('tolerates irregular spacing between words', () => {
    expect(detectScheme(CIPHERSEED.replace(/ /g, '   '))).toBe('cipherseed')
  })
})

// ── Scheme resolution for stored wallets ────────────────────────────────────

describe('resolveScheme', () => {
  it('trusts an explicit cipherseed marker', () => {
    expect(resolveScheme(storedWith('cipherseed'), CIPHERSEED)).toEqual({
      scheme: 'cipherseed',
      markerWasMissing: false,
    })
  })

  it('trusts an explicit bip39 marker', () => {
    expect(resolveScheme(storedWith('bip39'), BIP39)).toEqual({
      scheme: 'bip39',
      markerWasMissing: false,
    })
  })

  it('treats a missing marker as a legacy BIP-39 wallet', () => {
    // The field shipped WITH CipherSeed support, so its absence identifies a pre-migration wallet.
    // This is the path every existing user takes on their next unlock.
    expect(resolveScheme(storedWith(), BIP39)).toEqual({
      scheme: 'bip39',
      markerWasMissing: true,
    })
  })

  it('self-heals a CipherSeed wallet whose marker went missing', () => {
    // Not a guess: a legacy wallet's phrase is BIP-39 by construction, so failing that check rules
    // out the only other possibility before CipherSeed is considered.
    expect(resolveScheme(storedWith(), CIPHERSEED)).toEqual({
      scheme: 'cipherseed',
      markerWasMissing: true,
    })
  })

  it('throws rather than guess when a marker-less record is valid under neither format', () => {
    expect(() => resolveScheme(storedWith(), 'clearly not a recovery phrase at all')).toThrow(
      /not valid under any supported format/,
    )
  })

  it('never consults the phrase when a marker is present', () => {
    // A marker beats content, always. Re-deriving the format from content on every unlock would
    // reintroduce guessing where we already have a recorded answer.
    expect(resolveScheme(storedWith('cipherseed'), 'total gibberish').scheme).toBe('cipherseed')
  })
})

// ── Derivation, both paths ──────────────────────────────────────────────────

describe('deriveIdentity', () => {
  it('derives the daemon-verified address for a CipherSeed phrase', async () => {
    const { wallet } = await deriveIdentity(CIPHERSEED, 'cipherseed')
    expect(await wallet.getAddress()).toBe(
      'otl_esm_1u6frykj99rtg0ttmdlu7lm2rex8hjjlpj704v4vd37gxs8t0uace4lvs6q9rz374nhq9nudflxjzg2cfdn4q894vkz5anpzfgzg86ngha863h',
    )
  }, 30_000)

  it('derives the unchanged legacy address and npub for a BIP-39 phrase', async () => {
    // The same values pinned in derivationAnchors.test.ts, reached through the new entry point —
    // proof that routing through deriveIdentity() did not disturb the legacy path.
    const { wallet, nostr } = await deriveIdentity(BIP39_DOC_ANCHOR, 'bip39')
    expect(await wallet.getAddress()).toBe(
      'otl_esm_1gr509dqcyc27669392p5dl59tkdl5ef85h09thy07ezu2pvaz4ex30h6mm7z6wn243ca3jkp76ncpl93rcwgnml6vr70c26hkf7hweg30h9jv',
    )
    expect(nostr.npub).toBe('npub1cldv05xqek9jl9a0dflx9j2y7vsf2m6m8xzjeqyakp4p68ehcmyq2d7dvc')
  }, 30_000)

  it('is deterministic for both schemes', async () => {
    const [a, b] = await Promise.all([
      deriveIdentity(CIPHERSEED, 'cipherseed'),
      deriveIdentity(CIPHERSEED, 'cipherseed'),
    ])
    expect(await a.wallet.getAddress()).toBe(await b.wallet.getAddress())
    expect(a.nostr.npub).toBe(b.nostr.npub)
  }, 30_000)

  it('derives different identities from the two schemes', async () => {
    // Guards against the two arms accidentally converging — which would mean one of them is wrong.
    const cs = await deriveIdentity(CIPHERSEED, 'cipherseed')
    const legacy = await deriveIdentity(BIP39_DOC_ANCHOR, 'bip39')
    expect(await cs.wallet.getAddress()).not.toBe(await legacy.wallet.getAddress())
    expect(cs.nostr.npub).not.toBe(legacy.nostr.npub)
  }, 30_000)
})

// ── C′ Nostr identity for CipherSeed wallets ────────────────────────────────

describe("CipherSeed Nostr identity (C')", () => {
  // FROZEN VECTOR. This pins the domain string "com.caravel.nostr", its version, the label
  // "nostr_entropy", the 16-byte truncation, and the BIP-39 + NIP-06 steps that follow. Change any
  // one of them and every CipherSeed wallet's npub changes: new identity, contacts gone, chat
  // history orphaned, with no error anywhere. If this test fails, the derivation drifted — do not
  // update the expected value.
  it('derives the pinned npub for a known CipherSeed entropy', async () => {
    const { nostr } = await deriveIdentity(CIPHERSEED, 'cipherseed')
    expect(nostr.npub).toBe('npub1fdthsvpcrg470q7pusmv8eemhcmp74uye2ref9pj5q8l8mt5yw9qazxhgv')
    expect(nostr.publicKeyHex).toBe(
      '4b577830381a2be783c1e436c3e73bbe361f5784ca87949432a00ff3ed74238a',
    )
  }, 30_000)

  it('produces a well-formed NIP-06 identity', async () => {
    const { nostr } = await deriveIdentity(CIPHERSEED, 'cipherseed')
    expect(nostr.publicKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(nostr.privateKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(nostr.npub.startsWith('npub1')).toBe(true)
    expect(nostr.nsec.startsWith('nsec1')).toBe(true)
  }, 30_000)

  it('gives different CipherSeed wallets different Nostr identities', async () => {
    const a = await deriveIdentity(CIPHERSEED, 'cipherseed')
    const b = await deriveIdentity(
      'cake edge usual omit blanket boy combine slim exact debris eternal elevator maid hero angle sunset logic outside shy mistake stay game useless client',
      'cipherseed',
    )
    expect(a.nostr.npub).not.toBe(b.nostr.npub)
  }, 30_000)

  it('does not expose the wallet entropy through the Nostr key', async () => {
    // The domain-separation step exists so a future "export your Nostr phrase" feature cannot leak
    // spending material. The Nostr private key must not simply BE the wallet entropy.
    const { importWalletSeed } = await import('tari-cipherseed')
    const seed = await importWalletSeed(CIPHERSEED)
    const entropyHex = [...seed.entropy].map(b => b.toString(16).padStart(2, '0')).join('')
    const { nostr } = await deriveIdentity(CIPHERSEED, 'cipherseed')
    expect(nostr.privateKeyHex).not.toContain(entropyHex)
  }, 30_000)
})

// ── The store key ───────────────────────────────────────────────────────────
//
// The key every sealed local store is encrypted under at rest, derived from the wallet's own seed so
// that restoring a phrase always reproduces it. What it REPLACED was a single random salt in
// localStorage, shared by every wallet and re-minted on every restore — which silently stranded the
// previous wallet's messages, contacts and history, unrecoverably, with no error anywhere.
//
// So these tests carry the weight the salt never had: the derivation is now the only thing standing
// between a phrase and its own data, and it can never change again.

describe('store key derivation', () => {
  // ── FROZEN VECTORS ────────────────────────────────────────────────────────
  //
  // These pin the domain string "com.caravel.store", its version, the label "store_key" (rotation 0),
  // the 32-byte width, AND which seed material each scheme feeds in. Change any one of them and every
  // wallet on every device derives a different store key from the same phrase: messages, contacts,
  // nicknames, groups, the journal and the transaction history all stop decrypting at once, the
  // never-clobber guards then refuse to write over them, and nothing reports a fault.
  //
  // IF EITHER OF THESE FAILS, THE DERIVATION DRIFTED — DO NOT UPDATE THE EXPECTED VALUE.

  it('derives the pinned store key for a known CipherSeed phrase', async () => {
    expect(hex(await storeKeyForPhrase(CIPHERSEED, 'cipherseed'))).toBe(
      '517fd91a7236b8cb4b3dcd7f2dbe0a997a3baea620b88dd603d578c7840b246d',
    )
  }, 30_000)

  it('derives the pinned store key for a known legacy BIP-39 phrase', async () => {
    expect(hex(await storeKeyForPhrase(BIP39, 'bip39'))).toBe(
      'dd39a38b31cc950f917243e686c64b7633ec70a847830f0d5c8e85c40fdeeeb0',
    )
  }, 30_000)

  it('is 32 bytes — the width storeCrypto takes', async () => {
    expect((await storeKeyForPhrase(BIP39, 'bip39')).length).toBe(32)
    expect(storeKeyFromSeedMaterial(new Uint8Array(16).fill(3)).length).toBe(32)
  })

  it('is deterministic — the same phrase yields the same key every time', async () => {
    const a = await storeKeyForPhrase(BIP39, 'bip39')
    const b = await storeKeyForPhrase(BIP39, 'bip39')
    expect(hex(a)).toBe(hex(b))
  }, 30_000)

  // THE POINT OF THE WHOLE CHANGE, in one assertion: no password appears in the signature, so no
  // password change can move the key. A restore that sets a new password still opens the same stores.
  it('takes no password, so a new password cannot move the key', async () => {
    expect(storeKeyForPhrase.length).toBe(2)   // (phrase, scheme) — nothing else
  })

  it('is insensitive to case and surrounding whitespace, like every other phrase input', async () => {
    const plain = await storeKeyForPhrase(BIP39, 'bip39')
    const messy = await storeKeyForPhrase(`  ${BIP39.toUpperCase()}\n`, 'bip39')
    expect(hex(messy)).toBe(hex(plain))
  }, 30_000)

  // Different schemes hash different material (16-byte CipherSeed entropy vs the 64-byte BIP-39
  // seed), so the same 24 words belong to two different wallets with two different store keys. Their
  // stores are namespaced apart on disk too; this pins that the KEYS cannot collide either.
  it('separates the schemes — the same words under each arm give different keys', async () => {
    const asCipherSeed = await storeKeyForPhrase(CIPHERSEED, 'cipherseed')
    const asBip39 = await storeKeyForPhrase(CIPHERSEED, 'bip39')
    expect(hex(asCipherSeed)).not.toBe(hex(asBip39))
  }, 30_000)

  // Domain separation against the OTHER thing derived from the very same CipherSeed entropy. Both
  // hash that entropy with Blake2b; only the domain and label keep them apart, so that is what this
  // asserts. Without it, the Nostr identity and the storage key could be one value.
  it('does not collide with the Nostr derivation over the same entropy', async () => {
    const { entropy } = await importWalletSeed(CIPHERSEED)
    const nostrSide = new DomainSeparatedHasher('com.caravel.nostr', 1, 'nostr_entropy', 32)
      .chain(entropy)
      .finalize()
    expect(hex(storeKeyFromSeedMaterial(entropy))).not.toBe(hex(nostrSide))
  }, 30_000)

  // ── THE CONSTRAINT, ENCODED ───────────────────────────────────────────────
  //
  // The store key must come from the wallet SEED, never from the Nostr key. `nsec` is meant to
  // leave — exporting it to another Nostr client is an ordinary thing to do — and it must not also
  // hand over the key to every message on disk.
  //
  // The middle assertion is the one that bites: if anyone ever reimplements this over the Nostr
  // secret, storeKeyForPhrase would equal storeKeyFromSeedMaterial(nsec bytes), and this fails. A
  // comment could not have caught that.
  it('is not derived from the Nostr key, at any remove', async () => {
    const { nostr } = await deriveIdentity(CIPHERSEED, 'cipherseed')
    const storeKey = hex(await storeKeyForPhrase(CIPHERSEED, 'cipherseed'))

    expect(storeKey).not.toBe(nostr.privateKeyHex)
    expect(storeKey).not.toBe(hex(storeKeyFromSeedMaterial(unhex(nostr.privateKeyHex))))
    expect(storeKey).not.toBe(nostr.publicKeyHex)
    expect(storeKey).not.toBe(hex(storeKeyFromSeedMaterial(unhex(nostr.publicKeyHex))))
  }, 30_000)
})
