// What the faucet says about THIS wallet, read from the chain and nothing else.
//
// ── THREE READS, NO TRANSACTION ──────────────────────────────────────────────
//
//   /substates/<faucet component>   paused flag and claim amount (the component's own state)
//   /substates/<faucet vault>       what is left to give out
//   /substates/<each key's receipt> whether this wallet has already claimed
//
// ── TWO KEYS CAN HOLD THIS WALLET'S CLAIM ────────────────────────────────────
//
// Claims are made with the wallet's faucet key (derivation.PurposeKeys). Wallets that claimed before
// that were claimed with the OWNER key, and the template keys its receipt by whichever key claimed —
// so a receipt for either one means this wallet has had its claim. Checking only the new key would
// offer a second claim to every wallet that already took one.
//
// The claim RECEIPT is the only thing that decides whether the claim is offered. A balance never
// does: a wallet funded by a payment has never claimed, and a wallet that claimed and spent it all
// has. The old panel guessed from the balance ("you already have plenty"), which answered a
// different question.
//
// ── ORDER ────────────────────────────────────────────────────────────────────
//
//   claimed  >  paused  >  empty  >  open
//
// A wallet that has claimed is done with the faucet for good, so it never sees a "paused" or
// "empty" notice about a faucet it cannot use anyway.
//
// ── WHEN THE READ CANNOT ANSWER ──────────────────────────────────────────────
//
// `unknown`, and the panel shows nothing — the same rule the hero follows for a balance it cannot
// stand behind. One more case is covered by the claim itself rather than here: if an indexer ever
// served a burnt receipt as not-found, this reader would say `open`, and the claim's own dry run
// (which runs before anything is signed for real) would come back "Duplicate NFT token id" — see
// classifyClaimFailure in faucet.ts. That verdict is recorded with markFaucetClaimed below, so the
// wallet is told once and never offered the claim again.

import {
  FAUCET_COMPONENT_ADDRESS,
  FAUCET_TEMPLATE_ADDRESS,
  FAUCET_VAULT_ADDRESS,
  faucetReceiptId,
} from './faucetConfig'
import { pointRead, type PointRead } from './indexerConfig'
import { decodeRevealedAmount } from './revealedBalance'
import { TARI_RESOURCE_ADDRESS } from '@tari-project/ootle'

export type FaucetStatus =
  /** The reads could not establish the status. Show nothing. */
  | { kind: 'unknown'; reason: string }
  /** One of this wallet's keys has claimed. Final. */
  | { kind: 'claimed' }
  /** The admin has paused claims. */
  | { kind: 'paused'; claimAmount: bigint }
  /** Less than one claim's worth is left. */
  | { kind: 'empty'; claimAmount: bigint; available: bigint }
  /** Claimable now, for `claimAmount` µtTARI. */
  | { kind: 'open'; claimAmount: bigint; available: bigint }

/** The parts of the faucet component's state this module reads. */
export interface FaucetState {
  claimAmount: bigint
  paused: boolean
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null)

/**
 * An amount as the indexer's JSON carries it: a number for anything that fits, or a string.
 * A number past 2^53 has already lost precision in JSON.parse, so it is refused rather than used.
 */
function readAmount(v: unknown): bigint | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  return null
}

/**
 * Decode the faucet component substate as `GET /substates/<component>` returns it.
 *
 * The component's state is a CBOR array in field order —
 * `[vault, claim_amount, paused, receipts, admin_account]` — and the indexer serves it as JSON with
 * the same positions. Reading by position is safe only because a published template cannot change;
 * the template address in the header is checked first so a different component can never be read
 * as this one.
 *
 * Returns null for anything that is not that shape.
 */
export function decodeFaucetState(body: unknown): FaucetState | null {
  const component = obj(obj(obj(body)?.substate)?.Component)
  if (!component) return null
  if (obj(component.header)?.template_address !== FAUCET_TEMPLATE_ADDRESS) return null
  const state = obj(component.body)?.state
  if (!Array.isArray(state) || state.length !== 5) return null

  const claimAmount = readAmount(state[1])
  const paused = state[2]
  if (claimAmount === null || typeof paused !== 'boolean') return null
  return { claimAmount, paused }
}

/** The faucet vault's revealed TARI, from `GET /substates/<vault>`. Null if it is not that shape. */
export function decodeFaucetVault(body: unknown): bigint | null {
  return decodeRevealedAmount(obj(body)?.substate, TARI_RESOURCE_ADDRESS)
}

/**
 * Combine the reads into a status. Pure — the network half is readFaucetStatus.
 *
 * `receipts` are the point reads of each key's receipt: answered with a body means it exists (that
 * key has claimed); answered with no body means every indexer said not-found; not answered means
 * nothing could be established. ANY existing receipt is a claim. An unanswered one is decisive only
 * when no other receipt exists — "not claimed" needs every key to have answered.
 */
export function faucetStatusFrom(component: PointRead, vault: PointRead, receipts: readonly PointRead[]): FaucetStatus {
  if (receipts.length === 0) return { kind: 'unknown', reason: 'no claim receipt to read' }
  if (receipts.some(r => r.answered && r.body !== null)) return { kind: 'claimed' }
  if (receipts.some(r => !r.answered)) return { kind: 'unknown', reason: 'could not read this wallet’s claim receipt' }

  if (!component.answered || component.body === null) return { kind: 'unknown', reason: 'could not read the faucet' }
  const state = decodeFaucetState(component.body)
  if (!state) return { kind: 'unknown', reason: 'the faucet’s state was not in the expected shape' }
  if (state.paused) return { kind: 'paused', claimAmount: state.claimAmount }

  if (!vault.answered || vault.body === null) return { kind: 'unknown', reason: 'could not read the faucet’s balance' }
  const available = decodeFaucetVault(vault.body)
  if (available === null) return { kind: 'unknown', reason: 'the faucet’s balance was not in the expected shape' }
  // The same test the template's claim() makes, so "empty" here means a claim would be refused.
  if (available < state.claimAmount) return { kind: 'empty', claimAmount: state.claimAmount, available }
  return { kind: 'open', claimAmount: state.claimAmount, available }
}

/**
 * Read the faucet's status for a wallet, given every key it may have claimed with — its faucet key
 * and its owner key (see TWO KEYS above).
 *
 * A wallet already recorded as claimed (markFaucetClaimed) is answered without a request. The
 * record is only ever written from something the chain said, so it is a cache of a chain fact, not
 * a guess. `read` is injectable for tests.
 */
export async function readFaucetStatus(
  walletAddress: string,
  claimantPkHexes: readonly string[],
  read: (path: string) => Promise<PointRead> = pointRead,
): Promise<FaucetStatus> {
  if (loadFaucetClaimed(walletAddress)) return { kind: 'claimed' }
  const [component, vault, ...receipts] = await Promise.all([
    read(`/substates/${FAUCET_COMPONENT_ADDRESS}`),
    read(`/substates/${FAUCET_VAULT_ADDRESS}`),
    ...claimantPkHexes.map(pk => read(`/substates/${faucetReceiptId(pk)}`)),
  ])
  const status = faucetStatusFrom(component, vault, receipts)
  if (status.kind === 'claimed') markFaucetClaimed(walletAddress)
  return status
}

// ── THE CLAIMED RECORD ───────────────────────────────────────────────────────
//
// Per wallet, keyed by its address. Written on exactly three chain facts: the receipt exists, our
// claim committed, or a claim was refused as a duplicate. It exists because the receipt can take a
// minute to appear on the indexers after a claim commits, and a wallet that has just claimed must
// not be offered the claim again in that minute.
//
// Storage failures are swallowed for the same reason as the faucet dismissal: private mode throws
// on both read and write, and the only cost is that the next status read asks the chain again.

const claimedKey = (walletAddress: string) => `caravel-faucet-claimed-${walletAddress}`

export function loadFaucetClaimed(walletAddress: string): boolean {
  if (!walletAddress) return false
  try {
    return localStorage.getItem(claimedKey(walletAddress)) === '1'
  } catch {
    return false
  }
}

export function markFaucetClaimed(walletAddress: string): void {
  if (!walletAddress) return
  try { localStorage.setItem(claimedKey(walletAddress), '1') } catch { /* blocked storage — the chain is asked again next time */ }
}
