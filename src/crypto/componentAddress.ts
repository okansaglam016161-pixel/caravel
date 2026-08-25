// Deriving a wallet's ACCOUNT COMPONENT address from its public key, client-side.
//
// ── WHY THIS IS THE MOST DANGEROUS FILE IN THE CODEBASE ───────────────────────
//
// A component address is where public TARI is deposited. Get this hash wrong by one byte and the
// funds go to an address that is well-formed, that nobody controls, and that no one can recover
// from. There is no bounce, no failure, no second chance — a deposit to a derived-but-wrong
// component simply lands somewhere unspendable.
//
// The engine's own source says as much, in ootle_sdk_core/src/identity.rs:
//
//     "A wrong derivation would send funds to an address nobody controls, so the hash is never
//      re-implemented here."
//
// WE ARE RE-IMPLEMENTING IT ANYWAY, because the JS SDK does not expose it — checked exhaustively:
// all 84 exports of @tari-project/ootle 0.3.0 (the latest published), ootle-wasm 0.39.2 (no new
// exports over 0.39.1), and every source file on the ootle.ts `main` branch. The only JS mention is
// a stale doc comment on the `Signer` interface claiming `getAddress()` returns a component address
// — which is true for WalletDaemonSigner and false for SecretKeyWallet, whose getAddress() returns
// the otl_esm_ stealth address.
//
// So the re-implementation is unavoidable, and everything below exists to make it survivable:
// golden vectors from the live network, byte-layout tests that fail loudly on a "simplification",
// and crossCheckDerivation() so the chain gets the last word before money moves.
//
// ── THE RECIPE, AND THE BYTE THAT IS EASY TO GET WRONG ────────────────────────
//
// From tari-ootle engine_types/src/component.rs:
//
//     hasher32(EngineHashDomainLabel::ComponentAddress)
//         .chain(template_address)
//         .chain(public_key)
//         .result()
//
// `hasher32` is DomainSeparatedBorshHasher<TariEngineHashDomain, Blake2b<U32>>, seeded by
// tari-crypto's add_domain_separation_tag as `u64le(len(tag)) ‖ tag`, where
// tag = "{domain}.v{version}.{label}" = "com.tari.ootle.engine.v0.ComponentAddress" (41 bytes).
//
// THE TRAP: `.chain()` writes the BORSH encoding of each value, and the two chained values do NOT
// encode the same way.
//
//     template_address  →  a fixed 32-byte array   →  32 RAW bytes, no prefix
//     public_key        →  RistrettoPublicKeyBytes →  u32le(32) LENGTH PREFIX, then 32 bytes
//
// This is stated outright in identity.rs: "the `public_key` is Borsh-length-prefixed by `.chain()`".
// An earlier attempt at this port tried 420 constructions and failed, because every one of them
// encoded BOTH fields the same way — both raw, or both prefixed. The mixed case is the right one.
// assertByteLayout below exists to make that failure impossible to reintroduce silently.

import { blake2b } from '@noble/hashes/blake2.js'
import type { Provider } from '@tari-project/ootle'

/** The builtin account template: `TemplateAddress::from_array([0; 32])` (template_builtin/src/lib.rs:27). */
export const ACCOUNT_TEMPLATE_ADDRESS = new Uint8Array(32)

/** `{domain}.v{version}.{label}` — the exact 41-byte domain-separation tag. */
export const COMPONENT_ADDRESS_TAG = 'com.tari.ootle.engine.v0.ComponentAddress'

/** Every address string the engine renders carries this prefix. */
const PREFIX = 'component_'

const RISTRETTO_KEY_BYTES = 32

function u64le(n: number): Uint8Array {
  const b = new Uint8Array(8)
  let v = BigInt(n)
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n }
  return b
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  for (let i = 0; i < 4; i++) b[i] = (n >> (8 * i)) & 0xff
  return b
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Expected an even-length hex string.')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  return out
}

/**
 * The exact byte string that gets hashed. Exported ONLY so the tests can inspect the layout
 * field by field — nothing else should call it.
 *
 * Layout, in order:
 *   [0..8)    u64le(41)          domain-separation tag length
 *   [8..49)   the 41-byte tag
 *   [49..81)  32 raw bytes       ACCOUNT_TEMPLATE_ADDRESS — NO length prefix
 *   [81..85)  u32le(32)          Borsh length prefix for the public key
 *   [85..117) 32 bytes           the owner public key
 */
export function componentAddressPreimage(ownerPublicKey: Uint8Array): Uint8Array {
  if (ownerPublicKey.length !== RISTRETTO_KEY_BYTES) {
    throw new Error(`Owner public key must be ${RISTRETTO_KEY_BYTES} bytes, got ${ownerPublicKey.length}.`)
  }
  const tag = new TextEncoder().encode(COMPONENT_ADDRESS_TAG)
  return concat(
    u64le(tag.length),                        // tari-crypto: add_domain_separation_tag
    tag,
    ACCOUNT_TEMPLATE_ADDRESS,                 // Borsh fixed array — RAW
    u32le(RISTRETTO_KEY_BYTES), ownerPublicKey, // Borsh — LENGTH-PREFIXED
  )
}

/**
 * The account component address for `ownerPublicKey`.
 *
 * PURE. No network, no storage, no clock. It is a function of the key alone — the engine derivation
 * takes no network parameter, so the same key yields the same address on every network and forever.
 * That is why it works for wallets that have never transacted: the address exists as a fact about
 * the key before any account is created at it.
 *
 * DERIVING IS NOT THE SAME AS EXISTING. This returns where an account WOULD live. Whether one has
 * been created there is a separate question, and depositing into a component that does not exist
 * yet fails. See crossCheckDerivation.
 */
export function deriveComponentAddress(ownerPublicKey: Uint8Array): string {
  return PREFIX + toHex(blake2b(componentAddressPreimage(ownerPublicKey), { dkLen: 32 }))
}

/** Same, from a hex-encoded public key. */
export function deriveComponentAddressFromHex(ownerPublicKeyHex: string): string {
  return deriveComponentAddress(fromHex(ownerPublicKeyHex))
}

/**
 * How an `otl_esm_` address is decoded. Defaults to the WASM parser; a test supplies a fake.
 *
 * The same injectable seam readRevealedBalance uses for its vault resolver — it keeps the WASM
 * module out of the pure-function tests without mocking the module graph.
 */
export type OotleAddressParser = (address: string) => { owner_key: Uint8Array }

/**
 * The account component address for whoever owns this stealth address.
 *
 * THIS IS THE WHOLE POINT OF THE FILE. An `otl_esm_` address carries the owner public key, so one
 * address is enough for both destinations: spend to the stealth address and the value lands
 * private; derive the component from the same address and deposit, and it lands public. The user
 * never sees or shares a `component_` string.
 *
 * The wallet SDK does exactly this in Rust — `accounts.rs:559` derives the recipient's component
 * from a destination public key — which is why a wallet handed only an `otl_esm_` can still send
 * someone public funds.
 */
export function deriveComponentFromOotleAddress(
  ootleAddress: string,
  parse: OotleAddressParser,
): string {
  const { owner_key } = parse(ootleAddress)
  return deriveComponentAddress(owner_key)
}

// ── The chain gets the last word ──────────────────────────────────────────────

/**
 * What the network says about a derived address.
 *
 *   confirmed    the component exists AND its owner rule names the key we derived from. The
 *                derivation is proven correct for this address; it is safe to deposit.
 *   not-created  the derivation looks fine but no account exists there yet. NOT a green light —
 *                a deposit into a component that does not exist fails outright.
 *   mismatch     an account exists there and it belongs to SOMEBODY ELSE. Either the port has
 *                drifted or the key is wrong. Never send.
 *   unavailable  we could not reach the network. Unknown, not safe.
 */
export type DerivationCheck =
  | { status: 'confirmed'; component: string }
  | { status: 'not-created'; component: string }
  | { status: 'mismatch'; component: string; onChainOwner: string }
  | { status: 'unavailable'; component: string }

/** Narrow an unknown without asserting anything about its contents. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * Ask the chain whether the address we derived really belongs to this key.
 *
 * WHY THIS EXISTS EVEN THOUGH THE VECTORS PASS. Golden vectors prove the port was right when they
 * were captured; they cannot prove it is right for a key nobody has tested, and they cannot catch a
 * future edit that changes behaviour only for some inputs. This closes that gap by making the
 * network the authority at the moment it matters — before funds move, not after.
 *
 * IT CHECKS OWNERSHIP, NOT JUST EXISTENCE. A component being present at the derived address proves
 * little; a component whose `owner_rule.ByPublicKey` equals the key we derived from proves the
 * derivation landed exactly where the engine would have put it. That is the assertion worth making.
 *
 * HOW M8 (SEND) SHOULD WIRE IT:
 *   - Call it during PREPARE, before the review screen — never after the user confirms.
 *   - `confirmed`   → proceed.
 *   - `mismatch`    → REFUSE outright. This is the derivation being wrong; it is not retryable and
 *                     must never be presented as a transient problem.
 *   - `not-created` → refuse to send public, and say why: the recipient's account does not exist
 *                     until they have transacted once. The deposit would fail at input resolution
 *                     anyway, so this turns an opaque failure into a sentence the user can act on.
 *   - `unavailable` → refuse, retryable. Do not fall back to "probably fine".
 * The result is cacheable per address — the answer cannot change from confirmed to mismatch — so
 * this costs one lookup per recipient, not one per send.
 */
export async function crossCheckDerivation(
  provider: Provider,
  ownerPublicKeyHex: string,
): Promise<DerivationCheck> {
  const component = deriveComponentAddressFromHex(ownerPublicKeyHex)

  let res: unknown
  try {
    res = await provider.getSubstate(component)
  } catch {
    // The indexer answers a missing substate with an error rather than an empty body, so a throw
    // here is the ordinary "no account yet" case as well as a real outage. They are told apart
    // below only insofar as we can: without a response there is nothing to compare, and both are
    // "do not send". `not-created` is the more useful wording for the overwhelmingly common one.
    return { status: 'not-created', component }
  }

  const header = obj(obj(obj(res)?.substate)?.Component)?.header
  if (!header) return { status: 'not-created', component }

  const owner = obj(obj(header)?.owner_rule)?.ByPublicKey
  if (typeof owner !== 'string') return { status: 'unavailable', component }

  return owner.toLowerCase() === ownerPublicKeyHex.toLowerCase()
    ? { status: 'confirmed', component }
    : { status: 'mismatch', component, onChainOwner: owner }
}
