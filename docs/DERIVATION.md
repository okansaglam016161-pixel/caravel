# Caravel Key Derivation

Both the Tari wallet identity and the Nostr identity derive from the same 24-word BIP-39 mnemonic. One phrase restores both money and messages. The two derivations are cryptographically independent: they use different curves, different algorithms, and share only the BIP-39 seed as input.

---

## Shared root: the BIP-39 seed

```
24-word BIP-39 mnemonic (256-bit entropy, English wordlist)
  ↓  PBKDF2-HMAC-SHA512, salt = "mnemonic", 2048 rounds → 64 bytes
64-byte seed  (src/crypto/walletCrypto.ts: seedFromMnemonic)
  ├──→  Tari derivation (below)
  └──→  Nostr derivation (below)
```

---

## Tari derivation

**Algorithm:** SHA-512 domain separation → Ristretto255 mod-L reduction  
**Curve:** Ristretto255 (Tari native)  
**Code:** `src/crypto/walletCrypto.ts`, function `seedToOotleKeys`

```
seed (64 bytes)
  ├─ SHA-512(seed ‖ 0x01) → 64 bytes → reduceModL → ownerSecretKey (32 bytes)
  └─ SHA-512(seed ‖ 0x02) → 64 bytes → reduceModL → viewOnlySecret (32 bytes)

SecretKeyWallet.fromSecretKey(ownerSecretKey, Network.Esmeralda, viewOnlySecret)
  → otl_esm_... address
```

`reduceModL` interprets the 64-byte hash as a little-endian unsigned integer and reduces modulo the Ristretto255 scalar field order:

```
L = 7237005577332262213973186563042994240857116359379907606001950938285454250989
```

**Regression anchor (test mnemonic):**
```
mnemonic: "test test test test test test test test test test test test
           test test test test test test test test test test test junk"

address:  otl_esm_1gr509dqcyc27669392p5dl59tkdl5ef85h09thy07ezu2pvaz4ex30h6mm7z6wn243ca3jkp76ncpl93rcwgnml6vr70c26hkf7hweg30h9jv
```

If a code change causes a different address for this mnemonic, the derivation has regressed.

---

## Nostr derivation

**Standard:** [NIP-06](https://github.com/nostr-protocol/nips/blob/master/06.md)  
**Algorithm:** BIP-32 HD derivation → secp256k1 Schnorr  
**Curve:** secp256k1  
**Code:** `src/crypto/nostrCrypto.ts`, function `deriveNostrKeyFromSeed`

```
seed (64 bytes)
  → HDKey.fromMasterSeed(seed)
  → .derive("m/44'/1237'/0'/0/0")   ← all hardened except last two
  → privateKey (32 bytes, secp256k1)
  → schnorr.getPublicKey(privateKey) → publicKey (32 bytes, x-only BIP-340)
  → bech32("npub", publicKey)        → npub1...
  → bech32("nsec", privateKey)       → nsec1...
```

The public key is the **x-only (32-byte) Schnorr key**, not the 33-byte compressed key. NIP-06 and all Nostr clients expect the x-only form.

BIP-32 derivation path breakdown:
| Component | Value | Purpose |
|-----------|-------|---------|
| `44'` | hardened | BIP-44 purpose |
| `1237'` | hardened | Nostr coin type (registered) |
| `0'` | hardened | account 0 |
| `0` | unhardened | external chain |
| `0` | unhardened | first key |

**Regression anchor (Caravel test mnemonic):**
```
mnemonic: "test test test test test test test test test test test test
           test test test test test test test test test test test junk"

npub: npub1cldv05xqek9jl9a0dflx9j2y7vsf2m6m8xzjeqyakp4p68ehcmyq2d7dvc
```

**NIP-06 canonical test vector (external cross-check):**
```
mnemonic: "leader monkey parrot ring guide accident before fence cannon height naive bean"

private key: 7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a
npub:        npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu
```

This vector is from the NIP-06 spec. Caravel's derivation matches it exactly, proving the derivation is portable: a Caravel Nostr identity can be imported into any NIP-06-compliant client using the same 24-word phrase.

---

## Independence of the two derivations

The Tari and Nostr keys share only the 64-byte BIP-39 seed as input. From there, they are fully independent:

- **Different curves:** Ristretto255 (Tari) vs secp256k1 (Nostr)
- **Different algorithms:** SHA-512 domain hashing + mod-L reduction (Tari) vs HMAC-SHA512 BIP-32 chain derivation (Nostr)
- **No shared intermediates:** the private keys are computed by unrelated functions and have no mathematical relationship to each other

Compromising one identity does not help an attacker derive the other.

---

## NIP-06 status note

NIP-06 is currently marked "unrecommended" in the NIPs index. The Nostr community's current preference is a standalone nsec unconnected to any mnemonic. Caravel deliberately chooses the NIP-06 mnemonic path so that one 24-word backup phrase restores both the Tari wallet and the Nostr identity. Users who want a standalone Nostr key should use a dedicated Nostr client to generate one.
