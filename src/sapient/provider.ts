// Sapient — the Tari browser wallet (Chrome extension) — as Caravel talks to it. NO REACT HERE.
//
// Sapient injects `window.tari` (MetaMask-style) and announces itself with a `tari#initialized`
// window event. Everything goes through `window.tari.request({ method, params })`; the wallet holds
// every key, and Caravel never sees one. See ~/dev/research/sapient/FINDINGS.md and the working spike
// (~/dev/research/sapient-spike) for what each call does and returns; the method names below are the
// ones Sapient's background actually serves (tari-wallet src/background/index.ts).
//
// This module is deliberately small and typed: detection, a request wrapper that turns Sapient's
// error codes into something a screen can act on, the handful of calls the connection needs, and an
// event subscription. Payments (step 4) build on `sapientRequest` rather than re-detecting.

export type SapientNetwork = 'mainnet' | 'esmeralda' | 'igor'

/** The injected provider, as much of it as Caravel relies on. */
export interface TariProvider {
  isTariWallet?: boolean
  info?: { name?: string; rdns?: string; embedded?: boolean }
  /**
   * Set only by tari-connector.js (public/vendor/tari): "embedded" inside Tari Universe,
   * "walletconnect" for Sapient for Android, null when it can reach no wallet. The Sapient
   * extension's own provider has no `transport` at all, which is how the two are told apart.
   */
  transport?: string | null
  /** tari-connector.js: true when its calls can reach a wallet. */
  isAvailable?: boolean
  request(args: { method: string; params?: unknown }): Promise<unknown>
  /** Subscribe; Sapient returns an unsubscribe function. */
  on?(event: 'accountsChanged' | 'networkChanged' | 'disconnect', handler: (payload: never) => void): (() => void) | void
}

declare global {
  interface Window {
    /** Injected by Sapient (or another Tari wallet) at document_start. */
    tari?: TariProvider
    /** tari-connector.js's own provider, always present once it has loaded. */
    tariUniverse?: TariProvider
  }
}

/** What detection looks at: a window, or a test's stand-in for one. */
export interface ProviderHost extends EventTarget {
  tari?: TariProvider
  tariUniverse?: TariProvider
}

// ── The three ways to reach a wallet ─────────────────────────────────────────
//
//   extension  the Sapient browser extension's `window.tari` (no `transport`): today's path
//   phone      Sapient for Android over WalletConnect: tari-connector.js's provider with
//              transport "walletconnect" (public/wc-config.js opts in). Reachable even when the
//              extension is installed, through `window.tariUniverse`.
//   embedded   inside the Tari Universe web wallet: the connector's provider, transport "embedded"
//
// tari-connector.js never displaces an installed extension's `window.tari`; inside Universe the
// embedding wallet takes it. A connector that can reach nothing (transport null) is not a wallet.

export type Transport = 'extension' | 'phone' | 'embedded'

export interface WalletProviders {
  extension: TariProvider | null
  phone: TariProvider | null
  embedded: TariProvider | null
}

export function findProviders(host: ProviderHost): WalletProviders {
  const t = host.tari
  const u = host.tariUniverse
  const embedded = t?.transport === 'embedded' ? t : u?.transport === 'embedded' ? u : null
  const extension = t && t.transport === undefined ? t : null
  const phone = u?.transport === 'walletconnect' && u.isAvailable !== false ? u
    : t?.transport === 'walletconnect' && t.isAvailable !== false ? t : null
  return { extension, phone, embedded }
}

export const anyProvider = (w: WalletProviders) => !!(w.extension || w.phone || w.embedded)

/**
 * The providers, once something is there: at once when the extension injected at document_start or
 * the connector already ran (it loads before the app), else the first `tari#initialized` within
 * `timeoutMs`, else whatever is present then (possibly nothing).
 */
export function detectProviders(host: ProviderHost, timeoutMs = DETECT_TIMEOUT_MS): Promise<WalletProviders> {
  // Done once the connector has announced itself (window.tariUniverse): only then is the phone
  // option known. An extension alone is not enough to stop waiting, or the phone would go missing
  // whenever the app ran before the connector.
  if (host.tariUniverse) return Promise.resolve(findProviders(host))
  return new Promise(resolve => {
    const onInit = () => { clearTimeout(timer); resolve(findProviders(host)) }
    const timer = setTimeout(() => {
      host.removeEventListener('tari#initialized', onInit)
      resolve(findProviders(host))
    }, timeoutMs)
    host.addEventListener('tari#initialized', onInit, { once: true })
  })
}

// ── Phone calls: never wait forever ──────────────────────────────────────────
//
// Over WalletConnect every call except tari_getAccounts / tari_getNetwork (answered from the
// session) is a round trip to the phone, which may be asleep or have Sapient closed. Each call
// gets a limit; past it the caller sees an `unreachable` error and can say so plainly. Calls that
// wait for the person to approve on the phone get longer.

const PHONE_SLOW_MS = 180_000   // approvals: connect, view access, submit (which also waits for the chain)
const PHONE_CLAIM_MS = 90_000   // claims and output reads touch the chain
const PHONE_DEFAULT_MS = 30_000
const PHONE_SLOW = new Set(['tari_requestAccounts', 'tari_requestViewAccess', 'tari_submitTransactionRequest'])
const PHONE_CLAIM = new Set(['tari_claimPrivatePayment', 'tari_getShieldedOutputs'])

export function phoneTimeoutFor(method: string): number {
  return PHONE_SLOW.has(method) ? PHONE_SLOW_MS : PHONE_CLAIM.has(method) ? PHONE_CLAIM_MS : PHONE_DEFAULT_MS
}

export const PHONE_UNREACHABLE = 'Sapient on your phone didn\u2019t answer. Open Sapient on your phone and try again.'

/** The phone provider, with a time limit on every call. Events pass straight through. */
export function withPhoneTimeouts(p: TariProvider): TariProvider {
  return {
    isTariWallet: p.isTariWallet,
    info: p.info,
    transport: p.transport,
    isAvailable: p.isAvailable,
    request(args) {
      return withTimeout(p.request(args), phoneTimeoutFor(args.method), undefined, 'unreachable', PHONE_UNREACHABLE)
    },
    on: typeof p.on === 'function' ? p.on.bind(p) : undefined,
  }
}

/** Capabilities say what the account can do; unknown (null) means let the wallet answer. */
export function canSendPrivately(caps: Record<string, unknown> | null): boolean {
  return !caps || (caps.transactionRequests !== false && caps.privateSpend !== false && caps.walletAddress !== false)
}
export function canConfirmPayments(caps: Record<string, unknown> | null): boolean {
  return !caps || caps.privateBalanceView !== false
}

/** The Chrome Web Store listing (tari-wallet README). */
export const SAPIENT_INSTALL_URL = 'https://chromewebstore.google.com/detail/tari-ootle-wallet/demkeckolenopkgnfbnpflkpbbdhpgkl'

/** How long to wait for `tari#initialized` before concluding Sapient is not installed. */
export const DETECT_TIMEOUT_MS = 3000

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * The provider, once it is there. Present at once when the extension injected at document_start;
 * otherwise the first `tari#initialized` within `timeoutMs`; otherwise null (not installed, disabled,
 * or this origin is not served — Sapient answers https and http://localhost only).
 */
export function detectSapient(host: ProviderHost, timeoutMs = DETECT_TIMEOUT_MS): Promise<TariProvider | null> {
  if (host.tari) return Promise.resolve(host.tari)
  return new Promise(resolve => {
    const onInit = () => { clearTimeout(timer); resolve(host.tari ?? null) }
    const timer = setTimeout(() => {
      host.removeEventListener('tari#initialized', onInit)
      resolve(host.tari ?? null)
    }, timeoutMs)
    host.addEventListener('tari#initialized', onInit, { once: true })
  })
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * A Sapient failure, by what the screen should do about it:
 *   declined  the person said no in the popup (code 4001)
 *   locked    the wallet is locked (code 4100, or "Wallet is locked.")
 *   wallet    the wallet or the chain refused, with its own reason (-32603 and the rest)
 */
export class SapientError extends Error {
  readonly kind: 'declined' | 'locked' | 'wallet' | 'unreachable'
  readonly code: number | null
  constructor(kind: SapientError['kind'], message: string, code: number | null) {
    super(message)
    this.name = 'SapientError'
    this.kind = kind
    this.code = code
  }
}

export function toSapientError(e: unknown): SapientError {
  if (e instanceof SapientError) return e
  const code = typeof (e as { code?: unknown })?.code === 'number' ? (e as { code: number }).code : null
  const message = e instanceof Error ? e.message : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : String(e)
  if (code === 4001) return new SapientError('declined', message || 'Declined in Sapient.', code)
  if (code === 4100 || /wallet is locked/i.test(message)) return new SapientError('locked', message || 'Sapient is locked.', code)
  return new SapientError('wallet', message || 'Sapient could not complete that.', code)
}

/** One call. Throws SapientError. */
export async function sapientRequest<T = unknown>(p: TariProvider, method: string, params?: unknown): Promise<T> {
  try {
    return (await p.request(params === undefined ? { method } : { method, params })) as T
  } catch (e) {
    throw toSapientError(e)
  }
}

// ── The calls the connection needs ──────────────────────────────────────────

/** Opens Sapient's connect popup unless this site is already connected and the wallet unlocked. */
export async function requestAccounts(p: TariProvider): Promise<string[]> {
  const r = await sapientRequest<unknown>(p, 'tari_requestAccounts')
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []
}

/** Never prompts. `[]` when not connected OR when the wallet is locked. */
export async function getAccounts(p: TariProvider): Promise<string[]> {
  const r = await sapientRequest<unknown>(p, 'tari_getAccounts')
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []
}

/** Needs no connection. */
export async function getNetwork(p: TariProvider): Promise<string> {
  return String(await sapientRequest<unknown>(p, 'tari_getNetwork'))
}

/** The private-payment address (bech32m `otl_…`), not the component address. Needs a connection. */
export async function getWalletAddress(p: TariProvider): Promise<string> {
  return String(await sapientRequest<unknown>(p, 'tari_getWalletAddress'))
}

export async function getCapabilities(p: TariProvider): Promise<Record<string, unknown>> {
  const r = await sapientRequest<unknown>(p, 'tari_getCapabilities')
  return r && typeof r === 'object' ? r as Record<string, unknown> : {}
}

/** Whether this site holds view access. Never prompts. */
export async function getViewAccess(p: TariProvider): Promise<boolean> {
  return (await sapientRequest<{ granted?: unknown } | null>(p, 'tari_getViewAccess'))?.granted === true
}

/** Opens Sapient's view-access popup unless already granted. A refusal is `false`, not a throw. */
export async function requestViewAccess(p: TariProvider): Promise<boolean> {
  return (await sapientRequest<{ granted?: unknown } | null>(p, 'tari_requestViewAccess'))?.granted === true
}

/**
 * Where this site stands with Sapient right now, without a popup.
 *
 * SAPIENT SENDS NO EVENT WHEN IT LOCKS OR UNLOCKS — `popup-lock` and the auto-lock alarm clear the
 * seed and broadcast nothing (tari-wallet background/index.ts) — so the only way to know is to ask.
 * `tari_getAccounts` answers `[]` both when the site is not connected and when the wallet is locked;
 * `tari_getViewAccess` tells them apart, because it checks only the connection (it answers while
 * locked, and throws "Site is not connected" when not).
 */
export type SessionCheck = { s: 'unlocked'; account: string } | { s: 'locked' } | { s: 'disconnected' }

export async function checkSession(p: TariProvider): Promise<SessionCheck> {
  const accounts = await getAccounts(p)
  if (accounts.length > 0) return { s: 'unlocked', account: accounts[0] }
  try {
    await getViewAccess(p)
    return { s: 'locked' }
  } catch {
    return { s: 'disconnected' }
  }
}

/** Reject after `ms` — a wallet call must never hang the caller for good. */
export function withTimeout<T>(
  promise: Promise<T>, ms: number, what = 'Sapient did not answer', kind: SapientError['kind'] = 'wallet', message?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new SapientError(kind, message ?? `${what} in time.`, null)), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/** Forget this site in Sapient. */
export async function disconnectSapient(p: TariProvider): Promise<void> {
  await sapientRequest(p, 'tari_disconnect')
}

// ── Balances ─────────────────────────────────────────────────────────────────

/** Native TARI's resource address — the same on every network (tari-wallet background, and the spike). */
export const TARI_RESOURCE = 'resource_0101010101010101010101010101010101010101010101010101010101010101'

/** A balance in raw units, with the resource's own divisibility. */
export interface RawBalance {
  amount: bigint
  divisibility: number
}

const TARI_DIVISIBILITY = 6

function toRaw(entry: { amount?: unknown; divisibility?: unknown } | undefined): RawBalance {
  const divisibility = typeof entry?.divisibility === 'number' ? entry.divisibility : TARI_DIVISIBILITY
  const s = typeof entry?.amount === 'string' || typeof entry?.amount === 'number' ? String(entry.amount) : '0'
  return { amount: /^\d+$/.test(s) ? BigInt(s) : 0n, divisibility }
}

function findTari(list: unknown): { amount?: unknown; divisibility?: unknown } | undefined {
  return Array.isArray(list) ? list.find(b => (b as { resourceAddress?: unknown })?.resourceAddress === TARI_RESOURCE) : undefined
}

/** Private (shielded) TARI the wallet knows about. NEEDS VIEW ACCESS — throws without it. */
export async function getPrivateTariBalance(p: TariProvider): Promise<RawBalance> {
  return toRaw(findTari(await sapientRequest<unknown>(p, 'tari_getPrivateBalances')))
}

/** Public (revealed) TARI. `amount` in tari_getBalances is always real, with or without view access. */
export async function getPublicTariBalance(p: TariProvider): Promise<RawBalance> {
  return toRaw(findTari(await sapientRequest<unknown>(p, 'tari_getBalances')))
}

/**
 * Raw units → "1,234.5": at most 6 decimals (floored past that), trailing zeros trimmed, thousands
 * grouped. Exact — bigint throughout, never a float.
 */
export function formatBalance({ amount, divisibility }: RawBalance, maxDecimals = 6): string {
  const scale = 10n ** BigInt(divisibility)
  const whole = (amount / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (amount % scale).toString().padStart(divisibility, '0').slice(0, maxDecimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface SapientEvents {
  /** `[]` when the wallet locks, the site is disconnected, or just before a network switch. */
  accountsChanged: (accounts: string[]) => void
  networkChanged: (network: string) => void
  /** The phone (WalletConnect) ended the session. */
  disconnect?: () => void
}

/**
 * Subscribe to both events; returns the unsubscribe. Uses `provider.on` (Sapient returns an
 * unsubscribe), falling back to the `tari#…` window events Sapient also dispatches.
 */
export function subscribeSapient(p: TariProvider, host: ProviderHost, handlers: SapientEvents): () => void {
  const accounts = (a: unknown) => handlers.accountsChanged(Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [])
  const network = (n: unknown) => handlers.networkChanged(String(n))
  if (typeof p.on === 'function') {
    const offs = [
      p.on('accountsChanged', accounts as (payload: never) => void),
      p.on('networkChanged', network as (payload: never) => void),
      ...(handlers.disconnect ? [p.on('disconnect', (() => handlers.disconnect?.()) as (payload: never) => void)] : []),
    ]
    return () => { for (const off of offs) if (typeof off === 'function') off() }
  }
  const onAccounts = (e: Event) => accounts((e as CustomEvent).detail)
  const onNetwork = (e: Event) => network((e as CustomEvent).detail)
  host.addEventListener('tari#accountsChanged', onAccounts)
  host.addEventListener('tari#networkChanged', onNetwork)
  return () => {
    host.removeEventListener('tari#accountsChanged', onAccounts)
    host.removeEventListener('tari#networkChanged', onNetwork)
  }
}

// ── Display helpers ──────────────────────────────────────────────────────────

export function isMainnet(network: string | null): boolean {
  return network === 'mainnet'
}

/** "Mainnet", "Esmeralda", "Igor" — or the raw name for anything newer. */
export function networkLabel(network: string | null): string {
  if (!network) return 'Unknown network'
  return network.charAt(0).toUpperCase() + network.slice(1)
}

/** `otl_esm_1u6fr…863h` — enough to recognise, never enough to pay to. Copy uses the full value. */
export function shortAddress(address: string): string {
  return address.length > 18 ? `${address.slice(0, 12)}…${address.slice(-4)}` : address
}
