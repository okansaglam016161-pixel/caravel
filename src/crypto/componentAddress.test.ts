// Tests for the account-address derivation (M6).
//
// THIS IS A KNOWN-ANSWER TEST FILE, and that is the only kind worth having here. A wrong derivation
// sends funds to a well-formed address nobody controls — there is no bounce and no recovery — so
// the question is never "does the code look right", it is "does it still produce the exact bytes
// the engine produces". Every vector below was captured by asking the ENGINE ITSELF, via a
// CreateAccount dry run on Esmeralda, and comparing. 12 of 12 agreed.
//
// A NOTE ON THE VECTORS THAT ARE NOT HERE. Byte patterns that are not canonical Ristretto points
// (0xff repeated, 0x01 repeated, ascending 00..1f) were tried and the engine returned nothing for
// them — CreateAccount needs a real public key, so there is no authoritative answer to pin. They
// are deliberately absent rather than pinned against our own output, which would only prove the
// implementation agrees with itself. All-zeros IS present: it is the Ristretto identity point and
// the engine answers for it.

import { describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_TEMPLATE_ADDRESS, COMPONENT_ADDRESS_TAG, componentAddressPreimage, crossCheckDerivation,
  deriveComponentAddress, deriveComponentAddressFromHex, deriveComponentFromOotleAddress, fromHex,
} from './componentAddress'
import type { Provider } from '@tari-project/ootle'

/** [owner public key hex, expected component address, provenance] — all engine-verified. */
const GOLDEN: [string, string, string][] = [
  ['5cfa4af0480e5f8672ab1393bbb6eb66221017d010e6bce57c129ac06e565670',
   'component_ffbba63d676244853e32209815784434d7177c2bab0371652fe1d01bec3cd835',
   'seeded wallet (account exists on-chain)'],

  ['305cca0239cd0c21e2a55c226fda1672f103ea49751cb482cfa99f96b38bde40',
   'component_6ae2303d20d95aa0295f0360b453e8e4a88717bcab831b73f7ff38ff9c3c0cab',
   'third party (real on-chain account)'],

  ['0000000000000000000000000000000000000000000000000000000000000000',
   'component_1aacc24bc5858180c4997ae0bb54336a5c0874c81bb6e2f4ea8fd7e6b2acbed9',
   'all zero bytes'],

  ['6ae694e009b3b464a3ab1d492197768e85efd404e1ea466d7478d92721e56e45',
   'component_e3c263693c82b13fa4a5830b93230e6faede2ff408fd29024ff871976e05c30a',
   'fresh otl_esm_ #1'],

  ['f25a4c03050583d434fb8dbd95dc860d3e655ca0ac6ce0346297b2aed2593371',
   'component_670c3fd4af4b7a2fc0459b7a0c1e036b65a51a81e5d949bf018b78c69f8fdcf9',
   'fresh otl_esm_ #2'],

  ['bad5bd252a7ef40b19eccabf2d98a8e2f62497b90294dcdb04e088abb931b055',
   'component_6551243bce938ddcd5fe2331d2bf1afd23f1150dd96a4155c4c52100a26ca38b',
   'fresh otl_esm_ #3'],

  ['f441a08b5fc82811d82d9b8e17dafc52eefcd0b568d858a6f1bd6231318e2315',
   'component_85425d7d2c75147d9efa1b38992813c2fe7384a15c9cdc22bf64cd26384a0b13',
   'fresh otl_esm_ #4'],

  ['ba08e1e538b09419ba17af981d781f0ffeb2b4da90dd9783d151ad8d87d3380c',
   'component_df378681bf1bbc9d929e2747f216ec1fcb5b56cadb960f94b32a4ce10746e764',
   'fresh otl_esm_ #5'],

  ['f2cd00d63ec4d802b4d4e03dc3541c4b46d31c106004403d8ecf04977d246347',
   'component_e57147a7a819f10761f2d985d471ad23fd0a42ff6001a2e8f39adb1ccdb01749',
   'fresh otl_esm_ #6'],

  ['36184003b3d696fba5cfaead4c22cca1cafcc7b094efea511cb846a955c70071',
   'component_8209a1414a1bae4af6a0ede5fc20ecede1fb09bb083f7c70ef9a97737a86a6e7',
   'fresh otl_esm_ #7'],

  ['48c986f6a02ddae352d50bee9721d8c0fb7ee00c673f3963031877f39a09a410',
   'component_cc64c5630a146c0ced4cec98123729bb973c4f694e67559ee4b3b9579ac4d86b',
   'fresh otl_esm_ #8'],

  ['808a64fd0444ba2d7f32de8d58581051114e7b766c6b62923697ed5be90ba103',
   'component_d841f700f49e8ca3dede3a0613c8e6f03c8021b5f9b599c6a774ff52c68be565',
   'fresh otl_esm_ #9'],]


// ── The regression guard ──────────────────────────────────────────────────────

describe('GOLDEN VECTORS — known answers from the live engine', () => {
  it.each(GOLDEN)('derives %s correctly', (pk, expected) => {
    expect(deriveComponentAddressFromHex(pk)).toBe(expected)
  })

  it('all 12 vectors agree, from raw bytes as well as hex', () => {
    for (const [pk, expected] of GOLDEN) {
      expect(deriveComponentAddress(fromHex(pk))).toBe(expected)
    }
  })

  it('the two anchors whose accounts really exist on-chain', () => {
    // These two are the strongest evidence in the file: real accounts, real owners, and the
    // component address is the one the chain actually placed them at.
    expect(deriveComponentAddressFromHex('5cfa4af0480e5f8672ab1393bbb6eb66221017d010e6bce57c129ac06e565670'))
      .toBe('component_ffbba63d676244853e32209815784434d7177c2bab0371652fe1d01bec3cd835')
    expect(deriveComponentAddressFromHex('305cca0239cd0c21e2a55c226fda1672f103ea49751cb482cfa99f96b38bde40'))
      .toBe('component_6ae2303d20d95aa0295f0360b453e8e4a88717bcab831b73f7ff38ff9c3c0cab')
  })

  it('every vector is distinct — the derivation is not collapsing inputs', () => {
    const out = new Set(GOLDEN.map(([pk]) => deriveComponentAddressFromHex(pk)))
    expect(out.size).toBe(GOLDEN.length)
  })

  it('is deterministic across repeated calls', () => {
    const [pk, expected] = GOLDEN[0]!
    for (let i = 0; i < 50; i++) expect(deriveComponentAddressFromHex(pk)).toBe(expected)
  })
})

// ── THE BYTE THAT WAS WRONG BEFORE ────────────────────────────────────────────

describe('byte layout — the mixed encoding a "simplification" would break', () => {
  const pk = fromHex(GOLDEN[0]![0])
  const pre = componentAddressPreimage(pk)

  it('is exactly 117 bytes: 8 + 41 + 32 + 4 + 32', () => {
    expect(pre.length).toBe(8 + 41 + 32 + 4 + 32)
  })

  it('starts with u64le(41) — the domain tag length, little-endian', () => {
    expect(Array.from(pre.slice(0, 8))).toEqual([41, 0, 0, 0, 0, 0, 0, 0])
  })

  it('carries the exact 41-byte domain tag', () => {
    expect(COMPONENT_ADDRESS_TAG).toBe('com.tari.ootle.engine.v0.ComponentAddress')
    expect(COMPONENT_ADDRESS_TAG.length).toBe(41)
    expect(new TextDecoder().decode(pre.slice(8, 49))).toBe(COMPONENT_ADDRESS_TAG)
  })

  it('THE TEMPLATE IS RAW — 32 bytes with NO length prefix', () => {
    // If someone "makes it consistent" by prefixing this too, these bytes shift and every vector
    // above breaks. That is the intended failure.
    expect(Array.from(pre.slice(49, 81))).toEqual(Array.from(ACCOUNT_TEMPLATE_ADDRESS))
    expect(ACCOUNT_TEMPLATE_ADDRESS.length).toBe(32)
    expect(ACCOUNT_TEMPLATE_ADDRESS.every(b => b === 0)).toBe(true)
  })

  it('THE PUBLIC KEY IS LENGTH-PREFIXED — u32le(32) then the key', () => {
    // The other half of the same trap: dropping this prefix "because the template does not have
    // one" is exactly the 420-attempt failure that preceded this file.
    expect(Array.from(pre.slice(81, 85))).toEqual([32, 0, 0, 0])
    expect(Array.from(pre.slice(85, 117))).toEqual(Array.from(pk))
  })

  it('the two fields really are encoded differently', () => {
    // Stated as an assertion rather than a comment: the template segment is 32 bytes, the key
    // segment is 36. Any edit that makes them the same length has broken the derivation.
    const templateSegment = pre.slice(49, 81)
    const keySegment = pre.slice(81, 117)
    expect(templateSegment.length).toBe(32)
    expect(keySegment.length).toBe(36)
    expect(keySegment.length - templateSegment.length).toBe(4)
  })

  it('changing one bit of the key changes the address', () => {
    const flipped = fromHex(GOLDEN[0]![0])
    flipped[31] ^= 0x01
    expect(deriveComponentAddress(flipped)).not.toBe(GOLDEN[0]![1])
  })

  it('output is always the prefix plus 64 lowercase hex characters', () => {
    for (const [pk] of GOLDEN) {
      expect(deriveComponentAddressFromHex(pk)).toMatch(/^component_[0-9a-f]{64}$/)
    }
  })
})

describe('input validation', () => {
  it.each([0, 31, 33, 64])('refuses a %s-byte key', (n) => {
    expect(() => deriveComponentAddress(new Uint8Array(n))).toThrow(/must be 32 bytes/)
  })

  it.each(['abc', 'zz'.repeat(32), '0x' + '00'.repeat(32)])('refuses malformed hex (%s)', (bad) => {
    expect(() => deriveComponentAddressFromHex(bad)).toThrow()
  })
})

// ── otl_esm_ → component, the whole point ────────────────────────────────────

describe('deriveComponentFromOotleAddress — one address is enough', () => {
  it('routes the owner key out of a stealth address into the derivation', () => {
    const [pk, expected] = GOLDEN[0]!
    // The parser seam stands in for the WASM parseOotleAddress.
    const parse = vi.fn(() => ({ owner_key: fromHex(pk) }))
    expect(deriveComponentFromOotleAddress('otl_esm_1anything', parse)).toBe(expected)
    expect(parse).toHaveBeenCalledWith('otl_esm_1anything')
  })

  it('works for every vector', () => {
    for (const [pk, expected] of GOLDEN) {
      expect(deriveComponentFromOotleAddress('otl_esm_x', () => ({ owner_key: fromHex(pk) }))).toBe(expected)
    }
  })
})

// ── The chain gets the last word ─────────────────────────────────────────────

describe('crossCheckDerivation — the network is the authority before funds move', () => {
  const [PK, COMPONENT] = GOLDEN[0]!
  const provider = (getSubstate: unknown) => ({ getSubstate }) as unknown as Provider

  it('CONFIRMED when the on-chain owner matches the key we derived from', async () => {
    const p = provider(async () => ({ substate: { Component: { header: { owner_rule: { ByPublicKey: PK } } } } }))
    expect(await crossCheckDerivation(p, PK)).toEqual({ status: 'confirmed', component: COMPONENT })
  })

  it('MISMATCH when an account exists there but belongs to someone else', async () => {
    // The signal that the port has drifted. Must never be treated as retryable.
    const other = GOLDEN[1]![0]
    const p = provider(async () => ({ substate: { Component: { header: { owner_rule: { ByPublicKey: other } } } } }))
    expect(await crossCheckDerivation(p, PK)).toEqual({ status: 'mismatch', component: COMPONENT, onChainOwner: other })
  })

  it('NOT-CREATED when the lookup finds nothing — a deposit would fail', async () => {
    const p = provider(async () => { throw new Error('Substate not found') })
    expect(await crossCheckDerivation(p, PK)).toEqual({ status: 'not-created', component: COMPONENT })
  })

  it('NOT-CREATED when the substate is not a component', async () => {
    const p = provider(async () => ({ substate: { Vault: {} } }))
    expect((await crossCheckDerivation(p, PK)).status).toBe('not-created')
  })

  it('UNAVAILABLE when the owner rule is a shape we cannot compare', async () => {
    // An owner rule that is not ByPublicKey cannot be checked against a key, so it is unknown —
    // never quietly treated as a match.
    const p = provider(async () => ({ substate: { Component: { header: { owner_rule: { ByAccessRule: 'x' } } } } }))
    expect((await crossCheckDerivation(p, PK)).status).toBe('unavailable')
  })

  it('matches case-insensitively on the key hex', async () => {
    const p = provider(async () => ({ substate: { Component: { header: { owner_rule: { ByPublicKey: PK.toUpperCase() } } } } }))
    expect((await crossCheckDerivation(p, PK)).status).toBe('confirmed')
  })

  it('always reports the derived component, whatever the verdict', async () => {
    for (const g of [
      async () => ({ substate: { Component: { header: { owner_rule: { ByPublicKey: PK } } } } }),
      async () => { throw new Error('nope') },
      async () => ({ substate: {} }),
    ]) {
      expect((await crossCheckDerivation(provider(g), PK)).component).toBe(COMPONENT)
    }
  })
})
