import { HDKey } from '@scure/bip32'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32 } from '@scure/base'

// NIP-06: https://github.com/nostr-protocol/nips/blob/master/06.md
// Derives a Nostr identity from a BIP-39 seed via BIP-32 path m/44'/1237'/0'/0/0.
// The result is a secp256k1 keypair; the x-only (Schnorr) public key is the Nostr identity.

const NOSTR_PATH = "m/44'/1237'/0'/0/0"

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

export interface NostrIdentity {
  privateKeyHex: string  // 32-byte secp256k1 private key, hex
  publicKeyHex: string   // 32-byte x-only public key (Schnorr), hex
  npub: string           // bech32 "npub1..." — the shareable public identity
  nsec: string           // bech32 "nsec1..." — the private signing key
}

// Takes the 64-byte BIP-39 seed from seedFromMnemonic() and returns the Nostr identity.
// Pure function — no side effects, no globals, deterministic.
export function deriveNostrKeyFromSeed(seed: Uint8Array): NostrIdentity {
  if (seed.length !== 64) throw new Error(`Expected 64-byte seed, got ${seed.length}`)

  const root = HDKey.fromMasterSeed(seed)
  const child = root.derive(NOSTR_PATH)

  const privateKey = child.privateKey
  if (!privateKey) throw new Error('BIP-32 derivation produced no private key')

  // schnorr.getPublicKey returns the 32-byte x-only public key (BIP-340).
  // This is correct for Nostr. Do NOT use secp256k1.getPublicKey which returns
  // 33 bytes (compressed, with parity prefix) — that is the wrong format.
  const publicKey = schnorr.getPublicKey(privateKey)

  return {
    privateKeyHex: toHex(privateKey),
    publicKeyHex: toHex(publicKey),
    npub: bech32.encodeFromBytes('npub', publicKey),
    nsec: bech32.encodeFromBytes('nsec', privateKey),
  }
}
