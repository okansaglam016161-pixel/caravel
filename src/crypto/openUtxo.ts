// Opening a UTXO body with this wallet's view key, without ever mistaking "unreadable" for "not ours".
//
// ── THE TRAP THIS CLOSES ─────────────────────────────────────────────────────
//
// The scanners hold UTXO BODIES, from `/utxos` rows or by-id recovery, not substate responses, and
// the SDK's `decryptOwnedUtxo` takes a response. So each scanner wrapped the body in a hand-built
// response, in the 0.46 shape (`{ substate: { Utxo } }`). SDK 0.10+ parses only the 0.47 shape
// (`{ state: { up: { substate } } }`), and `decryptOwnedUtxo` answers `null` both for "not ours" and
// for "I could not parse this". A stale wrapper therefore made every coin read as somebody else's,
// and the wallet showed 0 without an error. Each scanner also wrapped the call in a catch that read
// any throw as "not ours".
//
// ── THE RULE ─────────────────────────────────────────────────────────────────
//
// ONE wrapper (here), in the shape the installed SDK parses, and three distinct answers:
//
//   a decrypted output   ours;
//   null                 not ours, or not a spendable coin at all (spent: `output: null`, or frozen);
//   UnreadableUtxoError  a body that should be a live coin and that the SDK cannot parse. THROWN,
//                        never swallowed: a wallet that cannot read its coins must say so, not show 0.

import { decryptOwnedUtxo, parseSubstateUtxo, type IndexerGetSubstateResponse, type StealthCryptoProvider } from '@tari-project/ootle'

/** A body that should be a live UTXO and that cannot be parsed as one. */
export class UnreadableUtxoError extends Error {
  readonly substateId: string
  constructor(substateId: string, detail: string) {
    super(`Could not read UTXO ${substateId}: ${detail}`)
    this.name = 'UnreadableUtxoError'
    this.substateId = substateId
  }
}

/** A UTXO body (a `/utxos` row's value, or a by-id read's `Utxo`) as the response the SDK parses. */
export function utxoResponse(utxo: unknown, verified = false): IndexerGetSubstateResponse {
  return { version: 0, state: { up: { substate: { Utxo: utxo } } }, verified } as unknown as IndexerGetSubstateResponse
}

type DecryptedUtxo = NonNullable<Awaited<ReturnType<typeof decryptOwnedUtxo>>>

/**
 * Trial-decrypt one UTXO body. `null` is "not ours" or "not a coin"; anything the SDK cannot parse
 * as the live coin it claims to be throws UnreadableUtxoError.
 */
export async function openOwnedUtxo(
  crypto: StealthCryptoProvider,
  viewSecret: Uint8Array,
  substateId: string,
  utxo: unknown,
): Promise<DecryptedUtxo | null> {
  if (!utxo || typeof utxo !== 'object') throw new UnreadableUtxoError(substateId, 'the body is not an object')
  const body = utxo as { output?: unknown; is_frozen?: unknown }
  // Spent (`output: null`) or frozen: not a coin anyone can spend. Not ours to count, and not an error.
  if (body.output == null || body.is_frozen === true) return null

  const response = utxoResponse(utxo)
  let parsed: ReturnType<typeof parseSubstateUtxo>
  try {
    parsed = parseSubstateUtxo(response, substateId)
  } catch (e) {
    throw new UnreadableUtxoError(substateId, `the SDK refused it (${e instanceof Error ? e.message : String(e)})`)
  }
  if (parsed === null) throw new UnreadableUtxoError(substateId, 'the SDK could not parse a live UTXO from it')

  // Parsed, so a null from here is the decrypt's own verdict: the view key does not open it.
  return decryptOwnedUtxo(crypto, viewSecret, response, substateId)
}
