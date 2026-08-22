//   Regression anchors for the LEGACY (BIP-39) derivation — the safety net for the CipherSeed
//   migration. Every wallet created before that migration derives its Tari keys and its Nostr
//   identity through this exact path, so these vectors must keep passing byte-for-byte no matter
//   how the surrounding code is reorganised. If one of them changes, an existing user's wallet
//   opens at a different address with a different identity, silently — which is precisely the
//   failure the migration is designed to avoid.
//
//   The first two vectors are transcribed from docs/DERIVATION.md, where they were recorded as
//   prose only; committing them as executable assertions is the point of this file. The third is
//   NIP-06's own published vector, an external cross-check that the Nostr path is genuinely the
//   standard one and not merely self-consistent.
//
//   DO NOT "fix" a failure here by updating the expected value.

import { describe, expect, it } from 'vitest'
import { seedFromMnemonic, walletFromMnemonic } from './walletCrypto'
import { deriveNostrKeyFromSeed } from './nostrCrypto'

// The Caravel test mnemonic from docs/DERIVATION.md. A deliberately low-entropy phrase — it exists
// to pin derivation output, never to hold value.
const TEST_MNEMONIC =
  'test test test test test test test test test test test test ' +
  'test test test test test test test test test test test junk'

describe('legacy BIP-39 derivation anchors', () => {
  it('derives the recorded Tari address for the Caravel test mnemonic', async () => {
    const wallet = await walletFromMnemonic(TEST_MNEMONIC)
    expect(await wallet.getAddress()).toBe(
      'otl_esm_1gr509dqcyc27669392p5dl59tkdl5ef85h09thy07ezu2pvaz4ex30h6mm7z6wn243ca3jkp76ncpl93rcwgnml6vr70c26hkf7hweg30h9jv',
    )
  })

  it('derives the recorded Nostr identity for the Caravel test mnemonic', async () => {
    const seed = await seedFromMnemonic(TEST_MNEMONIC)
    expect(deriveNostrKeyFromSeed(seed).npub).toBe(
      'npub1cldv05xqek9jl9a0dflx9j2y7vsf2m6m8xzjeqyakp4p68ehcmyq2d7dvc',
    )
  })

  // Proves the Nostr branch is NIP-06 proper, not a Caravel-flavoured lookalike: this vector comes
  // from the spec itself, so a Caravel legacy identity is reproducible by any compliant client.
  it('matches the canonical NIP-06 test vector', async () => {
    const seed = await seedFromMnemonic(
      'leader monkey parrot ring guide accident before fence cannon height naive bean',
    )
    const identity = deriveNostrKeyFromSeed(seed)
    expect(identity.privateKeyHex).toBe(
      '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a',
    )
    expect(identity.npub).toBe(
      'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu',
    )
  })

  // The two branches must stay independent: same seed in, unrelated key material out. A refactor
  // that accidentally crossed them would still pass the vectors above only by coincidence.
  it('keeps the Tari and Nostr branches derived from the same seed distinct', async () => {
    const seed = await seedFromMnemonic(TEST_MNEMONIC)
    const wallet = await walletFromMnemonic(TEST_MNEMONIC)
    const nostr = deriveNostrKeyFromSeed(seed)
    const ownerPublicKeyHex = [...(await wallet.getPublicKey())]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    expect(ownerPublicKeyHex).not.toBe(nostr.publicKeyHex)
  })

  // Determinism is the whole contract: the same phrase must rebuild the same wallet on any device,
  // on any run. Cheap to assert, and it catches accidental randomness in the derivation path.
  it('is deterministic across repeated derivations', async () => {
    const [first, second] = await Promise.all([
      walletFromMnemonic(TEST_MNEMONIC),
      walletFromMnemonic(TEST_MNEMONIC),
    ])
    expect(await first.getAddress()).toBe(await second.getAddress())
  })
})
