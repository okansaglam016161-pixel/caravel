// CARAVEL TERMINAL HARNESS — the shipping crypto/transaction paths, run against the live
// Esmeralda indexer, printing what actually happens at every stage.
//
//   node scripts/harness.mjs <command> [args]        (the .mjs sets Node up — read it first)
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
//
// Browser testing a transaction failure is a guess-loop: the UI shows one sentence, the console
// shows a slice of the story, and every iteration costs an unlock and a click-through. This runs
// the SAME modules the app runs — build → dry run → submit → poll → scan → decrypt → balance — and
// prints the unedited truth at each step: the URLs called, the bytes back, the instructions
// actually sent, and the FULL transaction verdict rather than the half of it that says "Commit".
//
// ── IT IS THE SHIPPING CODE, NOT A MODEL OF IT ───────────────────────────────
//
// Every import below is from src/crypto/. There is no second implementation of derivation, input
// selection, the fee probe, the build or the poll anywhere in this file — if the harness disagrees
// with the app, that is a bug in the harness and not a finding. The only things written here are
// argument parsing, the network recorder, and the printing.
//
// The one consequence worth knowing: the harness can only see what the modules expose. Where a
// path has no prepare/submit split (confidentialSend), the harness cannot offer one either. That
// asymmetry is reported rather than papered over.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//
//   CARAVEL_TEST_MNEMONIC   the wallet, from the environment ONLY. Never read from a file, never
//                           written anywhere, never printed — not in the identity block, not in
//                           the network log, not in an error.
//
//   READ-ONLY commands  — `scan`, `resolve` — touch nothing and cost nothing. Run them freely.
//   WRITE commands      — `make-private`, `make-public`, `send` — MOVE REAL TESTNET FUNDS and pay
//                         real fees. They refuse to submit without `--yes`. Without it they still
//                         do the whole build and the dry run, print the quoted fee and the exact
//                         instructions, and stop one step short of submitting — which is where
//                         most of the interesting failures live anyway.

import { deriveIdentity, detectScheme, type DerivationScheme } from '../src/crypto/derivation'
import { recoverAccountAddress } from '../src/crypto/accountRecovery'
import { loadAccountAddress, saveAccountAddress } from '../src/crypto/accountStore'
import { scanWallet } from '../src/crypto/walletScanner'
import { UTXO_PAGE_LIMIT, MAX_UTXO_PAGES } from '../src/crypto/utxoFeed'
import { scanOwnedUtxos, MAX_STEALTH_INPUTS, RESOURCE_HEX } from '../src/crypto/stealthUtxos'
import { fetchAllUtxoRows } from '../src/crypto/utxoFeed'
import { INDEXER_URLS, pointRead } from '../src/crypto/indexerConfig'
import { fetchOwnedRows, recoveryCandidates } from '../src/crypto/ownedFeed'
import { beginEntry, loadJournal } from '../src/crypto/journalStore'
import { readRevealedBalance } from '../src/crypto/revealedBalance'
import { prepareConceal, MIN_CONCEAL_MICROTARI } from '../src/crypto/conceal'
import { prepareReveal, MIN_REVEAL_MICROTARI, maxRevealable } from '../src/crypto/reveal'
import { sendConfidential, describeMicrotari, maxStealthSend, MAX_FEE } from '../src/crypto/confidentialSend'
import { claimFaucet } from '../src/crypto/faucet'
import { readFinalizedVerdict, describeFailure } from '../src/crypto/txResult'
import {
  loadExcludedIds, loadSpentOutputs, markLocked, release, heldOutOfBalance,
  ABSENT_SCANS_TO_FORGET, MIN_RETENTION_MS, UNRESOLVED_AFTER_ATTEMPTS, UNRESOLVED_AFTER_MS,
} from '../src/crypto/spentOutputs'
import { sweepLocks, STALE_LOCK_MS } from '../src/crypto/lockSweep'
import {
  advanceSettle, settleAction, type PendingSettle, type SettleEvidence,
} from '../src/context/settle'
import { setStoreKey } from '../src/crypto/sessionKey'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import { Network, WasmStealthCrypto } from '@tari-project/ootle'
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'

// ── WHICH INDEXER ────────────────────────────────────────────────────────────
//
// Every module under src/crypto hardcodes `https://ootle-indexer-a.tari.com` — twelve separate
// private constants, no shared config, no env var. So there is no supported way to point the app
// at another node, and this override does NOT add one: it rewrites the request as it leaves,
// inside the harness's own fetch wrapper, and src/ is untouched. The shipping code still believes
// it is talking to `-a`.
//
// WHY IT EXISTS. `ootle-indexer-b.tari.com` is a second live Esmeralda indexer (undocumented;
// found by probing the `-a` suffix). Measured against `-a` at the IDENTICAL epoch, block height
// and block hash, it serves a different `/utxos` set — 964 rows against 886, stable across
// repeated passes. The listing a stealth scan reads is therefore node-local and can be materially
// short, which is a thing a balance that reads zero deserves to be tested against.
//
// ORIGIN ONLY. An override carrying a path is refused rather than guessed at: every URL the
// shipping code builds is `<base>/<route>`, and silently prefixing a path would produce 404s that
// look like an indexer with no data — the exact wrong answer to be handed while debugging a zero
// balance.
const CANONICAL_INDEXER = 'https://ootle-indexer-a.tari.com'

const INDEXER_OVERRIDE = (() => {
  const raw = (process.env.CARAVEL_INDEXER_URL ?? '').trim().replace(/\/+$/, '')
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) } catch { throw new Error(`CARAVEL_INDEXER_URL is not a valid URL: "${raw}"`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`CARAVEL_INDEXER_URL must be http(s), got "${u.protocol}"`)
  }
  if (u.pathname !== '/' && u.pathname !== '') {
    throw new Error(`CARAVEL_INDEXER_URL must be a bare origin with no path, got "${u.pathname}".`)
  }
  return u.origin
})()

/** The indexer actually being talked to. The header states it; printNet shortens against it. */
const INDEXER = INDEXER_OVERRIDE ?? CANONICAL_INDEXER

/**
 * Point a request at the override, if it was going to the canonical indexer.
 *
 * Host-matched rather than string-prefixed, so it catches every form the SDK might build (trailing
 * slash, explicit port, different case). Anything not addressed to `-a` — a relay, a Blossom host —
 * is returned untouched.
 */
function redirectIndexer(url: string): string {
  if (!INDEXER_OVERRIDE) return url
  try {
    const u = new URL(url)
    if (u.host !== new URL(CANONICAL_INDEXER).host) return url
    const base = new URL(INDEXER_OVERRIDE)
    u.protocol = base.protocol
    u.host = base.host
    return u.href
  } catch { return url }
}

// ── The network recorder ─────────────────────────────────────────────────────
//
// WRAPS THE GLOBAL `fetch` rather than asking the modules to report anything. That is the whole
// design: `utxoFeed`, `feeProbe`, `txResult`'s callers and IndexerProvider all reach for the same
// global, so one wrapper sees every request any of them makes — including the ones inside the SDK,
// which we could not instrument any other way. Nothing under src/ changes, and nothing can be
// forgotten at a call site.
//
// The response is cloned and read in full so its true size is known even when the server sends no
// content-length. That buffers every page in memory; on a microscope, truth beats thrift.

interface NetCall {
  n: number
  method: string
  url: string
  status: number | string
  bytes: number
  ms: number
  /** The request body, for the POSTs worth reading back (dry-run and submit). */
  reqBody?: string
  /** The response body, kept so a command can print it verbatim. */
  resBody?: string
}

const net: NetCall[] = []
const realFetch = globalThis.fetch

/** See the note in the wrapper below. */
const BLOCK_SSE = (process.env.CARAVEL_HARNESS_BLOCK_SSE ?? '') !== ''

globalThis.fetch = async function instrumentedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET') ?? 'GET').toUpperCase()
  const reqBody = typeof init?.body === 'string' ? init.body : undefined
  const started = performance.now()
  const n = net.length + 1

  // ── SIMULATING A BROKEN EVENT STREAM ─────────────────────────────────────
  //
  // CARAVEL_HARNESS_BLOCK_SSE makes every request to the indexer's `/events` stream fail, which is
  // what a corporate proxy that does not understand `text/event-stream`, or a dropped connection,
  // looks like from inside the app. It is how the REST fallback in crypto/finality is proved
  // against a REAL transaction rather than an injected stub: with the stream unavailable, the
  // verdict must still arrive.
  if (BLOCK_SSE && requested.includes('/events')) {
    net.push({ n, method, url: requested, status: 'BLOCKED (CARAVEL_HARNESS_BLOCK_SSE)', bytes: 0, ms: 0 })
    throw new TypeError('harness: SSE stream blocked on purpose')
  }

  // THE REWRITE, applied here and nowhere else — see CANONICAL_INDEXER above. The URL recorded and
  // printed is the one actually CALLED, never the one the shipping code asked for: a log that
  // showed `-a` while the bytes came from `-b` would make an A/B comparison worthless.
  const url = redirectIndexer(requested)
  const target: RequestInfo | URL =
    url === requested ? input
    : typeof input === 'string' || input instanceof URL ? url
    : new Request(url, input)

  let resp: Response
  try {
    resp = await realFetch(target as RequestInfo, init)
  } catch (e) {
    net.push({ n, method, url, status: `ERR ${e instanceof Error ? e.name : 'unknown'}`, bytes: 0, ms: performance.now() - started, reqBody })
    throw e
  }

  // ── NEVER READ AN EVENT STREAM ───────────────────────────────────────────
  //
  // The recorder measures a response by cloning it and reading it to the end. An SSE stream has no
  // end: `GET /events` stays open for the life of the watcher, so cloning and reading it would
  // hang this wrapper forever and take the whole harness with it — including the very
  // settle-by-SSE path it exists to prove. The stream is recorded as an OPEN CONNECTION instead,
  // which is the interesting fact about it anyway: its presence in the log is the proof that
  // finality came from a push rather than a poll.
  const streaming = (resp.headers.get('content-type') ?? '').includes('text/event-stream')
  if (streaming) {
    net.push({ n, method, url, status: resp.status, bytes: -1, ms: performance.now() - started, reqBody })
    return resp
  }

  let resBody = ''
  try { resBody = await resp.clone().text() } catch { /* body already consumed or not text */ }
  net.push({ n, method, url, status: resp.status, bytes: resBody.length, ms: performance.now() - started, reqBody, resBody })
  return resp
} as typeof fetch

/** Everything recorded since `mark`. Commands snapshot the length, then print the delta. */
const since = (mark: number) => net.slice(mark)

function printNet(mark: number, opts: { full?: boolean } = {}): void {
  const calls = since(mark)
  if (calls.length === 0) { console.log('  (no network calls)'); return }
  for (const c of calls) {
    const path = c.url.startsWith(INDEXER) ? c.url.slice(INDEXER.length) : c.url
    const shown = path.length > 96 ? `${path.slice(0, 93)}…` : path
    console.log(
      `  ${String(c.n).padStart(3)}  ${c.method.padEnd(4)} ${String(c.status).padStart(6)}  ` +
      `${fmtBytes(c.bytes).padStart(9)}  ${c.ms.toFixed(0).padStart(6)}ms  ${shown}`,
    )
    // /utxos pages are megabytes of other people's outputs — size is the only interesting part.
    // Everything else (dry runs, results, substates) is printed whole, because on those endpoints
    // the body IS the finding.
    if (opts.full && c.resBody && !c.url.includes('/utxos?')) {
      console.log(indent(pretty(c.resBody), '        │ '))
    }
  }
  const bytes = calls.reduce((s, c) => s + c.bytes, 0)
  const ms = calls.reduce((s, c) => s + c.ms, 0)
  console.log(`  ── ${calls.length} call(s), ${fmtBytes(bytes)} received, ${(ms / 1000).toFixed(1)}s in flight`)
}

/** The last recorded call whose URL contains `needle`. */
const lastCall = (needle: string, mark = 0) => since(mark).filter(c => c.url.includes(needle)).at(-1)

// ── Formatting ───────────────────────────────────────────────────────────────

const MICROTARI_PER_TARI = 1_000_000n

function fmtBytes(n: number): string {
  // -1 marks a stream the recorder deliberately did not read to the end. See instrumentedFetch.
  if (n < 0) return 'stream'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/** Both units, always. µtTARI is what the code computes in; TARI is what a person reads. */
function amt(microtari: bigint): string {
  return `${describeMicrotari(microtari)} tTARI  (${microtari.toLocaleString('en-US')} µtTARI)`
}

function pretty(body: string): string {
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}

const indent = (s: string, pad: string) => s.split('\n').map(l => pad + l).join('\n')

function rule(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n ${title}\n${'─'.repeat(78)}`)
}

function field(label: string, value: string): void {
  console.log(`  ${label.padEnd(16)}: ${value}`)
}

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

/**
 * An amount from the command line, exactly.
 *
 * `12.5` is TARI (the unit the UI shows); `12500000u` is raw µtTARI (the unit every module
 * computes in). Parsed by STRING arithmetic and never through a float: `tariToMicrotari` in
 * confidentialSend.ts goes via `Number`, which is fine for a slider bound to two decimals and is
 * not fine for an amount typed by hand at a terminal. This is argument parsing, not shipping
 * logic — the value it produces is handed to the real modules untouched.
 */
function parseAmount(arg: string): bigint {
  const raw = /^(\d[\d_]*)u$/.exec(arg)
  if (raw) return BigInt(raw[1]!.replace(/_/g, ''))
  const dec = /^(\d[\d_]*)(?:\.(\d{1,6}))?$/.exec(arg)
  if (!dec) throw new Error(`Cannot read "${arg}" as an amount. Use TARI ("12.5") or µtTARI ("12500000u").`)
  return BigInt(dec[1]!.replace(/_/g, '')) * MICROTARI_PER_TARI + BigInt((dec[2] ?? '').padEnd(6, '0'))
}

// ── The build recorder ───────────────────────────────────────────────────────
//
// THE SEALED ENVELOPE IS UNREADABLE ON THE WIRE. `sealTransaction` emits base64 CBOR — measured:
// a 360-character string beginning `ggCBgoKK…` — and decoding it without the engine's schema would
// yield positional arrays of bytes, not named instructions. So the instructions are captured one
// step EARLIER, while they are still plain objects.
//
// `signTransaction([signer], unsigned)` hands the UnsignedTransactionV1 to each signer, and every
// path in this harness signs with a SecretKeyWallet — including the send path, which wraps it in an
// OotleWallet that delegates to the same registered key provider. Patching that one prototype
// method therefore sees every transaction built here, dry run and real, and src/ is untouched.
//
// It also captures the thing a wire dump could never show as clearly: `dry_run`, which must ride
// INSIDE the sealed envelope (see feeProbe.ts) and is the difference between a simulation and a
// spend.

interface RecordedBuild {
  dryRun: boolean
  tx: Record<string, unknown>
}

const builds: RecordedBuild[] = []
const realSign = SecretKeyWallet.prototype.signTransaction
SecretKeyWallet.prototype.signTransaction = function patchedSign(unsignedTx, sealPublicKey) {
  const tx = unsignedTx as unknown as Record<string, unknown>
  builds.push({ dryRun: tx.dry_run === true, tx })
  return realSign.call(this, unsignedTx, sealPublicKey)
}

const lastBuild = (dryRun?: boolean) =>
  (dryRun === undefined ? builds : builds.filter(b => b.dryRun === dryRun)).at(-1)

/**
 * A built transaction, printed as the engine will read it.
 *
 * `fee_instructions` run first and pay for everything; `instructions` are the body. Each entry is
 * a single-key object naming the instruction — that key is the useful half, and the reject reasons
 * the network returns index into these lists ("At instruction #3"), so the numbering here is the
 * numbering to count with.
 */
function printInstructions(build: RecordedBuild | undefined): void {
  if (!build) { console.log('  (no transaction was built)'); return }

  for (const name of ['fee_instructions', 'instructions'] as const) {
    const list = build.tx[name]
    if (!Array.isArray(list)) { console.log(`  ${name}: (absent)`); continue }
    console.log(`  ${name} (${list.length}):`)
    list.forEach((ins: unknown, i: number) => {
      const isObj = ins !== null && typeof ins === 'object' && !Array.isArray(ins)
      const tag = isObj ? Object.keys(ins as object)[0] ?? '?' : String(ins)
      let payload = JSON.stringify(isObj ? (ins as Record<string, unknown>)[tag] : ins) ?? ''
      if (payload.length > 200) payload = `${payload.slice(0, 197)}…`
      console.log(`    #${String(i).padStart(2)}  ${tag.padEnd(28)} ${payload}`)
    })
  }

  // THE DECLARED INPUTS ARE NOT OPTIONAL on the conceal/reveal paths — an account component that
  // is not declared is not reused, and the withdraw then panics with "No vault for resource".
  // Printing them beside the instructions is how you tell that failure from a genuinely empty vault.
  const inputs = build.tx.inputs
  console.log(`  inputs (${Array.isArray(inputs) ? inputs.length : 0}):`)
  if (Array.isArray(inputs)) for (const i of inputs) console.log(`    ${JSON.stringify(i)}`)

  console.log(`  dry_run: ${build.dryRun}   min_epoch: ${JSON.stringify(build.tx.min_epoch ?? null)}   max_epoch: ${JSON.stringify(build.tx.max_epoch ?? null)}`)
}


// ── Identity ─────────────────────────────────────────────────────────────────

interface Harnessed {
  wallet: SecretKeyWallet
  address: string
  ownerPkHex: string
  viewSecret: Uint8Array
  npub: string
  scheme: DerivationScheme
}

/**
 * The wallet under test, through Caravel's OWN derivation.
 *
 * The phrase comes from the environment and goes straight into `deriveIdentity` — the same call
 * the unlock screen makes, with the same scheme resolution — so what the harness exercises is the
 * real wallet and not a key that merely resembles it. Nothing derived here is written to disk and
 * the phrase itself is never held beyond this function.
 */
async function identity(): Promise<Harnessed> {
  const phrase = process.env.CARAVEL_TEST_MNEMONIC
  if (!phrase || !phrase.trim()) {
    throw new Error(
      'CARAVEL_TEST_MNEMONIC is not set.\n' +
      '  Set it in the environment only — never on the command line where it lands in shell history:\n' +
      '    read -rs CARAVEL_TEST_MNEMONIC && export CARAVEL_TEST_MNEMONIC',
    )
  }

  // detectScheme is the app's own answer to "which derivation does this phrase belong to". It can
  // say 'ambiguous' — a phrase valid under both — which the UI resolves by ASKING. There is nobody
  // to ask here, so the harness states the default it took and offers the override, rather than
  // quietly picking one: the two schemes produce entirely different wallets from the same words.
  const detected = detectScheme(phrase)
  const override = process.env.CARAVEL_TEST_SCHEME as DerivationScheme | undefined
  if (detected === 'invalid' && !override) {
    throw new Error('CARAVEL_TEST_MNEMONIC is not a valid recovery phrase under either scheme.')
  }
  const scheme: DerivationScheme = override ?? (detected === 'ambiguous' || detected === 'invalid' ? 'cipherseed' : detected)

  const { wallet, nostr, storeKey } = await deriveIdentity(phrase, scheme)
  // EXACTLY WHAT UNLOCK DOES (WalletContext: `setStoreKey(identity.storeKey)`). Every per-identity
  // store — the journal, the first-seen ledger, and now the spend record — is sealed under this
  // key, so without it loadExcludedIds would read as empty and the harness would silently test the
  // pre-fix behaviour while appearing to test the fix.
  setStoreKey(storeKey)
  const address = await wallet.getAddress()
  const ownerPkHex = hex(await wallet.getPublicKey())
  const viewSecret = await wallet.getViewSecret()

  rule('identity  (crypto/derivation.deriveIdentity)')
  field('scheme', scheme + (override ? '  (from CARAVEL_TEST_SCHEME)' : detected === 'ambiguous' ? '  (phrase is valid under BOTH — default taken; set CARAVEL_TEST_SCHEME to override)' : `  (detected)`))
  field('address', address)
  field('owner pubkey', ownerPkHex)
  field('npub', nostr.npub)
  // The secret itself is never printed. Its LENGTH and the agreement between the two accessors are
  // worth stating: walletScanner is given `getViewOnlySecret()` by the app and stealthUtxos calls
  // `getViewSecret()`, and if those ever diverged the balance and the spendable set would be
  // scanned with different keys — a wallet that can see funds it cannot spend.
  const legacy = wallet.getViewOnlySecret()
  const agree = legacy !== null && legacy.length === viewSecret.length && legacy.every((b, i) => b === viewSecret[i])
  field('view secret', `${viewSecret.length} bytes (not printed) · getViewOnlySecret ≡ getViewSecret: ${agree ? 'yes' : 'NO — THE TWO SCANS USE DIFFERENT KEYS'}`)
  field('resource', RESOURCE_HEX)

  return { wallet, address, ownerPkHex, viewSecret, npub: nostr.npub, scheme }
}

/**
 * The account component address, recovered exactly as the app recovers it on unlock.
 *
 * conceal and reveal both refuse before building anything if this is missing, so a harness run
 * that could not answer has to say so loudly rather than fail later with the module's own
 * (user-facing, network-flavoured) message. CARAVEL_TEST_ACCOUNT short-circuits the probe for a
 * wallet whose address is already known.
 */
async function primeAccount(h: Harnessed): Promise<string | null> {
  rule('account  (crypto/accountRecovery.recoverAccountAddress)')
  const mark = net.length
  const forced = process.env.CARAVEL_TEST_ACCOUNT
  if (forced) {
    saveAccountAddress(h.address, forced)
    field('account', `${forced}  (from CARAVEL_TEST_ACCOUNT — probe skipped)`)
    return forced
  }
  // In the browser this is read from localStorage and is usually already there; in a fresh Node
  // process it never is, so every run exercises the recovery probe — which is the interesting path.
  const stored = loadAccountAddress(h.address)
  const recovered = await recoverAccountAddress(h.wallet, h.address)
  field('stored before', stored ?? '(none — probing, as an unlock on a new device would)')
  field('account', recovered ?? 'null — THE PROBE COULD NOT ANSWER. make-private / make-public will refuse.')

  // READ IT BACK THROUGH THE STORE. recoverAccountAddress returns what it probed whether or not
  // the write landed, so reporting its return value alone once had the harness announce an address
  // that prepareConceal could not then find — see the localStorage note in harness.mjs. conceal and
  // reveal read this through loadAccountAddress, so this is the value that actually decides.
  const readBack = loadAccountAddress(h.address)
  if (recovered && readBack !== recovered) {
    field('◀ STORE', `WROTE "${recovered}" BUT READ BACK ${readBack === null ? 'null' : `"${readBack}"`} — the account store is not working; conceal/reveal will refuse.`)
  }
  printNet(mark)
  return recovered
}

// ── Transaction result, read in full ─────────────────────────────────────────

/**
 * `GET /transactions/{id}/result`, printed as three separate things, because they are three
 * separate things and conflating the first two is the bug txResult.ts exists to end:
 *
 *   final_decision                             consensus's word — says "Commit" for a fee-only
 *                                              commit, i.e. for a transaction that did not happen.
 *   execution_result.finalize.result           the actual verdict: Accept / AcceptFeeRejectRest
 *                                              + reason / Reject + reason.
 *   readFinalizedVerdict (crypto/txResult)     what the shipping code makes of the two.
 */
async function printTxResult(txId: string, opts: { raw?: boolean } = {}): Promise<void> {
  const mark = net.length
  const res = await fetch(`${INDEXER}/transactions/${encodeURIComponent(txId)}/result`)
  const call = lastCall('/result', mark)
  field('HTTP', `${res.status} ${res.statusText}  (${fmtBytes(call?.bytes ?? 0)})`)
  if (!res.ok) { console.log(`  body: ${(call?.resBody ?? '').slice(0, 500)}`); return }

  const json = await res.json() as Record<string, unknown>
  const finalized = (json.result as Record<string, unknown> | undefined)?.Finalized as Record<string, unknown> | undefined
  const exec = (finalized?.execution_result as Record<string, unknown> | undefined)?.finalize as Record<string, unknown> | undefined

  field('final_decision', String(finalized?.final_decision ?? '(none — not yet decided)'))
  field('result', exec?.result !== undefined ? JSON.stringify(exec.result).slice(0, 600) : '(no execution_result.finalize.result)')

  const receipt = exec?.fee_receipt as Record<string, unknown> | undefined
  if (receipt) {
    field('fees paid', String(receipt.total_fees_paid ?? '?') + ' µtTARI  (RESERVED, and not refunded on this path)')
    field('overcharge', String(receipt.total_fee_overcharge ?? '?') + ' µtTARI')
    const breakdown = (receipt.cost_breakdown as Record<string, unknown> | undefined)?.breakdown
    if (breakdown) field('cost breakdown', JSON.stringify(breakdown))
  }

  const verdict = readFinalizedVerdict(json)
  field('txResult verdict', verdict === null ? 'null — NOT YET DECIDED (a poller keeps polling)' : verdict.kind)
  if (verdict && verdict.kind !== 'accept') console.log(`\n  ${describeFailure(verdict)}`)

  if (opts.raw) {
    console.log('\n  ── raw body ──')
    console.log(indent(pretty(call?.resBody ?? ''), '  '))
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * READ-ONLY. The one that answers "can this wallet see its funds at all".
 *
 * Runs BOTH scans, because the app runs both and they are not the same question:
 *
 *   walletScanner.scanWallet     feeds the BALANCE. Trial-decrypts every row; counts value.
 *   stealthUtxos.scanOwnedUtxos  feeds the SPENDABLE INPUTS. Same decrypt, then additionally
 *                                requires a readable `public_nonce` — an output without one cannot
 *                                be authorized, so it is dropped from the spendable set while
 *                                still counting toward the balance.
 *
 * A gap between those two numbers is a wallet that displays money it cannot move, which is exactly
 * the class of failure this harness was built to find, so both are printed side by side.
 */
async function cmdScan(h: Harnessed): Promise<void> {
  const ctrl = new AbortController()
  process.once('SIGINT', () => { console.log('\n(aborting scan…)'); ctrl.abort() })

  const excluded = loadExcludedIds(h.address)
  rule('spend record  (crypto/spentOutputs)')
  printSpendRecord(h)

  rule('private scan  (crypto/walletScanner.scanWallet → crypto/utxoFeed.fetchAllUtxoRows)')
  const markScan = net.length
  const t0 = performance.now()
  let lastLine = 0
  // ONLY ON A TTY. The callback fires every 50 rows and rewrites one line with \r; piped into a
  // file or a grep those carriage returns survive and smear the log that is the actual output.
  const tty = process.stdout.isTTY === true
  const scan = await scanWallet(h.viewSecret, p => {
    if (!tty || performance.now() - lastLine < 250) return
    lastLine = performance.now()
    process.stdout.write(`\r  scanning… ${p.scanned} rows, ${p.found} owned`)
  }, ctrl.signal, { excluded, walletAddress: h.address })
  if (tty) process.stdout.write('\r' + ' '.repeat(60) + '\r')

  const pages = since(markScan).filter(c => c.url.includes('/utxos?')).length
  field('rows fetched', `${scan.totalScanned.toLocaleString('en-US')}  (network-wide unspent TARI outputs, not ours)`)
  field('pages', `${pages}  (page limit ${UTXO_PAGE_LIMIT}, runaway guard ${MAX_UTXO_PAGES})`)
  field('incomplete', scan.incomplete ? 'TRUE — the walk hit its page bound; the balance may UNDERSTATE' : 'false  (the set was read to the end)')
  field('owned', `${scan.utxos.length}  (rows that decrypt with this wallet’s view key, minus what we have spent)`)
  field('excluded', scan.excludedPresent.length === 0
    ? '0  (the indexer is listing nothing we have already spent)'
    : `${scan.excludedPresent.length}  ◀ OURS, ALREADY SPENT, AND STILL LISTED — held out of the balance below`)
  field('private balance', amt(scan.balance))
  field('elapsed', `${((performance.now() - t0) / 1000).toFixed(1)}s`)

  // THE DIAGNOSIS THE BROWSER NEVER GIVES. "0 owned" has two completely different causes and the
  // UI shows the same empty balance for both.
  if (scan.totalScanned === 0) {
    console.log('\n  ▶ NO ROWS. The indexer returned no unspent TARI outputs at all — this is about the\n' +
                '    indexer or the resource address, not about this wallet.')
  } else if (scan.utxos.length === 0) {
    console.log(`\n  ▶ ROWS PRESENT BUT NONE DECRYPT AS MINE. ${scan.totalScanned.toLocaleString('en-US')} outputs were read and\n` +
                '    trial-decrypted; none opened with this wallet’s view key. Either this wallet has never\n' +
                '    received a private output, or its funds sit beyond the pages that were read\n' +
                `    (incomplete=${scan.incomplete}), or the view key is not the one that received them.`)
  }

  if (scan.utxos.length > 0) {
    console.log('\n  owned outputs:')
    for (const u of [...scan.utxos].sort((a, b) => (a.amount > b.amount ? -1 : 1))) {
      console.log(`    ${describeMicrotari(u.amount).padStart(16)} tTARI  ${u.commitment}${u.message ? `  memo: ${JSON.stringify(u.message).slice(0, 60)}` : ''}`)
    }
  }
  printNet(markScan)

  rule('spendable set  (crypto/stealthUtxos.scanOwnedUtxos)')
  const markSpend = net.length
  const owned = await scanOwnedUtxos(new WasmStealthCrypto(Network.Esmeralda), h.viewSecret, { excluded, walletAddress: h.address })
  const total = owned.reduce((s, u) => s + u.value, 0n)
  const values = owned.map(u => u.value)
  field('spendable', `${owned.length}  (decrypted AND carrying a usable public_nonce)`)
  field('dropped', scan.utxos.length - owned.length > 0
    ? `${scan.utxos.length - owned.length}  ◀ DECRYPTED BUT NOT SPENDABLE — visible in the balance, unmovable`
    : '0')
  field('spendable total', amt(total))
  field('input cap', `${MAX_STEALTH_INPUTS} outputs per transaction (crypto/stealthUtxos.MAX_STEALTH_INPUTS)`)
  field('max one send', `${amt(maxStealthSend(values))}   [balance reachable in one tx, minus the ${MAX_FEE} µtTARI ceiling]`)
  field('max reveal', amt(maxRevealable(values)))
  printNet(markSpend)

  const account = await primeAccount(h)

  rule('public balance  (crypto/revealedBalance.readRevealedBalance)')
  const markPub = net.length
  const provider = await IndexerProvider.connect({ url: INDEXER, network: Network.Esmeralda })
  const revealed = await readRevealedBalance(provider, account)
  provider.stopWatcher?.()
  field('public balance', amt(revealed))
  printNet(markPub)

  rule('totals')
  field('private', amt(scan.balance))
  field('public', amt(revealed))
  field('combined', amt(scan.balance + revealed))
}

/** READ-ONLY. The curl we kept doing, through the code that reads it. */
async function cmdResolve(txId: string): Promise<void> {
  rule(`transaction result  (crypto/txResult.readFinalizedVerdict)`)
  field('tx', txId)
  await printTxResult(txId, { raw: true })
}

// ── Write commands ───────────────────────────────────────────────────────────
//
// THESE MOVE REAL TESTNET FUNDS. Each prints the whole build first and only submits with `--yes`.

/** The progress callback the UI passes, printed as a stage log. */
const stage = (msg: string) => console.log(`  · ${msg}`)

/**
 * How long the wait took, and what it was racing.
 *
 * ── IT REPORTS WHAT IT CAN SEE, AND NOT WHAT IT WOULD LIKE TO ───────────────
 *
 * An earlier version of this printed "the verdict was PUSHED, not polled" whenever a connection to
 * `/events` appeared in the log. That was an inference the harness had no right to make, and it
 * was wrong: the stream connects and then says nothing. Measured against both public indexers —
 * a hundred seconds on indexer-a, sixty on indexer-b — `/events` emits only the keep-alive comment
 * lines that hold an event stream open, and no `TransactionFinalized` event ever arrives. The
 * first real send under the watcher took 181 seconds for a verdict the chain had made in about
 * ninety, because the watcher waited out its whole timeout and only then read REST.
 *
 * So this prints the observable facts — a connection, a count of result reads, an elapsed time —
 * and leaves the conclusion to whoever reads them. What it DOES assert is the thing that matters
 * and that it can actually know: whether the wait outlived the old thirty-second cutoff, and
 * whether a real verdict came back anyway.
 */
function printSettlement(mark: number, elapsedMs: number, outcome: string): void {
  const calls = since(mark)
  const sse = calls.filter(c => c.url.includes('/events'))
  const polls = calls.filter(c => c.url.includes('/result'))
  const blocked = sse.some(c => String(c.status).startsWith('BLOCKED'))

  rule('settlement  (crypto/finality.awaitFinality)')
  field('elapsed', `${(elapsedMs / 1000).toFixed(1)}s  (the old loop gave up at 30s)`)
  field('SSE stream', sse.length === 0
    ? '(no connection recorded)'
    : blocked
      ? `${sse.length} attempt(s), BLOCKED on purpose — the stream side of the race was unavailable`
      : `${sse.length} connection(s) opened to /events  (open \u2260 delivering: see crypto/finality)`)
  field('result reads', `${polls.length}  (the REST side of the race, plus the final fallback)`)
  field('outcome', outcome + (outcome === 'Timeout' ? '   \u25c0 no decision was legible in time' : ''))

  if (outcome === 'Timeout') return
  if (elapsedMs > 30_000) {
    console.log('\n  \u25b6 A REAL VERDICT, AFTER THE OLD 30s CUTOFF. The polling loop this replaced would have\n' +
                '    returned Timeout here \u2014 stranding this transaction\u2019s inputs in the spend record until a\n' +
                '    later sweep, and holding their value out of the balance in the meantime.')
  } else {
    console.log('\n  \u25b6 Settled inside 30s, so the old loop would have caught this one too.')
  }
}

function writeBanner(what: string, amount: bigint, yes: boolean): void {
  rule(`${what}  \u00b7  ${amt(amount)}`)
  console.log(yes
    ? '  \u26a0  WRITE COMMAND, --yes GIVEN. This WILL submit a transaction and spend real testnet funds.'
    : '  DRY RUN ONLY. The transaction is built and priced against the live network but NOT submitted.\n' +
      '  Add --yes to submit it for real.')
}

/** What the dry run was asked and what it answered — printed from the recorded wire traffic. */
function printDryRun(mark: number): void {
  console.log('\n  the transaction that was priced:')
  printInstructions(lastBuild(true))
  const probe = lastCall('/transactions/dry-run', mark)
  if (!probe) { console.log('\n  (no dry-run call was recorded)'); return }
  console.log('\n  dry-run response:')
  console.log(indent(pretty(probe.resBody ?? ''), '    '))
}

/**
 * The submitted envelope, then the verdict — quoted fee beside charged fee.
 *
 * The two fee figures come from different places on purpose: the quote is what `prepareX` returned
 * (dry-run cost + crypto/feeProbe's margin, which is what a user would have approved), and the
 * charge is `fee_receipt.total_fees_paid` off the committed result. They are allowed to differ;
 * seeing by how much is the point.
 */
async function printSubmitted(txId: string, quoted: bigint, outcome: string, reason: string | undefined): Promise<void> {
  console.log('\n  the transaction actually submitted:')
  printInstructions(lastBuild(false))
  rule('verdict')
  field('tx id', txId)
  field('module outcome', outcome + (reason ? '' : ''))
  if (reason) console.log(`\n  ${reason}\n`)
  await printTxResult(txId, { raw: true })

  const paid = lastCall('/result')?.resBody
  let charged: bigint | null = null
  try {
    const j = JSON.parse(paid ?? '{}')
    const v = j?.result?.Finalized?.execution_result?.finalize?.fee_receipt?.total_fees_paid
    if (v != null) charged = BigInt(v)
  } catch { /* leave null */ }
  rule('fees')
  field('quoted', amt(quoted) + '   [dry run + crypto/feeProbe margin — what the UI would show]')
  field('charged', charged === null ? '(not readable from the result)' : amt(charged))
  if (charged !== null) field('difference', amt(quoted - charged) + '   [reserved but unused; NOT refunded on this path]')
}

/** WRITE. The conceal path: revealed vault → private stealth output. */
async function cmdMakePrivate(h: Harnessed, amount: bigint, yes: boolean): Promise<void> {
  writeBanner('make-private  (crypto/conceal.prepareConceal)', amount, yes)
  if (amount < MIN_CONCEAL_MICROTARI) {
    console.log(`\n  (below the module's floor of ${MIN_CONCEAL_MICROTARI} µtTARI — prepareConceal will refuse; showing you that refusal.)`)
  }
  const account = await primeAccount(h)
  if (!account) console.log('\n  ▶ No account address. prepareConceal refuses before building — see below.')

  rule('build + price')
  const mark = net.length
  const prepared = await prepareConceal(h.wallet, h.address, { amountMicrotari: amount, onProgress: stage })
  field('withdraw', amt(prepared.withdrawAmount) + '   [leaves the vault]')
  field('fee', amt(prepared.feeMicrotari) + '   [carved OUT of the amount]')
  field('lands private', amt(prepared.concealedAmount))
  printDryRun(mark)
  printNet(mark)

  if (!yes) { console.log('\n  STOPPED BEFORE SUBMIT. Nothing was sent. Re-run with --yes to submit.'); return }

  rule('submit')
  const markSubmit = net.length
  const t0 = performance.now()
  const result = await prepared.submit(stage)
  printSettlement(markSubmit, performance.now() - t0, result.outcome)
  await printSubmitted(result.txId, prepared.feeMicrotari, result.outcome, result.reason)
  field('self outputs', result.selfOutputIds ? JSON.stringify(result.selfOutputIds) : 'undefined (statement unreadable)')
  printNet(markSubmit)
}

/** WRITE. The reveal path: private stealth inputs → revealed vault balance. */
async function cmdMakePublic(h: Harnessed, amount: bigint, yes: boolean): Promise<void> {
  writeBanner('make-public  (crypto/reveal.prepareReveal)', amount, yes)
  if (amount < MIN_REVEAL_MICROTARI) {
    console.log(`\n  (below the module's floor of ${MIN_REVEAL_MICROTARI} µtTARI — prepareReveal will refuse; showing you that refusal.)`)
  }
  const account = await primeAccount(h)
  if (!account) console.log('\n  ▶ No account address. prepareReveal refuses before building — see below.')

  rule('build + price')
  const mark = net.length
  const prepared = await prepareReveal(h.wallet, h.address, { amountMicrotari: amount, onProgress: stage })
  field('spending', `${prepared.inputCount} stealth output(s) worth ${amt(prepared.inputTotal)}`)
  field('lands public', amt(prepared.revealedAmount) + '   [exactly what was asked for]')
  field('fee', amt(prepared.feeMicrotari) + '   [paid from the stealth inputs, NOT from the amount]')
  field('revealed output', amt(prepared.revealedOutput) + '   [amount + fee — what the bucket must hold]')
  field('stealth change', amt(prepared.changeAmount))
  printDryRun(mark)
  printNet(mark)

  if (!yes) { console.log('\n  STOPPED BEFORE SUBMIT. Nothing was sent. Re-run with --yes to submit.'); return }

  rule('submit')
  const markSubmit = net.length
  const t0 = performance.now()
  const result = await prepared.submit(stage)
  printSettlement(markSubmit, performance.now() - t0, result.outcome)
  await printSubmitted(result.txId, prepared.feeMicrotari, result.outcome, result.reason)
  field('self outputs', result.selfOutputIds ? JSON.stringify(result.selfOutputIds) : 'undefined (statement unreadable)')
  printNet(markSubmit)
}

/**
 * WRITE. The confidential send path: private stealth inputs → someone else's stealth output.
 *
 * ── THIS ONE CANNOT BE DRY-RUN-ONLY, AND THAT IS A PROPERTY OF THE MODULE ────
 *
 * conceal and reveal expose prepare/submit as two calls, so the harness can stop between them.
 * `sendConfidential` is one call that scans, selects, prices AND submits, so there is no seam to
 * stop at — asking for one here would mean reimplementing the send, which is the one thing this
 * harness must not do. So `send` requires --yes and says why.
 *
 * The recipient must be an Ootle ADDRESS. An npub is not accepted: nothing in src/crypto turns one
 * into an address — that mapping lives in the Nostr contact layer, where an address is something a
 * peer TOLD you, not something derived — so a harness that accepted an npub would have to invent
 * the lookup, and a wrong answer there sends money to a stranger.
 */
async function cmdSend(h: Harnessed, dest: string, amount: bigint, yes: boolean, memo?: string): Promise<void> {
  writeBanner('send  (crypto/confidentialSend.sendConfidential)', amount, yes)
  field('recipient', dest)

  if (dest.startsWith('npub')) {
    throw new Error(
      'An npub cannot be resolved here. sendConfidential takes an Ootle address, and no module under\n' +
      '  src/crypto maps npub → address (that lookup lives in the Nostr contact layer). Pass the\n' +
      '  recipient’s Ootle address.',
    )
  }
  if (!yes) {
    console.log(
      '\n  CANNOT DRY-RUN THIS PATH. sendConfidential scans, prices AND submits in one call — there is\n' +
      '  no prepare/submit split to stop between, unlike conceal and reveal. Re-run with --yes to\n' +
      '  actually send, or use `make-private` / `make-public` to exercise a build without spending.',
    )
    return
  }

  rule('scan → select → price → submit')
  const mark = net.length
  const t0 = performance.now()
  const result = await sendConfidential(h.wallet, h.address, {
    recipient: dest,
    amountMicrotari: amount,
    memo,
    onProgress: stage,
  })
  const elapsed = performance.now() - t0
  printDryRun(mark)
  // The whole call is timed, not just the wait — sendConfidential has no prepare/submit split, so
  // scanning and pricing are inside it. The settlement figures below are still the interesting
  // part: what matters is that the wait no longer ends at 30s with a Timeout.
  printSettlement(mark, elapsed, result.outcome)
  field('recipient utxo', result.recipientUtxoId ?? 'undefined (commitment unreadable)')
  field('self outputs', result.selfOutputIds ? JSON.stringify(result.selfOutputIds) : 'undefined (statement unreadable)')
  // The send path reads its own charged fee out of the receipt; MAX_FEE is the ceiling it priced
  // against, so that is the honest "quoted" figure to compare when the poll came back empty.
  await printSubmitted(result.txId, result.feeMicrotari ?? MAX_FEE, result.outcome, result.reason)
  printNet(mark)
}


// ── The spend record ─────────────────────────────────────────────────────────

/** What this wallet believes it has already spent, and why each entry is there. */
function printSpendRecord(h: Harnessed): void {
  const store = loadSpentOutputs(h.address)
  const rows = Object.entries(store.records)
  field('locked', `${rows.filter(([, r]) => r.status === 'locked').length}  (submitted, no verdict yet — not selectable)`)
  field('spent', `${rows.filter(([, r]) => r.status === 'spent').length}  (the network accepted the transaction that consumed them)`)
  field('retention', `${ABSENT_SCANS_TO_FORGET} consecutive complete scans absent, and ${MIN_RETENTION_MS / 60_000} minutes old, before an entry is forgotten`)
  if (store.degradedAt !== null) {
    field('◀ DEGRADED', `a write was lost at ${new Date(store.degradedAt).toISOString()} — some spend may not be excluded`)
  }
  for (const [id, r] of rows) {
    const age = Math.max(0, Date.now() - r.at)
    console.log(
      `    ${r.status.padEnd(7)} age ${describeAge(age).padStart(8)}  attempts:${String(r.attempts).padStart(2)}` +
      `  absent:${String(r.absent).padStart(2)}\n      coin ${id}\n      tx   ${r.txId}`,
    )
  }
}

/** ms as something a person reads at a glance. */
function describeAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

/**
 * What the exclusion set is costing the displayed balance, measured the way the app measures it.
 *
 * NEEDS A SCAN, because only a coin the indexer is STILL listing subtracts from anything — the
 * store alone cannot say which those are. That is the same reason the app derives this from
 * `scan.excludedPresent` rather than from the record.
 */
async function printHeld(h: Harnessed): Promise<void> {
  const scan = await scanWallet(h.viewSecret, () => {}, new AbortController().signal, { excluded: loadExcludedIds(h.address), walletAddress: h.address })
  const held = heldOutOfBalance(loadSpentOutputs(h.address), scan.excludedPresent)
  field('shown balance', amt(scan.balance))
  field('held back', `${amt(held.totalMicrotari)}  across ${held.count} coin(s) the indexer still lists`)
  field('true total', `${amt(scan.balance + held.totalMicrotari)}  (what the wallet would show with nothing excluded)`)
  if (held.unresolved.length === 0) {
    field('unresolved', `0  (nothing held longer than ${UNRESOLVED_AFTER_MS / 60_000}m or past ${UNRESOLVED_AFTER_ATTEMPTS} failed sweeps)`)
    return
  }
  field('◀ UNRESOLVED', `${held.unresolved.length} transaction(s) holding money back with no explanation:`)
  for (const u of held.unresolved) {
    console.log(`      ${amt(u.microtari)}  held ${describeAge(u.ageMs)}, ${u.attempts} failed sweep(s)\n      tx ${u.txId}`)
  }
}

/** READ-ONLY. Just the record. */
async function cmdSpent(h: Harnessed): Promise<void> {
  rule('spend record  (crypto/spentOutputs)')
  field('store', `caravel.utxospent.v1.${h.address.slice(0, 20)}…  (sealed under the wallet store key)`)
  printSpendRecord(h)

  rule('what it is costing the balance  (crypto/spentOutputs.heldOutOfBalance)')
  await printHeld(h)
  if (!process.env.CARAVEL_HARNESS_STATE) {
    console.log('\n  NOTE: CARAVEL_HARNESS_STATE is not set, so this record is in-memory and per-process.\n' +
                '  Set it to a file path to carry the record between commands (e.g. a real send, then a scan).')
  }
}

/**
 * READ-ONLY, SPENDS NOTHING — the end-to-end proof that a spent coin disappears from both places.
 *
 * Against the LIVE indexer with the REAL decrypt, so what it exercises is the shipping path and
 * not a fixture: scan, lock one real owned output, scan again, and check that the balance fell by
 * exactly that output's value AND that coin selection stops offering it. Then release it and check
 * the wallet comes back to where it started.
 *
 * NO TRANSACTION IS BUILT OR SUBMITTED. The lock is written with a harness-owned transaction id
 * that no network will ever return, and it is released in a `finally` so an interrupted run cannot
 * leave a real coin excluded.
 */
async function cmdProveSpend(h: Harnessed): Promise<void> {
  const PROOF_TX = 'harness-proof-not-a-real-transaction'
  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const sig = new AbortController().signal
  let failures = 0
  const check = (label: string, ok: boolean, detail: string) => {
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : '◀ FAIL'}  ${label.padEnd(52)} ${detail}`)
  }

  rule('prove-spend  ·  READ-ONLY, nothing is submitted and no funds move')

  // ── Before ──
  const before = await scanWallet(h.viewSecret, () => {}, sig, { excluded: loadExcludedIds(h.address), walletAddress: h.address })
  const ownedBefore = await scanOwnedUtxos(crypto, h.viewSecret, { excluded: loadExcludedIds(h.address), walletAddress: h.address })
  field('balance before', amt(before.balance))
  field('owned before', `${before.utxos.length} in the balance, ${ownedBefore.length} selectable`)

  if (ownedBefore.length === 0) {
    console.log('\n  Nothing to prove against: this wallet has no spendable stealth output.\n' +
                '  Fund it (make-private, or receive a payment) and run this again.')
    return
  }

  // The SMALLEST output, so the arithmetic below is on the least interesting coin the wallet has.
  const victim = [...ownedBefore].sort((a, b) => (a.value < b.value ? -1 : 1))[0]!
  field('locking', `${amt(victim.value)}\n                    ${victim.substateId}`)

  try {
    // ── Lock it, exactly as a submitted transaction does ──
    const locked = markLocked(h.address, [victim.substateId], PROOF_TX)
    check('the lock was recorded', locked.ok && locked.locked === 1, `locked=${locked.locked} ok=${locked.ok}`)

    const excluded = loadExcludedIds(h.address)
    check('it is in the exclusion set', excluded.has(victim.substateId), `${excluded.size} excluded`)

    // ── BALANCE: the number must fall by exactly this coin ──
    const after = await scanWallet(h.viewSecret, () => {}, sig, { excluded, walletAddress: h.address })
    check('the balance dropped by exactly its value',
      after.balance === before.balance - victim.value,
      `${before.balance} − ${victim.value} = ${before.balance - victim.value}, got ${after.balance}`)
    check('it is gone from the owned set',
      !after.utxos.some(u => u.id === victim.substateId),
      `${after.utxos.length} owned, was ${before.utxos.length}`)
    check('the indexer is still listing it',
      after.excludedPresent.some(e => e.id === victim.substateId),
      `excludedPresent=${after.excludedPresent.length} — this is the lag the record exists to bridge`)
    check('its value is carried out for the safety net',
      after.excludedPresent.some(e => e.id === victim.substateId && e.microtari === victim.value),
      `${amt(after.excludedPresent.reduce((t, e) => t + e.microtari, 0n))} held back`)

    // ── SELECTION: the half that prevents a doomed transaction ──
    const ownedAfter = await scanOwnedUtxos(crypto, h.viewSecret, { excluded, walletAddress: h.address })
    check('coin selection no longer offers it',
      !ownedAfter.some(u => u.substateId === victim.substateId),
      `${ownedAfter.length} selectable, was ${ownedBefore.length}`)

  } finally {
    // FULLY REVERSIBLE, and release is the only cleanup used. The proof deliberately stops at
    // `locked` and never promotes the coin to `spent`: nothing in the app may downgrade a `spent`
    // record — that is the guard which stops a genuinely spent coin returning to the spendable set
    // — so promoting a real coin here would leave residue the public API cannot clear. The
    // promote / release / retention semantics are covered where they belong, in
    // src/crypto/spentOutputs.test.ts, against a store that starts empty.
    //
    // In a `finally` so an interrupted run cannot leave a real coin excluded.
    release(h.address, PROOF_TX)
  }

  const restored = await scanWallet(h.viewSecret, () => {}, sig, { excluded: loadExcludedIds(h.address), walletAddress: h.address })
  check('releasing restores the balance', restored.balance === before.balance,
    `${restored.balance} vs ${before.balance}`)
  check('the record is clean again',
    !loadExcludedIds(h.address).has(victim.substateId), 'no residue from this proof')

  rule(failures === 0 ? 'PROVEN — the spend record excludes from BOTH the balance and the selection' : `${failures} CHECK(S) FAILED`)
  if (failures > 0) process.exitCode = 1
}

/**
 * WRITE, but from the faucet's purse rather than the user's.
 *
 * Here because the spend record cannot be proved against a wallet with nothing in it, and this is
 * the one action that takes a fresh wallet from zero to real stealth outputs: `claimFaucet` mints
 * the payout AND converts it to stealth in a single transaction, so what lands is exactly the
 * owned, spendable set `prove-spend` needs. ONE CLAIM PER PUBLIC KEY, ever — the faucet burns a
 * claim NFT — so a wallet that has claimed cannot claim again.
 */
async function cmdFaucet(h: Harnessed, yes: boolean): Promise<void> {
  rule('faucet claim  (crypto/faucet.claimFaucet)')
  console.log(yes
    ? '  ⚠  WRITE COMMAND. Submits a real claim. Testnet faucet funds, once per wallet, forever.'
    : '  Add --yes to actually claim. Nothing is submitted without it.')
  if (!yes) return

  const mark = net.length
  const result = await claimFaucet(h.wallet, h.address, stage)
  field('tx id', result.txId)
  field('outcome', result.outcome)
  if (result.reason) console.log(`\n  ${result.reason}\n`)
  field('amount', amt(result.amount))
  field('fee', result.feeMicrotari === undefined ? '(not reported)' : amt(result.feeMicrotari))
  field('self outputs', result.selfOutputIds ? JSON.stringify(result.selfOutputIds) : 'undefined')
  // Same free capture the app makes: the claim is the one transaction that runs CreateAccount.
  if (result.accountAddress) {
    saveAccountAddress(h.address, result.accountAddress)
    field('account', result.accountAddress)
  }
  printNet(mark)
  console.log('\n  The payout takes 60-90s to appear in /utxos — the listing trails consensus.')
}

/**
 * READ-ONLY. Resolve every lock this wallet still holds, against what the chain says.
 *
 * The repair, run by hand. It is the same `sweepLocks` the app runs on unlock and after every
 * scan — so what this prints is exactly what the wallet does to itself, with the verdicts visible.
 */
async function cmdResolveLocks(h: Harnessed): Promise<void> {
  rule('resolve-locks  (crypto/lockSweep.sweepLocks)  ·  READ-ONLY, nothing is submitted')
  const sig = new AbortController().signal

  const before = await scanWallet(h.viewSecret, () => {}, sig, { excluded: loadExcludedIds(h.address), walletAddress: h.address })
  const heldBefore = heldOutOfBalance(loadSpentOutputs(h.address), before.excludedPresent)
  field('balance before', amt(before.balance))
  field('held back', amt(heldBefore.totalMicrotari))

  const mark = net.length
  const result = await sweepLocks(h.address)
  if (result.swept === 0) {
    console.log('\n  No locks held — nothing to resolve, and no request was made.')
    return
  }

  console.log('')
  for (const step of result.steps) {
    const verdict = step.verdict === null ? 'no verdict (pending, or unreachable)' : step.verdict.kind
    const acted = step.action === 'promote' ? `promoted ${step.affected} coin(s) to spent — they stay excluded`
      : step.action === 'release' ? `RELEASED ${step.affected} coin(s) — they were never consumed`
      : `kept locked (attempt ${step.affected > 0 ? 'recorded' : 'not recorded'})`
    console.log(`  ${step.txId}\n    verdict : ${verdict}\n    action  : ${step.action} — ${acted}`)
    if (step.verdict && step.verdict.kind !== 'accept') console.log(`    reason  : ${describeFailure(step.verdict)}`)
  }

  const after = await scanWallet(h.viewSecret, () => {}, sig, { excluded: loadExcludedIds(h.address), walletAddress: h.address })
  const heldAfter = heldOutOfBalance(loadSpentOutputs(h.address), after.excludedPresent)
  rule('after')
  field('swept', `${result.swept} locked transaction(s), ${result.resolved} resolved`)
  field('balance after', amt(after.balance))
  field('held back', amt(heldAfter.totalMicrotari))
  field('recovered', amt(after.balance - before.balance))
  printNet(mark)
}

/**
 * READ-ONLY, SUBMITS NOTHING — the end-to-end proof that a lock is temporary.
 *
 * It manufactures the exact failure that understated a real wallet — a live coin locked against a
 * transaction nobody went back to read — and then checks that the real sweep resolves it the way
 * the chain says it should.
 *
 * ── FOUR CASES, AND WHY CASE 3 IS THE ONE THAT MATTERS ──────────────────────
 *
 *   1  a transaction the chain has NEVER HEARD OF, lock still young → KEEP. A 404 is not a
 *      rejection; treating it as one would release a coin that may well be spent.
 *   2  a REJECTED transaction → RELEASE, and the balance comes back. This is the case that was
 *      stranding money.
 *   3  a transaction whose RESULT HAS BEEN PRUNED and a lock too old to be in flight → the sweep
 *      falls back to asking about the COIN, finds it live, and releases. This is the repair path
 *      for every historical strand, and it exists because of what this command discovered: the
 *      indexer 404s the results of transactions it committed hours earlier, so an old lock can
 *      never be resolved from a transaction result. Case 3 runs entirely against the real chain.
 *   4  an ACCEPTED transaction → PROMOTE. Run on a SYNTHETIC coin id, because a promotion cannot
 *      be undone — nothing in the app may downgrade `spent` — and this command must not
 *      permanently exclude a real coin.
 *
 * Cases 1-3 act on a real coin and release it in a `finally`, so an interrupted run cannot leave
 * anything excluded.
 */
async function cmdProveSweep(h: Harnessed, rejectedTxId?: string): Promise<void> {
  const sig = new AbortController().signal
  let failures = 0
  const check = (label: string, ok: boolean, detail: string) => {
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : '\u25c0 FAIL'}  ${label.padEnd(56)} ${detail}`)
  }
  const balance = async () =>
    (await scanWallet(h.viewSecret, () => {}, sig, { excluded: loadExcludedIds(h.address), walletAddress: h.address })).balance

  rule('prove-sweep  \u00b7  READ-ONLY, nothing is submitted and no funds move')

  const before = await balance()
  const owned = await scanOwnedUtxos(new WasmStealthCrypto(Network.Esmeralda), h.viewSecret, { excluded: loadExcludedIds(h.address), walletAddress: h.address })
  field('balance before', amt(before))
  if (owned.length === 0) {
    console.log('\n  Nothing to prove against: this wallet has no spendable stealth output.')
    return
  }
  const victim = [...owned].sort((a, b) => (a.value < b.value ? -1 : 1))[0]!
  field('test coin', `${amt(victim.value)}\n                    ${victim.substateId}`)
  // Locks this wallet was already holding. They are left alone — every stub below is scoped to its
  // own transaction — but they are worth naming, because they are part of why `before` is what it
  // is, and a stale one of them is what case 3 repairs for real wallets.
  const existing = loadSpentOutputs(h.address)
  const preLocked = Object.values(existing.records).filter(r => r.status === 'locked')
  if (preLocked.length > 0) {
    field('already locked', `${preLocked.length} coin(s) from ${new Set(preLocked.map(r => r.txId)).size} earlier transaction(s) — untouched by this proof`)
  }

  // ── Case 1: a transaction the chain has never heard of, lock still young → KEEP ──
  const UNKNOWN_TX = 'f'.repeat(64)
  try {
    markLocked(h.address, [victim.substateId], UNKNOWN_TX)
    const step = (await sweepLocks(h.address)).steps.find(x => x.txId === UNKNOWN_TX)
    check('1. an unknown tx yields no verdict', step?.verdict === null, `verdict=${String(step?.verdict)}`)
    check('1. the sweep KEEPS the lock (404 is not a rejection)', step?.action === 'keep', `action=${step?.action}, via=${step?.via}`)
    check('1. the attempt is counted for the safety net',
      (loadSpentOutputs(h.address).records[victim.substateId]?.attempts ?? 0) > 0,
      `attempts=${loadSpentOutputs(h.address).records[victim.substateId]?.attempts ?? 0}`)
  } finally {
    release(h.address, UNKNOWN_TX)
  }

  // ── Case 2: a rejected transaction → RELEASE, and the balance comes back ──
  const REJECT_TX = rejectedTxId ?? 'harness-injected-reject'
  try {
    markLocked(h.address, [victim.substateId], REJECT_TX)
    check('2. locking it drops the balance', (await balance()) === before - victim.value,
      `${await balance()} vs ${before - victim.value}`)
    const step = (rejectedTxId
      ? await sweepLocks(h.address)
      : await sweepLocks(h.address, {
        // INJECTED, and only here. Manufacturing a real on-chain rejection means deliberately
        // paying a fee for a doomed transaction, and this command spends nothing. Pass a real
        // rejected txid as an argument to run this case against the chain instead. The shape is
        // the real one: result.Finalized.execution_result.finalize.result.Reject.
        //
        // SCOPED TO THIS TRANSACTION. A sweep resolves every lock the wallet holds, so a fetcher
        // that answered for all of them would apply this verdict to locks left by other runs —
        // which is exactly what it did on the first attempt, releasing an unrelated coin and
        // making three later checks disagree about the balance. Everything else gets `null`,
        // which is the truthful "no answer from this stub".
        fetchResult: async (txId) => (txId !== REJECT_TX ? null : {
          result: {
            Finalized: {
              final_decision: 'Commit',
              execution_result: { finalize: { result: { Reject: { ExecutionFailure: 'Input substate utxo_\u2026 is down' } } } },
            },
          },
        }),
      })).steps.find(x => x.txId === REJECT_TX)
    check(`2. a rejected tx resolves to reject${rejectedTxId ? ' (real chain)' : ' (injected body)'}`,
      step?.verdict?.kind === 'reject' || step?.verdict?.kind === 'fee-only', `verdict=${step?.verdict?.kind ?? 'none'}`)
    check('2. the sweep RELEASES it', step?.action === 'release', `action=${step?.action}`)
    check('2. the balance comes back', (await balance()) === before, `${await balance()} vs ${before}`)
  } finally {
    release(h.address, REJECT_TX)
  }

  // ── Case 3: a pruned result + a stale lock → the COIN decides. Entirely real chain. ──
  //
  // The lock is backdated rather than waited for: STALE_LOCK_MS is thirty minutes, and what is
  // under test is the decision, not the clock. Everything else here is live — a real transaction
  // id the indexer has forgotten, and a real `/substates` read of a real coin.
  const PRUNED_TX = 'a'.repeat(64)
  try {
    markLocked(h.address, [victim.substateId], PRUNED_TX, Date.now() - STALE_LOCK_MS - 1)
    check('3. the lock drops the balance', (await balance()) === before - victim.value,
      `${await balance()} vs ${before - victim.value}`)
    const step = (await sweepLocks(h.address)).steps.find(x => x.txId === PRUNED_TX)
    check('3. the result is unavailable, as every old result is', step?.verdict === null, `verdict=${String(step?.verdict)}`)
    check('3. so the COIN is asked instead', step?.via === 'substate', `via=${step?.via}`)
    check('3. it is live on chain, so the sweep RELEASES it', step?.action === 'release', `action=${step?.action}`)
    check('3. the balance is repaired', (await balance()) === before, `${await balance()} vs ${before}`)
  } finally {
    release(h.address, PRUNED_TX)
  }

  // ── Case 4: an accepted transaction → PROMOTE, on a coin that does not exist ──
  //
  // UNIQUE PER RUN, both of them. A promotion cannot be undone, so re-using one id would mean the
  // second run found a `spent` record, markLocked correctly refused to downgrade it, and the case
  // silently had nothing to sweep — which is exactly what happened the first time this was written.
  const nonce = Date.now().toString(16).padStart(16, '0') + Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0')
  const SYNTHETIC = `utxo_${RESOURCE_HEX}_${nonce.padEnd(64, '0').slice(0, 64)}`
  const ACCEPT_TX = `harness-injected-accept-${nonce.slice(0, 12)}`
  markLocked(h.address, [SYNTHETIC], ACCEPT_TX)
  const acceptStep = (await sweepLocks(h.address, {
    // Scoped, for the reason spelled out in case 2 — an unscoped Accept would promote every lock
    // the wallet is holding, permanently.
    fetchResult: async (txId) => (txId !== ACCEPT_TX ? null : {
      result: { Finalized: { final_decision: 'Commit', execution_result: { finalize: { result: { Accept: {} } } } } },
    }),
  })).steps.find(x => x.txId === ACCEPT_TX)
  check('4. an accepted tx resolves to accept', acceptStep?.verdict?.kind === 'accept', `verdict=${acceptStep?.verdict?.kind ?? 'none'}`)
  check('4. the sweep PROMOTES it', acceptStep?.action === 'promote', `action=${acceptStep?.action}`)
  check('4. the coin stays excluded \u2014 it really is spent',
    loadExcludedIds(h.address).has(SYNTHETIC), 'held out, correctly and permanently')

  check('the real coin is back and nothing of ours is excluded',
    !loadExcludedIds(h.address).has(victim.substateId) && (await balance()) === before,
    `balance ${await balance()} vs ${before}`)

  rule(failures === 0
    ? 'PROVEN \u2014 a lock always resolves: promote, release, or keep, from the tx result or from the coin'
    : `${failures} CHECK(S) FAILED`)
  if (failures > 0) process.exitCode = 1
  console.log('\n  (case 4 left a `spent` record on a synthetic coin id that does not exist on chain;\n' +
              '   reconciliation forgets it once it has been absent long enough.)')
}

/**
 * WRITE — the proof that a settle now waits for its change instead of firing early.
 *
 * ── WHAT IT DEMONSTRATES ────────────────────────────────────────────────────
 *
 * src/context/settle.ts is pure — no React, no timers — so the harness can drive the real decision
 * function over REAL scan data and print, tick by tick, what each test would have concluded:
 *
 *   direction (old)  `balance < before`. The spend record excludes the inputs at submit, so this
 *                    turns true immediately, while the balance is short by the whole change. This
 *                    is the test that ended the settle at the exact moment the figure was wrong.
 *   evidence (new)   is this transaction's own change output in the owned set yet? Only true once
 *                    the indexer has listed it, which is when the figure is actually right.
 *
 * The first ticks should disagree. That disagreement IS the bug, and watching it close is the fix.
 */
async function cmdProveSettle(h: Harnessed, dest: string, amount: bigint, yes: boolean): Promise<void> {
  const sig = new AbortController().signal
  const scan = () => scanWallet(h.viewSecret, () => {}, sig, { excluded: loadExcludedIds(h.address), walletAddress: h.address })

  rule(`prove-settle  \u00b7  ${amt(amount)}`)
  console.log(yes
    ? '  \u26a0  WRITE COMMAND. Submits a real send and then watches the settle resolve.'
    : '  Add --yes to run it. This one has to submit a transaction \u2014 the whole point is the window\n' +
      '  between a spend leaving and its change arriving, and that window only exists for real.')

  // ── The no-change case needs no transaction at all ──
  rule('exact cover / no output for us  (pure, nothing submitted)')
  const noChange: PendingSettle = {
    txId: 'exact-cover', kind: 'send', expectOutputs: [],
    watches: [{ side: 'private', direction: 'fall', before: 800n }],
    deadlineAt: Date.now() + 150_000, status: 'settling', delta: null,
  }
  const noChangeEvidence: SettleEvidence = {
    balances: { private: 800n, public: null }, ownedIds: new Set(), scanComplete: true,
  }
  const settledAtOnce = advanceSettle(noChange, noChangeEvidence, Date.now()).status === 'settled'
  console.log(`  ${settledAtOnce ? 'PASS' : '\u25c0 FAIL'}  expectOutputs: [] settles immediately` +
              `   (balance has not even moved: ${settledAtOnce ? 'settled' : 'still settling'})`)
  if (!settledAtOnce) process.exitCode = 1
  console.log('        \u2014 a positive claim of "this creates nothing for me", not a hole. An exact-cover\n' +
              '          spend and a public send both record it, and neither has anything to wait for.')

  if (!yes) return

  const before = await scan()
  rule('submit')
  field('balance before', amt(before.balance))
  const result = await sendConfidential(h.wallet, h.address, {
    recipient: dest, amountMicrotari: amount, onProgress: stage,
  })
  field('tx', result.txId)
  field('outcome', result.outcome)
  field('spent inputs', JSON.stringify(result.spentInputIds))
  field('expect outputs', result.selfOutputIds ? JSON.stringify(result.selfOutputIds) : 'null (statement unreadable)')

  // ── JOURNAL IT, AS THE WALLET DOES ────────────────────────────────────────
  //
  // WalletModal writes this on every send, and crypto/ownedFeed's by-id recovery reads it: the
  // journal is where the wallet remembers the name of the output it just created for itself. The
  // harness calls the crypto modules directly and so has no UI to do it, which without this line
  // leaves the recovery with nothing to ask for — and the settle then waits out its deadline for
  // a change output the listings happen not to carry. That is the harness under-emulating the
  // app, not the app failing, and it is worth one line to keep the two honest with each other.
  beginEntry(h.address, {
    kind: 'send', amountMicrotari: amount, feeMicrotari: result.feeMicrotari ?? null,
    from: 'private', to: 'external', counterparty: { kind: 'address', value: dest },
    note: 'harness: prove-settle', source: 'local-journal',
    selfOutputIds: result.selfOutputIds ?? null, spentInputIds: result.spentInputIds,
  })
  if (result.outcome !== 'Commit') {
    console.log('\n  The send did not commit, so there is no settle to watch.')
    return
  }

  // Built exactly as WalletModal builds it, so what is watched here is what ships.
  let entry: PendingSettle = {
    txId: result.txId,
    kind: 'send',
    expectOutputs: result.selfOutputIds ?? null,
    watches: [{ side: 'private', direction: 'fall', before: before.balance }],
    deadlineAt: Date.now() + 150_000,
    status: 'settling',
    delta: null,
  }

  rule('the settle, tick by tick')
  console.log('   tick   balance            change here?   direction(old)   evidence(new)')
  let disagreed = 0
  let recoveredBy: string | null = null
  for (let tick = 1; entry.status === 'settling' && tick <= 25; tick++) {
    const s = await scan()
    const evidence: SettleEvidence = {
      balances: { private: s.balance, public: null },
      ownedIds: new Set(s.utxos.map(u => u.id)),
      scanComplete: !s.incomplete,
    }
    const changeHere = (result.selfOutputIds ?? []).every(id => evidence.ownedIds.has(id))
    if (changeHere && recoveredBy === null) {
      recoveredBy = s.recoveries.some(r => r.found && (result.selfOutputIds ?? []).includes(r.substateId))
        ? 'by-id recovery (no listing had it)'
        : 'the listing union'
    }
    // What the OLD test would have said, computed with the same primitive the old code used.
    const oldSays = settleAction(s.balance, before.balance, Date.now(), entry.deadlineAt, 'fall')
    const next = advanceSettle(entry, evidence, Date.now())
    if (oldSays === 'settled' && next.status === 'settling') disagreed++
    console.log(
      `   ${String(tick).padStart(4)}   ${describeMicrotari(s.balance).padStart(14)}   ` +
      `${(changeHere ? 'yes' : 'no').padEnd(12)}   ${oldSays.padEnd(14)}   ${next.status}`,
    )
    entry = next
    if (entry.status === 'settling') await new Promise<void>(r => setTimeout(r, 8_000))
  }

  rule('verdict')
  const after = await scan()
  field('final status', entry.status)
  field('change found via', recoveredBy ?? '(never found)')
  field('balance after', amt(after.balance))
  // Signed, and printed by hand: describeMicrotari formats a whole part and a padded fraction, so
  // a negative microtari renders as "0.-200000". The app never asks it for one; this does.
  const delta = after.balance - before.balance
  field('balance delta', `${delta < 0n ? '-' : '+'}${describeMicrotari(delta < 0n ? -delta : delta)} tTARI`)
  if (entry.status === 'lagged' && entry.expectOutputs && entry.expectOutputs.length > 0) {
    console.log('\n  \u25b6 LAGGED: the change output never appeared in /utxos within the deadline. That is the\n' +
                '    designed honest ending, and worth checking against the chain directly — a change that\n' +
                '    EXISTS as a substate but is missing from the listing is the indexer gap, not this test:\n' +
                `    curl .../substates/${entry.expectOutputs[0]}`)
  }
  if (disagreed > 0) {
    console.log(`\n  \u25b6 THE TWO TESTS DISAGREED ON ${disagreed} TICK(S). On each of those the old direction test\n` +
                '    would have declared this send done \u2014 ending the settle, tearing down the rescan poll\n' +
                '    (WalletContext: `if (!isSettling) return`) and certifying a balance still missing its\n' +
                '    change. The evidence test kept waiting until the change was actually on chain.')
  } else if (recoveredBy?.startsWith('by-id')) {
    console.log('\n  \u25b6 SETTLED ON THE FIRST LOOK, VIA BY-ID RECOVERY. No listing carried this change output —\n' +
                '    the wallet asked for it by the name it recorded before submitting (crypto/ownedFeed).\n' +
                '    Before that recovery existed this same command ran 18 ticks and ended LAGGED, waiting\n' +
                '    for a coin the listings were never going to return.')
  } else {
    console.log('\n  The two tests agreed throughout: the listings already carried the change by the first\n' +
                '  tick, so this send never entered the window either fix is for.')
  }
  if (entry.status !== 'settled') process.exitCode = 1
}

/**
 * READ-ONLY. What each indexer holds, what the union recovers, and what neither has.
 *
 * ── THE MEASUREMENT THIS COMMAND EXISTS TO KEEP HONEST ──────────────────────
 *
 * The two public nodes disagree about which outputs are unspent, and the disagreement is
 * SYMMETRIC — each holds live coins the other omits. So there is no good node to pick, and a
 * wallet reading one is missing coins it owns. This walks each node separately, then the union,
 * then proves the recovery two ways: a coin the union has that a single node dropped, confirmed
 * live at `/substates`, and the same comparison against THIS WALLET's own owned set.
 *
 * It also checks the harder case, which the union does NOT fix: a coin that is live at
 * `/substates` on every node and absent from every node's listing.
 */
async function cmdIndexers(h: Harnessed | null): Promise<void> {
  rule('indexers  (crypto/indexerConfig \u2192 crypto/utxoFeed)')
  field('configured', INDEXER_URLS.join('\n                    '))

  // Each node alone, then the union — all through the shipping walk, so what is measured is what
  // the wallet actually reads.
  const singles = new Map<string, Set<string>>()
  for (const url of INDEXER_URLS) {
    const mark = net.length
    try {
      const feed = await fetchAllUtxoRows({ indexerUrls: [url] })
      singles.set(url, new Set(feed.rows.map(r => r[0])))
      field(url.replace(/^https:\/\//, ''), `${feed.rows.length} rows over ${feed.pages} page(s)${feed.incomplete ? '  \u25c0 INCOMPLETE' : ''}`)
    } catch (e) {
      field(url.replace(/^https:\/\//, ''), `FAILED \u2014 ${e instanceof Error ? e.message : String(e)}`)
    }
    void mark
  }

  const union = await fetchAllUtxoRows({})
  const unionIds = new Set(union.rows.map(r => r[0]))
  rule('the union')
  field('union rows', `${union.rows.length}`)
  field('incomplete', String(union.incomplete))
  for (const src of union.sources) {
    field(src.url.replace(/^https:\/\//, ''), `${src.rows} rows, ${src.pages} page(s), ${src.ok ? 'ok' : `FAILED: ${src.error}`}`)
  }

  // What each node was missing, and a live example of it.
  rule('what a single node would have missed')
  for (const [url, ids] of singles) {
    const missed = [...unionIds].filter(id => !ids.has(id))
    field(url.replace(/^https:\/\//, ''), `${missed.length} coin(s) in the union that this node did not list`)
    // ── IS THE UNION SAFE? CLASSIFY WHAT IT ACTUALLY RECOVERED ──────────────
    //
    // A row present on one node and absent from another is one of two things, and they pull in
    // opposite directions:
    //
    //   LIVE at /substates   a real unspent coin the other node omitted. This is the recovery the
    //                        union exists for.
    //   not found            a STALE row: the coin was spent, the other node has dropped it, and
    //                        this one has not caught up. The union carries it along.
    //
    // A stale row is harmless by construction — it only matters if it is OURS, and our own spends
    // are excluded by crypto/spentOutputs, while a genuinely down input is refused by the chain at
    // submission. But the ratio is worth seeing rather than assuming.
    let live = 0, stale = 0
    const sampled = missed.slice(0, 12)
    for (const id of sampled) {
      const probe = await pointRead(`/substates/utxo_${RESOURCE_HEX}_${id}`)
      if (probe.answered && probe.body !== null) live++; else stale++
    }
    if (sampled.length > 0) {
      console.log(`      of ${sampled.length} sampled: ${live} LIVE (a real coin this node omitted), ` +
                  `${stale} stale (spent, and this node has not dropped it yet)`)
      const example = missed[0]!
      console.log(`      e.g. ${example}`)
    }
  }

  if (!h) return

  // ── And the only comparison that actually matters: this wallet's own coins ──
  rule('this wallet, read each way')
  const sig = new AbortController().signal
  const excluded = loadExcludedIds(h.address)
  const unionScan = await scanWallet(h.viewSecret, () => {}, sig, { excluded, walletAddress: h.address })
  field('union', `${unionScan.utxos.length} owned \u2014 ${amt(unionScan.balance)}`)

  for (const url of INDEXER_URLS) {
    // The same decrypt, over one node's listing only. This is what the wallet used to do.
    const feed = await fetchAllUtxoRows({ indexerUrls: [url] })
    const ids = new Set(feed.rows.map(r => r[0]))
    const seen = unionScan.utxos.filter(u => ids.has(u.commitment))
    const missedValue = unionScan.utxos.filter(u => !ids.has(u.commitment)).reduce((t, u) => t + u.amount, 0n)
    field(url.replace(/^https:\/\//, ''), `${seen.length} owned \u2014 ${amt(seen.reduce((t, u) => t + u.amount, 0n))}` +
      (missedValue > 0n ? `\n                    \u25c0 ${amt(missedValue)} of OUR coins invisible reading this node alone` : ''))
  }
}

/**
 * READ-ONLY. Proof that a coin no listing returns is still found, counted and spendable.
 *
 * ── THE CASE THE UNION COULD NOT REACH ──────────────────────────────────────
 *
 * Stage 2 read both indexers and unioned them, which recovered every coin one node had dropped.
 * It could not recover a coin NEITHER node lists — and that exists: a change output answering
 * HTTP 200 at `/substates/<id>` on both nodes while absent from both fully-paginated listings.
 *
 * The wallet knows its own outputs by name (crypto/outputIds writes them onto the journal entry
 * before the transaction is even submitted), so it can ask for that one directly. This runs the
 * SHIPPING scan twice over the same chain state — once with recovery off, once on — and compares.
 *
 * Pass a substate id to prove it against a specific coin. The entry that names it is written with
 * the same `beginEntry` the wallet uses, because the recovery reads the journal and this command
 * is standing in for the UI that would have written it.
 */
async function cmdProveRecovery(h: Harnessed, targetId?: string): Promise<void> {
  const sig = new AbortController().signal
  const excluded = loadExcludedIds(h.address)
  let failures = 0
  const check = (label: string, ok: boolean, detail: string) => {
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : '\u25c0 FAIL'}  ${label.padEnd(52)} ${detail}`)
  }

  rule('prove-recovery  \u00b7  READ-ONLY, nothing is submitted')

  if (targetId) {
    // Exactly what WalletModal does when a send commits: record what the transaction created for
    // us. Without this the recovery has no name to ask for — it never guesses at ids.
    beginEntry(h.address, {
      kind: 'send', amountMicrotari: null, feeMicrotari: null,
      from: 'private', to: 'external', counterparty: null,
      note: 'harness: prove-recovery', source: 'local-journal',
      selfOutputIds: [targetId], spentInputIds: null,
    })
    field('recorded', `${targetId}\n                    (journalled as a self-output, as the wallet does on every send)`)
  }

  // What the journal has to work with, and how much of it the listings already cover.
  const listingOnly = await fetchOwnedRows({ indexerUrls: INDEXER_URLS })
  const present = new Set(listingOnly.rows.map(r => r[0]))
  const recorded = new Set(loadJournal(h.address).flatMap(e => e.selfOutputIds ?? []))
  const candidates = recoveryCandidates(h.address, present)
  rule('cost')
  field('listing union', `${listingOnly.rows.length} rows`)
  field('recorded self-outputs', `${recorded.size}`)
  field('already listed', `${recorded.size - candidates.length} \u2014 these cost NOTHING, they are filtered out before any request`)
  field('asked for by id', `${candidates.length} point read(s) this scan`)

  // ── The same scan, twice, over the same chain ──
  rule('the same scan, recovery off then on')
  const off = await scanWallet(h.viewSecret, () => {}, sig, { excluded })
  const on = await scanWallet(h.viewSecret, () => {}, sig, { excluded, walletAddress: h.address })
  field('listings only', `${off.utxos.length} owned \u2014 ${amt(off.balance)}`)
  field('with recovery', `${on.utxos.length} owned \u2014 ${amt(on.balance)}`)
  for (const r of on.recoveries) {
    console.log(`      ${r.found ? 'FOUND' : 'not on chain'}  ${r.substateId}`)
  }

  if (targetId) {
    const commitment = targetId.slice(targetId.lastIndexOf('_') + 1)
    const probe = await pointRead(`/substates/${encodeURIComponent(targetId)}`)
    check('the chain has it', probe.answered && probe.body !== null, probe.body !== null ? 'HTTP 200, live' : 'not found')

    // THE PREMISE, CHECKED RATHER THAN ASSUMED. The recovery only does anything for a coin the
    // listings have lost, and the listings catch up eventually — so a target picked minutes ago
    // may already be back. That is the indexer being fine, not this code being wrong, and saying
    // "FAIL" about it would be the harness lying in the other direction.
    if (present.has(commitment)) {
      console.log('\n  \u25b6 PREMISE GONE: the listings now carry this coin, so there is nothing to recover from\n' +
                  '    them. Run this immediately after a send, while the change output is still missing:\n' +
                  '      node scripts/harness.mjs send <addr> <amt> --yes      # note its self output\n' +
                  '      node scripts/harness.mjs prove-recovery <that id>')
      return
    }
    check('no listing has it', !present.has(commitment), `${listingOnly.rows.length} union rows, absent`)
    check('listings-only scan cannot see it', !off.utxos.some(u => u.commitment === commitment), `${off.utxos.length} owned`)
    check('by-id recovery finds it', on.utxos.some(u => u.commitment === commitment), `${on.utxos.length} owned`)
    check('and it is counted in the balance', on.balance > off.balance, `${amt(on.balance - off.balance)} recovered`)

    // ── It must not come back once we have spent it ──
    const PROOF_TX = 'harness-recovery-spent-check'
    try {
      markLocked(h.address, [targetId], PROOF_TX)
      const afterSpend = recoveryCandidates(h.address, present)
      check('a spent coin is never asked for again', !afterSpend.includes(targetId),
        `${afterSpend.length} candidate(s) left`)
      const spentScan = await scanWallet(h.viewSecret, () => {}, sig,
        { excluded: loadExcludedIds(h.address), walletAddress: h.address })
      check('and never re-enters the balance', !spentScan.utxos.some(u => u.commitment === commitment),
        `${amt(spentScan.balance)}`)
    } finally {
      release(h.address, PROOF_TX)
    }
  }

  // ── Selection must see exactly what the balance sees ──
  const crypto = new WasmStealthCrypto(Network.Esmeralda)
  const spendable = await scanOwnedUtxos(crypto, h.viewSecret, { excluded, walletAddress: h.address })
  check('selection sees the same set as the balance',
    spendable.length === on.utxos.length,
    `${spendable.length} selectable vs ${on.utxos.length} owned`)

  rule(failures === 0 ? 'PROVEN \u2014 a coin no listing returns is still found, counted and spendable' : `${failures} CHECK(S) FAILED`)
  if (failures > 0) process.exitCode = 1
}

// ── Entry point ──────────────────────────────────────────────────────────────

const USAGE = `
CARAVEL TERMINAL HARNESS — the real crypto/tx paths against the live Esmeralda indexer.

  read -rs CARAVEL_TEST_MNEMONIC && export CARAVEL_TEST_MNEMONIC
  node scripts/harness.mjs <command> [args] [--yes] [--raw]

READ-ONLY — safe to run freely, costs nothing:
  scan                        Full balance trace: rows, pages, owned, spendable, private + public.
  resolve <txid>              Fetch and print one transaction result in full, with its verdict.
  prove-recovery [substateId] Proof that a coin absent from every listing is still found by id,
                              counted, and spendable. Submits nothing.
  indexers                    What each indexer holds, what the union recovers, and how much of
                              THIS wallet is invisible reading a single node.
  spent                       Show the local spend record (crypto/spentOutputs).
  resolve-locks               Resolve every lock this wallet holds against the chain's verdict —
                              the repair for a balance understated by a timed-out transaction.
  prove-sweep [rejectedTxid]  Proof that a lock is temporary: promote on Accept, release on Reject,
                              KEEP on a tx the chain never saw. Submits nothing.
  prove-settle <addr> <amount>
                              WRITE. Submits a real send, then prints the settle tick by tick with
                              the OLD direction test beside the NEW evidence test, so the window
                              where they disagree is visible. The no-change case runs without --yes.
  prove-spend                 End-to-end proof, against the live indexer, that a spent coin leaves
                              BOTH the balance and coin selection. Submits nothing, spends nothing,
                              and releases what it locked.

WRITE — MOVES REAL TESTNET FUNDS. Builds and prices without --yes; submits with it:
  faucet                      Claim testnet funds (once per wallet, ever) — the way to get a
                              wallet into a state prove-spend can work against.
  make-private <amount>       conceal: revealed vault  →  private stealth output.
  make-public  <amount>       reveal:  private outputs →  revealed vault balance.
  send <ootle-address> <amount> [memo]
                              confidentialSend. Requires --yes (no dry-run seam — see the source).

Amounts are TARI ("12.5") or raw µtTARI ("12500000u").

Environment:
  CARAVEL_TEST_MNEMONIC   required. The wallet. Never printed, never written to disk.
  CARAVEL_TEST_SCHEME     'cipherseed' | 'bip39'. Only needed for a phrase valid under both.
  CARAVEL_TEST_ACCOUNT    skip the account probe and use this component address.
  CARAVEL_HARNESS_BLOCK_SSE  set to anything to make every /events request fail, so the REST
                          fallback in crypto/finality can be proved against a real transaction.
  CARAVEL_HARNESS_STATE   file to keep the harness's localStorage in, so the spend record survives
                          between commands (a real send, then a scan). Holds only sealed stores —
                          never the mnemonic. Omit for in-memory, per-process state.
  CARAVEL_INDEXER_URL     talk to a different indexer (bare origin, no path). Rewrites requests in
                          the harness's fetch wrapper only — src/ still hardcodes indexer-a.
                          Known live alternate: https://ootle-indexer-b.tari.com
`

export async function main(argv: string[]): Promise<void> {
  const yes = argv.includes('--yes')
  const raw = argv.includes('--raw')
  const args = argv.filter(a => a !== '--yes' && a !== '--raw')
  const cmd = args[0]

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return }

  console.log(`\n  indexer : ${INDEXER}${INDEXER_OVERRIDE ? '   ◀ CARAVEL_INDEXER_URL override (src/ still hardcodes ' + CANONICAL_INDEXER + ')' : '   (the hardcoded default)'}`)
  console.log(`  network : Esmeralda (${Network.Esmeralda})`)
  console.log(`  time    : ${new Date().toISOString()}`)

  // WHICH NODE ANSWERED, AND FROM WHERE IN THE CHAIN. Two indexers at the same height can serve
  // different /utxos sets — measured: 886 rows on -a against 964 on -b at an identical block hash
  // — so an A/B run has to record the peer it actually reached and the height it read at, or the
  // two outputs cannot honestly be compared. Non-fatal: a node that will not answer this is still
  // worth pointing a scan at, and the scan's own failure will say so far better.
  try {
    const [idRes, epochRes] = await Promise.all([
      fetch(`${INDEXER}/identity`),
      fetch(`${INDEXER}/epoch-manager/stats`),
    ])
    const id = await idRes.json() as { peer_id?: string }
    const ep = await epochRes.json() as { current_epoch?: number; current_block_height?: number; current_block_hash?: string }
    console.log(`  peer    : ${id.peer_id ?? '(unknown)'}`)
    console.log(`  chain   : epoch ${ep.current_epoch ?? '?'}, height ${ep.current_block_height ?? '?'}, block ${(ep.current_block_hash ?? '').slice(0, 16)}…`)
  } catch (e) {
    console.log(`  peer    : (could not read /identity — ${e instanceof Error ? e.message : String(e)})`)
  }

  try {
    if (cmd === 'resolve') {
      const txId = args[1]
      if (!txId) throw new Error('resolve needs a transaction id.')
      await cmdResolve(txId)
      return
    }

    const h = await identity()

    switch (cmd) {
      case 'scan':
        await cmdScan(h)
        break
      case 'spent':
        await cmdSpent(h)
        break
      case 'prove-spend':
        await cmdProveSpend(h)
        break
      case 'prove-recovery':
        await cmdProveRecovery(h, args[1])
        break
      case 'indexers':
        await cmdIndexers(h)
        break
      case 'resolve-locks':
        await cmdResolveLocks(h)
        break
      case 'prove-sweep':
        await cmdProveSweep(h, args[1])
        break
      case 'prove-settle':
        if (!args[1] || !args[2]) throw new Error('prove-settle needs a recipient address and an amount.')
        await cmdProveSettle(h, args[1], parseAmount(args[2]), yes)
        break
      case 'faucet':
        await cmdFaucet(h, yes)
        break
      case 'make-private':
        if (!args[1]) throw new Error('make-private needs an amount.')
        await cmdMakePrivate(h, parseAmount(args[1]), yes)
        break
      case 'make-public':
        if (!args[1]) throw new Error('make-public needs an amount.')
        await cmdMakePublic(h, parseAmount(args[1]), yes)
        break
      case 'send':
        if (!args[1] || !args[2]) throw new Error('send needs a recipient address and an amount.')
        await cmdSend(h, args[1], parseAmount(args[2]), yes, args[3])
        break
      default:
        throw new Error(`Unknown command "${cmd}".\n${USAGE}`)
    }
  } catch (e) {
    // NOTHING IS SWALLOWED. The module's own message first — those are written to be read — then
    // the stack, then every network call made before it failed, because the request that went
    // wrong is usually the last one in that list.
    rule('FAILED')
    console.error(`  ${e instanceof Error ? e.message : String(e)}\n`)
    if (e instanceof Error && e.stack) console.error(indent(e.stack, '  '))
    if (e instanceof Error && e.cause) console.error(`\n  cause: ${String(e.cause)}`)

    // THE MOST USEFUL THING ON A REJECTION, and the command's own printDryRun never reached it:
    // when the network refuses a simulation, prepareX throws from inside dryRunFee, so the caller
    // is skipped. Print the last dry run from the recording instead — the instructions that were
    // refused, and the engine's verbatim answer.
    const probe = lastCall('/transactions/dry-run')
    if (probe) {
      rule('the dry run that was refused')
      printInstructions(lastBuild(true))
      console.log('\n  response:')
      console.log(indent(pretty(probe.resBody ?? ''), '    '))
    }

    rule('every network call this run')
    printNet(0, { full: raw })
    process.exitCode = 1
    return
  }

  if (raw) { rule('every network call this run'); printNet(0, { full: true }) }
  console.log()
}
