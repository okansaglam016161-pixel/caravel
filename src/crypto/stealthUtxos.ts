// The wallet's own stealth (private) UTXO set, as spendable inputs.
//
// LIFTED OUT OF confidentialSend.ts UNCHANGED, because M3's reveal path needs the same thing for a
// different reason. A send spends stealth UTXOs to pay someone else; a reveal spends them to make
// value public. Both need the identical answer to "which outputs do I own, what are they worth, and
// what do I need to spend them" — and two copies of that answer is one copy that drifts. The same
// reasoning epoch.ts records for max_epoch, applied to input discovery.
//
// WHAT A SPENDABLE INPUT NEEDS, and why this returns all four fields:
//   commitment — names the UTXO on-chain (the StealthInput, and the substate id).
//   value      — recovered by trial decryption; the balance arithmetic runs on it.
//   mask       — the blinding factor. Without it there is no balance proof, so an output whose
//                mask we cannot recover is not spendable no matter how much it is worth.
//   nonce      — the sender's public nonce, which the one-time spend-key signature is derived
//                against. A UTXO with no readable nonce cannot be authorized, so it is dropped.
//
// UNREADABLE IS DROPPED, NOT ZEROED. Anything that fails to decrypt is somebody else's output and
// is skipped silently — that is the overwhelming majority of the set and not an error. What IS
// surfaced is a truncated listing: see the FETCH_LIMIT note below.

import { decryptOwnedUtxo, TARI_RESOURCE_ADDRESS, WasmStealthCrypto, type Mask, type Signer } from '@tari-project/ootle'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'

/** The TARI resource address with its `resource_` prefix stripped — the form the /utxos query and
 *  the `utxo_<resource>_<commitment>` substate id both use. */
export const RESOURCE_HEX = TARI_RESOURCE_ADDRESS.replace(/^resource_/, '')

// The indexer's /utxos endpoint IGNORES `offset` (every offset returns the same set) but HONORS
// `limit`. So we fetch the whole set in one request with a limit safely above it — never paginate by
// offset (that loops forever once the set exceeds one page). 1000 is honored; 5000 is rejected.
export const FETCH_LIMIT = 1000

/** One of the wallet's own stealth outputs, with everything needed to spend it. */
export interface OwnedUtxo {
  substateId: string
  commitment: Uint8Array
  nonce: Uint8Array
  value: bigint
  mask: Mask
}

export function fromHex(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16)
  return bytes
}

/**
 * Every stealth TARI output this view key can open, in the order the indexer returned them.
 *
 * Order is preserved deliberately: input selection sorts by value and JS sorts are stable, so a
 * deterministic starting order means a deterministic selection for a given balance — the same
 * transaction gets built when it is priced and when it is sent.
 */
export async function scanOwnedUtxos(crypto: WasmStealthCrypto, viewSecret: Uint8Array): Promise<OwnedUtxo[]> {
  const owned: OwnedUtxo[] = []

  // ONE request — the indexer ignores `offset`, so paginating by it would re-fetch the same set
  // forever. Fetch the whole set with a big `limit` instead.
  const url = `${INDEXER_URL}/utxos?resource_address=${RESOURCE_HEX}&limit=${FETCH_LIMIT}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`UTXO scan HTTP ${res.status}`)
  const body = await res.json() as { utxos?: [string, unknown][] } | [string, unknown][]
  const rows = Array.isArray(body) ? body : (body as { utxos?: [string, unknown][] }).utxos ?? []
  // Ceiling guard: a full FETCH_LIMIT means there may be inputs we couldn't see. The spend paths
  // have no balance display of their own, so surface it in the log; an actually-unspendable set
  // still fails with an explicit insufficient-funds message.
  if (rows.length >= FETCH_LIMIT) {
    console.warn(`[Caravel] stealth UTXO fetch hit the indexer limit (${FETCH_LIMIT}) — input selection may be incomplete`)
  }

  // Dedup by commitment — the indexer can return the same UTXO more than once, and input selection
  // must never consider a duplicate: spending one commitment twice is a self-double-spend, and
  // counting it twice overstates what the wallet can cover.
  const seen = new Set<string>()
  for (const [commitmentHex, utxoBody] of rows) {
    if (seen.has(commitmentHex)) continue
    seen.add(commitmentHex)

    const substateId = `utxo_${RESOURCE_HEX}_${commitmentHex}`
    const fakeResponse = { version: 0, verified: false, substate: { Utxo: utxoBody } }
    const decrypted = await decryptOwnedUtxo(
      crypto,
      viewSecret,
      fakeResponse as Parameters<typeof decryptOwnedUtxo>[2],
      substateId,
    )
    if (decrypted !== null) {
      const output = (utxoBody as { output?: { output?: { public_nonce?: string } } })?.output?.output
      if (!output?.public_nonce) continue
      owned.push({
        substateId,
        commitment: fromHex(commitmentHex),
        nonce: fromHex(output.public_nonce),
        value: decrypted.value,
        mask: decrypted.mask,
      })
    }
  }

  return owned
}

// ── Spend-side signing shim ───────────────────────────────────────────────────

/**
 * Carries pre-computed one-time spend-key signatures into `signTransaction`.
 *
 * A stealth input is authorized not by the wallet key but by a ONE-TIME key derived from the
 * sender's public nonce on that specific output, so those signatures have to be produced before
 * signing (they hash over the serialized transaction and the seal public key) and then handed to
 * the signer list as-is. `signTransaction` concatenates whatever each signer returns, so ONE
 * StaticSigner carrying N signatures is how a multi-input spend is authorized.
 *
 * Shared by the send and reveal paths for the same reason the scan above is: one definition, so a
 * change to how spends are authorized cannot land in one path and not the other.
 */
export type SignedTxArr = Awaited<ReturnType<Signer['signTransaction']>>

export class StaticSigner implements Signer {
  private sigs: SignedTxArr
  constructor(sigs: SignedTxArr) { this.sigs = sigs }
  async getAddress() { return '' }
  async getPublicKey() { return new Uint8Array(32) }
  async signTransaction(_t: Parameters<Signer['signTransaction']>[0], _k: Uint8Array): Promise<SignedTxArr> {
    return this.sigs
  }
}
