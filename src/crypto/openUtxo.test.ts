// THE TRAP, with the real SDK and the real wasm: nothing here is mocked.
//
// A `/utxos` row is a UTXO BODY, and the SDK's decrypt takes a substate RESPONSE, so every scanner
// wraps the one in the other. SDK 0.10+ (Ootle 0.47) parses only `state.up.substate`; a wrapper
// still building the 0.46 `{ substate }` makes `decryptOwnedUtxo` answer "not ours" for every coin,
// and the wallet shows 0 without an error. These build a real output for a real view key, lay it out
// exactly as the live indexer lists one, and require the wallet's own paths to find its value.

import { describe, expect, it, vi } from 'vitest'
import {
  Network, TARI_RESOURCE_ADDRESS, WasmStealthCrypto, createOutput, decryptOwnedUtxo, type IndexerGetSubstateResponse,
} from '@tari-project/ootle'
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { UnreadableUtxoError, openOwnedUtxo, utxoResponse } from './openUtxo'
import { RESOURCE_HEX } from './utxoFeed'

const crypto = new WasmStealthCrypto(Network.Esmeralda)
const AMOUNT = 1_234_567n

/** A real output to `wallet`, as a `/utxos` row: `[commitment, body]`, the live field names. */
async function listedRowFor(wallet: SecretKeyWallet, amount = AMOUNT): Promise<[string, unknown]> {
  const { statement } = await crypto.generateOutputsStatement(
    [createOutput({ destination: await wallet.getAddress(), amount, resourceAddress: TARI_RESOURCE_ADDRESS })],
    null,
  )
  const out = (statement.parsed() as {
    outputs: { output: { commitment: string; sender_public_nonce: string; encrypted_data: string }; auth: unknown; tag: number }[]
  }).outputs[0]!
  return [out.output.commitment, {
    output: {
      output: {
        public_nonce: out.output.sender_public_nonce,
        encrypted_data: out.output.encrypted_data,
        minimum_value_promise: 0,
        viewable_balance: null,
      },
      auth: out.auth,
      tag: out.tag,
    },
    is_frozen: false,
  }]
}

const idOf = (commitment: string) => `utxo_${RESOURCE_HEX}_${commitment}`

describe('openOwnedUtxo: a real listed coin, through the installed SDK', () => {
  it('opens our own coin to its exact, non-zero value', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const [commitment, body] = await listedRowFor(me)
    const opened = await openOwnedUtxo(crypto, await me.getViewSecret(), idOf(commitment), body)
    expect(opened?.value).toBe(AMOUNT)
  })

  it('is null, not an error, for somebody else’s coin', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const stranger = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const [commitment, body] = await listedRowFor(stranger)
    expect(await openOwnedUtxo(crypto, await me.getViewSecret(), idOf(commitment), body)).toBeNull()
  })

  it('is null for a spent or frozen output: not a coin, and not an error', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const [commitment, body] = await listedRowFor(me)
    const view = await me.getViewSecret()
    expect(await openOwnedUtxo(crypto, view, idOf(commitment), { ...(body as object), output: null })).toBeNull()
    expect(await openOwnedUtxo(crypto, view, idOf(commitment), { ...(body as object), is_frozen: true })).toBeNull()
  })

  it('THROWS on a body it cannot parse as the live coin it claims to be: never "not ours"', async () => {
    const view = new Uint8Array(32).fill(1)
    await expect(openOwnedUtxo(crypto, view, idOf('ab'.repeat(32)), 'garbage')).rejects.toBeInstanceOf(UnreadableUtxoError)
    // A live-looking body under an id the SDK cannot take a commitment from.
    await expect(openOwnedUtxo(crypto, view, 'utxo_short', { output: { output: {} } })).rejects.toBeInstanceOf(UnreadableUtxoError)
  })

  it('the old 0.46 wrapper DOES read our own coin as "not ours" on this SDK: the trap is real', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const [commitment, body] = await listedRowFor(me)
    const old = { version: 0, verified: false, substate: { Utxo: body } } as unknown as IndexerGetSubstateResponse
    const silent = await decryptOwnedUtxo(crypto, await me.getViewSecret(), old, idOf(commitment)).then(v => v, () => 'threw')
    expect(silent === null || silent === 'threw').toBe(true)
    // And the wrapper this module builds is what the SDK reads.
    expect((await decryptOwnedUtxo(crypto, await me.getViewSecret(), utxoResponse(body), idOf(commitment)))?.value).toBe(AMOUNT)
  })
})

describe('the wallet’s own scans, end to end on a real coin', () => {
  it('the balance scan and input selection both count it, with a non-zero balance', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const stranger = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    const mine = await listedRowFor(me)
    const theirs = await listedRowFor(stranger, 999n)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ utxos: [mine, theirs] }), { status: 200 })))
    try {
      const { scanWallet } = await import('./walletScanner')
      const { scanOwnedUtxos } = await import('./stealthUtxos')
      const view = await me.getViewSecret()

      const scan = await scanWallet(view, () => {}, new AbortController().signal)
      expect(scan.balance).toBe(AMOUNT)
      expect(scan.utxos.map(u => u.commitment)).toEqual([mine[0]])

      const spendable = await scanOwnedUtxos(crypto, view)
      expect(spendable.map(u => u.value)).toEqual([AMOUNT])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a listing the SDK cannot parse FAILS the scan rather than reading as 0', async () => {
    const me = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ utxos: [['ab'.repeat(32), 'garbage']] }), { status: 200 })))
    try {
      const { scanWallet } = await import('./walletScanner')
      await expect(scanWallet(await me.getViewSecret(), () => {}, new AbortController().signal)).rejects.toBeInstanceOf(UnreadableUtxoError)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
