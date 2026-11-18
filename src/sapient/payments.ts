// Chat payments through Sapient — sending (create → poll → submit), shielding, and claiming. NO REACT.
//
// The loop is the spike's (~/dev/research/sapient-spike), proven on mainnet: Sapient returns a
// requestId at once and opens its approval popup; the request is polled; once APPROVED the dApp must
// submit it (approving sends nothing); submit resolves after finalization with the result.
//
// ── THE NONCE ────────────────────────────────────────────────────────────────
//
// A stealth output carries no sender, and anyone in a chat could name an output as "my payment to
// you". So every payment's memo carries a random nonce (`caravel:<nonce>`), and the chat message
// carries the same nonce. The recipient credits a payment only when the output's memo — readable only
// with the recipient's view key — matches the nonce in the message. Sapient puts the memo on the
// RECIPIENT's output only: our own change is built with no memo (sdk wallet.js sendPrivately, both the
// normal and the fee-from-transfer path), so change can never verify as a payment.

import { SapientError, TARI_RESOURCE, sapientRequest, toSapientError, type TariProvider } from './provider'

/** `parseOotleAddress` from @tari-project/ootle-wasm, injected so tests need no wasm. */
export type OotleAddressParser = (address: string) => { owner_key: Uint8Array; view_key: Uint8Array; network: number }

// ── Amounts ──────────────────────────────────────────────────────────────────

const TARI_DECIMALS = 6

/** "1.5" → 1500000n. String arithmetic only, at most 6 decimals. Throws a readable error. */
export function parseTari(input: string): bigint {
  const t = input.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(t)) throw new Error('Enter an amount with at most 6 decimals.')
  const [w, f = ''] = t.split('.')
  return BigInt(w) * 10n ** BigInt(TARI_DECIMALS) + BigInt(f.padEnd(TARI_DECIMALS, '0') || '0')
}

// ── Nonce and memo ───────────────────────────────────────────────────────────

/** 8 random bytes, hex. */
export function makePaymentNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function paymentMemo(nonce: string): string {
  return `caravel:${nonce}`
}

/**
 * A memo as Sapient hands it back, as plain text — or null when there is none to read.
 *
 * THE SAME MEMO ARRIVES IN TWO FORMS. tari_claimPrivatePayment and Sapient's transaction-history scan
 * decode it (`fromMemo`) to the plain text, `caravel:<nonce>`. Its UTXO-set scan (scanForOwnedUtxos,
 * which Sapient runs by itself when its popup opens after an unlock) stores it RAW — the JSON-encoded
 * Memo union, `{"Message":"caravel:<nonce>"}` — and tari_getShieldedOutputs returns whatever was
 * stored. Comparing the raw form to the plain one marked a genuine payment "not verified". Both forms
 * are decoded here; any other Memo variant is not ours.
 */
export function readMemo(memo: unknown): string | null {
  if (typeof memo !== 'string' || memo.length === 0) return null
  const t = memo.trim()
  if (t.startsWith('{')) {
    try {
      const m = JSON.parse(t) as { Message?: unknown } | null
      if (m && typeof m === 'object' && typeof m.Message === 'string') return m.Message.length ? m.Message : null
      return t   // another Memo variant: present, and not ours
    } catch { return memo }
  }
  return memo
}

/** True only for exactly our memo with exactly this nonce, in either form Sapient returns it. */
export function memoMatches(memo: unknown, nonce: string): boolean {
  return readMemo(memo) === paymentMemo(nonce)
}

// ── Addresses and networks ───────────────────────────────────────────────────

const NETWORK_BYTE: Record<string, number> = { mainnet: 0, igor: 36, esmeralda: 38 }

/**
 * Refuse a recipient this wallet cannot pay: unparseable, malformed, or on another network. The
 * network is checked against Sapient's, by the address's own network byte — a prefix test is not
 * enough, and a payment to the wrong network's keys is unrecoverable.
 */
export function assertPayableAddress(address: string, sapientNetwork: string | null, parse: OotleAddressParser): void {
  const trimmed = address.trim()
  if (!trimmed) throw new Error('Enter the address you want to pay.')
  let parsed: { owner_key: Uint8Array; view_key: Uint8Array; network: number }
  try { parsed = parse(trimmed) } catch { throw new Error('That doesn’t look like a valid Tari address. Check it and try again.') }
  if (parsed.owner_key?.length !== 32 || parsed.view_key?.length !== 32) throw new Error('That address is malformed and can’t receive a payment.')
  const want = sapientNetwork === null ? undefined : NETWORK_BYTE[sapientNetwork]
  if (want !== undefined && parsed.network !== want) {
    const theirs = Object.entries(NETWORK_BYTE).find(([, b]) => b === parsed.network)?.[0] ?? 'another network'
    throw new Error(`This address is on ${cap(theirs)}, but your wallet is on ${cap(sapientNetwork!)}.`)
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** `utxo_<resourceHex>_<commitment>` → the claim's arguments. Null for anything else. */
export function parseSubstateId(utxoId: string): { resourceAddress: string; commitment: string } | null {
  const m = /^utxo_([0-9a-f]{64})_([0-9a-f]{64})$/.exec(utxoId.trim().toLowerCase())
  return m ? { resourceAddress: `resource_${m[1]}`, commitment: m[2] } : null
}

// ── The request loop ─────────────────────────────────────────────────────────

export type RequestPhase = 'approve' | 'submitting' | 'finalizing'

export interface RequestHooks {
  /** The request exists — persist its id (the outbox) before anything else can go wrong. */
  onRequest?: (requestId: string) => void
  onPhase?: (phase: RequestPhase) => void
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

interface RequestStatus {
  status?: string
  error?: string
  note?: string
  result?: unknown
  expiresAt?: number
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Create a transaction request, wait for the person to approve it in Sapient, submit it, and return
 * the result. Throws SapientError: `declined` for a rejection in the popup, `wallet` (with Sapient's
 * reason) for a failure, and `wallet` "Request expired." past its 15-minute TTL.
 */
export async function runTransactionRequest<T>(p: TariProvider, op: Record<string, unknown>, hooks: RequestHooks = {}): Promise<T> {
  const sleep = hooks.sleep ?? realSleep
  const pollMs = hooks.pollMs ?? 1000
  const created = await sapientRequest<{ requestId?: unknown }>(p, 'tari_createTransactionRequest', op)
  const requestId = typeof created?.requestId === 'string' ? created.requestId : null
  if (!requestId) throw new SapientError('wallet', 'Sapient did not return a request id.', null)
  hooks.onRequest?.(requestId)
  return pollAndSubmit<T>(p, requestId, hooks, sleep, pollMs)
}

/** Poll a request to its end, submitting it (once) when the person approves it. */
async function pollAndSubmit<T>(
  p: TariProvider, requestId: string, hooks: RequestHooks, sleep: (ms: number) => Promise<void>, pollMs: number,
): Promise<T> {
  hooks.onPhase?.('approve')
  let submitted = false
  for (;;) {
    await sleep(pollMs)
    const s = await sapientRequest<RequestStatus>(p, 'tari_getTransactionRequest', { requestId })
    switch (s?.status) {
      case 'pending':
        continue
      case 'approved':
        if (submitted) continue
        submitted = true
        hooks.onPhase?.('finalizing')
        try {
          return await sapientRequest<T>(p, 'tari_submitTransactionRequest', { requestId })
        } catch (e) {
          // Only a record that already moved on is polled further; any other failure is final.
          if (/status is "(submitting|submitted)"/.test(toSapientError(e).message)) continue
          throw e
        }
      case 'submitting':
        hooks.onPhase?.('submitting')
        continue
      case 'submitted':
        return s.result as T
      case 'rejected':
        throw new SapientError('declined', 'Payment cancelled in Sapient.', 4001)
      case 'failed':
        throw new SapientError('wallet', s.error || 'The transaction failed.', null)
      default:
        if (s?.expiresAt && Date.now() > s.expiresAt + 5000) throw new SapientError('wallet', 'Request expired.', null)
        continue
    }
  }
}

/**
 * Where an existing request stands, read ONCE — for resuming the outbox after a reload, which must
 * never submit on its own and never wait in a loop. `gone` covers rejected, failed, expired, and a
 * request Sapient no longer knows.
 */
export type RequestState =
  | { s: 'submitted'; result: unknown }
  | { s: 'approved' }
  | { s: 'waiting' }
  | { s: 'gone' }

export async function readRequest(p: TariProvider, requestId: string): Promise<RequestState> {
  let r: RequestStatus | null
  try {
    r = await sapientRequest<RequestStatus>(p, 'tari_getTransactionRequest', { requestId })
  } catch (e) {
    // Locked or unreachable is not "gone": leave it for the next attempt. Anything else is.
    if (toSapientError(e).kind === 'locked') return { s: 'waiting' }
    return { s: 'gone' }
  }
  switch (r?.status) {
    case 'submitted': return { s: 'submitted', result: r.result }
    case 'approved': return { s: 'approved' }
    case 'pending':
    case 'submitting': return { s: 'waiting' }
    default: return { s: 'gone' }
  }
}

// ── Send and shield ──────────────────────────────────────────────────────────

export interface SendResult {
  transactionId: string
  recipientCommitment: string
  recipientSubstateId: string
}

export function asSendResult(r: unknown): SendResult {
  const o = r as Partial<SendResult> | null
  if (!o || typeof o.transactionId !== 'string' || typeof o.recipientSubstateId !== 'string') {
    throw new SapientError('wallet', 'Sapient returned an unexpected result for the payment.', null)
  }
  return { transactionId: o.transactionId, recipientCommitment: String(o.recipientCommitment ?? ''), recipientSubstateId: o.recipientSubstateId }
}

export async function sendPrivately(
  p: TariProvider, args: { recipient: string; amount: bigint; nonce: string }, hooks: RequestHooks = {},
): Promise<SendResult> {
  const r = await runTransactionRequest<unknown>(p, {
    kind: 'sendPrivately',
    resourceAddress: TARI_RESOURCE,
    recipientWalletAddress: args.recipient,
    amount: args.amount.toString(),
    memo: paymentMemo(args.nonce),
  }, hooks)
  return asSendResult(r)
}

/** Make `amount` of public TARI private, in this same account. */
export async function shield(p: TariProvider, amount: bigint, hooks: RequestHooks = {}): Promise<void> {
  await runTransactionRequest<unknown>(p, { kind: 'shield', resourceAddress: TARI_RESOURCE, amount: amount.toString() }, hooks)
}

/** "Amount exceeds your private balance (you have 123)." → 123n; null for any other message. */
export function insufficientPrivateBalance(message: string): bigint | null {
  const m = /exceeds your private balance \(you have (\d+)\)/i.exec(message)
  return m ? BigInt(m[1]) : null
}

// ── Claiming ─────────────────────────────────────────────────────────────────

export type ClaimOutcome =
  /** The output is ours and its memo carries this message's nonce. */
  | { s: 'verified'; amount: string }
  /** The output is ours, but its memo is NOT this message's (or it is our own send) — nobody is credited. */
  | { s: 'unverified'; amount: string | null; reason: 'memo' | 'own-send' }
  /** Ours, but there is no memo to read (none attached, or the output is already spent) — retryable. */
  | { s: 'unconfirmed' }
  /** Not ours, or not on chain (yet) — Sapient cannot tell the two apart. */
  | { s: 'not-found' }

/**
 * Claim the output a payment message names, and decide whether it is THIS message's payment.
 *
 * "Already claimed" is success (the wallet's own scan may have found it first): the output is then
 * read from tari_getShieldedOutputs. On that path an output created by one of OUR OWN sends
 * (`ownTxIds`: the outbox and our sent payments) is refused outright — our own change is ours by
 * construction, never a payment from someone else. A fresh claim cannot be our change: Sapient
 * records change at send time, so it would have been "already claimed".
 */
export async function claimPayment(
  p: TariProvider, ref: { utxoId: string; nonce: string }, ownTxIds: ReadonlySet<string>,
): Promise<ClaimOutcome> {
  const parts = parseSubstateId(ref.utxoId)
  if (!parts) return { s: 'not-found' }
  try {
    const r = await sapientRequest<{ amount?: unknown; memo?: unknown }>(p, 'tari_claimPrivatePayment', parts)
    return judgeMemo(r?.memo, String(r?.amount ?? '0'), ref.nonce)
  } catch (e) {
    const err = toSapientError(e)
    if (/doesn'?t belong to your account|wasn'?t found on-chain/i.test(err.message)) return { s: 'not-found' }
    if (!/already claimed/i.test(err.message)) throw err
  }
  // Already claimed: find it among the unspent outputs.
  const outs = await sapientRequest<unknown>(p, 'tari_getShieldedOutputs', { resourceAddress: parts.resourceAddress })
  const hit = Array.isArray(outs)
    ? (outs as { commitment?: unknown; amount?: unknown; memo?: unknown; transactionId?: unknown }[])
        .find(o => typeof o?.commitment === 'string' && o.commitment.toLowerCase() === parts.commitment)
    : undefined
  // Not among the unspent outputs: spent since, so there is no memo left to read. Not "not verified".
  if (!hit) return { s: 'unconfirmed' }
  const amount = String(hit.amount ?? '0')
  if (typeof hit.transactionId === 'string' && hit.transactionId !== '' && ownTxIds.has(hit.transactionId)) return { s: 'unverified', amount, reason: 'own-send' }
  return judgeMemo(hit.memo, amount, ref.nonce)
}

/** Verified on a match; "not verified" only for a memo that is there and is not ours; else unconfirmed. */
function judgeMemo(memo: unknown, amount: string, nonce: string): ClaimOutcome {
  const text = readMemo(memo)
  if (text === null) return { s: 'unconfirmed' }
  return text === paymentMemo(nonce) ? { s: 'verified', amount } : { s: 'unverified', amount, reason: 'memo' }
}
