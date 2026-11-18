// The Sapient connection, as a pure reducer — every transition testable without a browser or a wallet.
// The async work (asking Sapient things) lives in context/SapientContext; this only decides what the
// answers mean for the screen.
//
//   detecting → missing                                   (no window.tari within the timeout)
//   detecting → disconnected → connecting → connected     (and back to disconnected on any reset)
//
// VIEW ACCESS is separate from the connection, as Sapient keeps it: connecting reveals one public
// component address; view access reveals the confidential position. It is lost on disconnect, an
// account switch and a network switch, so every one of those resets it to `unknown`.

export type SapientStatus = 'detecting' | 'missing' | 'disconnected' | 'connecting' | 'connected'

/** `off` = not granted (declined, or never asked this session). `requesting` = a popup is open. */
export type ViewAccess = 'unknown' | 'off' | 'requesting' | 'granted'

export interface SapientState {
  status: SapientStatus
  /** Sapient's network. Readable without a connection, so known even while disconnected. */
  network: string | null
  /** The connected account's on-chain component (`component_…`). */
  componentAddress: string | null
  /** The private-payment address (`otl_…`) — what is shown, and what payments go to. */
  walletAddress: string | null
  capabilities: Record<string, unknown> | null
  viewAccess: ViewAccess
  /** The last connect failure, for the pill to say why. Cleared by the next attempt. */
  error: string | null
}

export const SAPIENT_INITIAL: SapientState = {
  status: 'detecting', network: null, componentAddress: null, walletAddress: null,
  capabilities: null, viewAccess: 'unknown', error: null,
}

export type SapientAction =
  | { type: 'detected'; present: boolean }
  | { type: 'network'; network: string }
  | { type: 'connect-start' }
  | { type: 'connect-failed'; error: string }
  | { type: 'connected'; componentAddress: string; walletAddress: string; capabilities: Record<string, unknown> | null }
  | { type: 'view'; viewAccess: ViewAccess }
  /** Sapient's accountsChanged. `[]` ends the session; a different account is a switch. */
  | { type: 'accounts-changed'; accounts: string[] }
  | { type: 'disconnected' }

const DISCONNECTED = (s: SapientState): SapientState => ({
  ...s, status: 'disconnected', componentAddress: null, walletAddress: null, capabilities: null, viewAccess: 'unknown',
})

export function sapientReducer(s: SapientState, a: SapientAction): SapientState {
  switch (a.type) {
    case 'detected':
      return { ...s, status: a.present ? 'disconnected' : 'missing' }
    case 'network':
      return { ...s, network: a.network }
    case 'connect-start':
      return { ...s, status: 'connecting', error: null }
    case 'connect-failed':
      return { ...DISCONNECTED(s), error: a.error }
    case 'connected':
      return {
        ...s, status: 'connected', componentAddress: a.componentAddress, walletAddress: a.walletAddress,
        capabilities: a.capabilities, error: null,
        // A fresh connection (or a switched account) starts without a known grant.
        viewAccess: s.componentAddress === a.componentAddress ? s.viewAccess : 'unknown',
      }
    case 'view':
      return s.status === 'connected' || s.status === 'connecting' ? { ...s, viewAccess: a.viewAccess } : s
    case 'accounts-changed':
      if (a.accounts.length === 0) return s.status === 'connected' || s.status === 'connecting' ? DISCONNECTED(s) : s
      // Same account: nothing changed. A different one is a switch — the address is re-read by the
      // context, and the grant does not carry over.
      if (s.status === 'connected' && a.accounts[0] !== s.componentAddress) {
        return { ...s, walletAddress: null, componentAddress: a.accounts[0], viewAccess: 'unknown' }
      }
      return s
    case 'disconnected':
      return s.status === 'missing' || s.status === 'detecting' ? s : DISCONNECTED(s)
  }
}
