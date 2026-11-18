// THE SAPIENT CONNECTION — detection, connect/disconnect, view access, and Sapient's own events.
//
// Independent of the chat and wallet contexts: Chat works with no wallet connected at all, and the
// payments step builds on this (`provider` + `sapientRequest`) rather than re-detecting. Caravel
// stores NO wallet state of its own — Sapient remembers which sites are connected, so a reload asks it
// (tari_getAccounts, which never prompts) instead of keeping anything in localStorage.
//
// ── WHEN A POPUP MAY OPEN ───────────────────────────────────────────────────
//
// Only in answer to something the person did: pressing Connect (connect popup, then view access),
// pressing Grant, or switching account inside Sapient (view access again, since a switch drops it).
// A quiet restore on page load and a network switch never open one — they show "View access: off"
// with a Grant button instead.
//
// ── LOCKED: ASKED, NEVER TOLD ───────────────────────────────────────────────
//
// Sapient broadcasts nothing when it locks or unlocks (manual lock and auto-lock alike), so the pill
// used to stay "connected" over a locked wallet, and every claim quietly failed. The session is now
// CHECKED (provider.checkSession, no popup): every few seconds while a connection exists or might,
// whenever the page regains focus, on demand (`refresh`, the cards' Retry), and at once when any
// call reports "Wallet is locked." (`reportLocked`). Unlocking is noticed the same way, and everything
// waiting on it resumes.
//
// ── STALE ANSWERS ────────────────────────────────────────────────────────────
//
// Every reset (disconnect, accounts → [], a switch, a new connect) bumps `genRef`, and async work
// started under an older generation drops its result. A popup can sit open for minutes; its answer
// must not land on a session that has since ended.

import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  SapientError, checkSession, detectSapient, disconnectSapient, getCapabilities, getNetwork, getViewAccess, getWalletAddress,
  requestAccounts, requestViewAccess, subscribeSapient, toSapientError, type TariProvider,
} from '../sapient/provider'
import { SAPIENT_INITIAL, sapientReducer, type SapientState } from '../sapient/sapientState'

export interface SapientCtx extends SapientState {
  /** The injected provider, once detected — for the payments step. Null while detecting or missing. */
  provider: TariProvider | null
  /** Connect (Sapient's popup), then ask for view access. Never throws; failures land in `error`. */
  connect: () => Promise<void>
  /** Forget this site in Sapient and reset. */
  disconnect: () => Promise<void>
  /** Ask for view access (Sapient's popup). For the Grant button. */
  grantViewAccess: () => Promise<void>
  /** Re-check the session now (locked? unlocked? still connected?) — no popup. */
  refresh: () => Promise<void>
  /** A call just answered "Wallet is locked.": show it at once, and keep checking for the unlock. */
  reportLocked: () => void
}

const Ctx = createContext<SapientCtx | null>(null)

export function useSapient(): SapientCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSapient must be used inside SapientProvider')
  return ctx
}

/** How often the session is re-checked while a connection exists or might (Sapient sends no lock events). */
const SESSION_CHECK_MS = 5000

function connectError(e: unknown): string {
  const err = toSapientError(e)
  if (err.kind === 'declined') return 'Connection declined in Sapient.'
  if (err.kind === 'locked') return 'Sapient is locked. Unlock it and try again.'
  return err.message
}

export function SapientProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sapientReducer, SAPIENT_INITIAL)
  const [provider, setProvider] = useState<TariProvider | null>(null)
  const providerRef = useRef<TariProvider | null>(null)
  const genRef = useRef(0)
  // The latest state, for the event handlers (registered once, so their closure would be stale).
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  const refreshNetwork = useCallback(async (p: TariProvider) => {
    try { dispatch({ type: 'network', network: await getNetwork(p) }) } catch { /* keep the last known */ }
  }, [])

  /** Read the account's address and capabilities; true when it is still this generation's. */
  const loadAccount = useCallback(async (p: TariProvider, componentAddress: string, gen: number): Promise<boolean> => {
    const [walletAddress, capabilities] = await Promise.all([
      getWalletAddress(p),
      getCapabilities(p).catch(() => null),
    ])
    if (gen !== genRef.current) return false
    dispatch({ type: 'connected', componentAddress, walletAddress, capabilities })
    return true
  }, [])

  /** Check the grant; open the popup only when `prompt` (a user action led here). Never throws. */
  const ensureView = useCallback(async (p: TariProvider, gen: number, prompt: boolean) => {
    try {
      if (await getViewAccess(p)) {
        if (gen === genRef.current) dispatch({ type: 'view', viewAccess: 'granted' })
        return
      }
      if (!prompt) {
        if (gen === genRef.current) dispatch({ type: 'view', viewAccess: 'off' })
        return
      }
      dispatch({ type: 'view', viewAccess: 'requesting' })
      const granted = await requestViewAccess(p)
      if (gen === genRef.current) dispatch({ type: 'view', viewAccess: granted ? 'granted' : 'off' })
    } catch {
      if (gen === genRef.current) dispatch({ type: 'view', viewAccess: 'off' })
    }
  }, [])

  // Detection, events, and the quiet restore — once.
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    void detectSapient(window).then(async p => {
      if (cancelled) return
      providerRef.current = p
      setProvider(p)
      dispatch({ type: 'detected', present: p !== null })
      if (!p) return

      unsubscribe = subscribeSapient(p, window, {
        accountsChanged: accounts => {
          const prev = stateRef.current
          if (accounts.length === 0) {
            // Locked, disconnected from Sapient's side, or about to switch network.
            genRef.current++
            dispatch({ type: 'accounts-changed', accounts })
            return
          }
          if (prev.status === 'connected' && accounts[0] !== prev.componentAddress) {
            // An account switch inside Sapient: re-read, and ask for view access again (it was dropped).
            const gen = ++genRef.current
            dispatch({ type: 'accounts-changed', accounts })
            void loadAccount(p, accounts[0], gen).then(ok => { if (ok) void ensureView(p, gen, true) }).catch(() => undefined)
            return
          }
          if (prev.status === 'disconnected') {
            // Connected from elsewhere (another tab of this site): pick it up quietly, no popup.
            const gen = ++genRef.current
            void loadAccount(p, accounts[0], gen).then(ok => { if (ok) void ensureView(p, gen, false) }).catch(() => undefined)
          }
        },
        networkChanged: network => {
          dispatch({ type: 'network', network })
          // Sapient disconnects other sites on a switch (an empty accountsChanged comes first). If this
          // one is somehow still connected, its grant did not survive: check it, without a popup.
          if (stateRef.current.status === 'connected') void ensureView(p, genRef.current, false)
        },
      })

      await refreshNetwork(p)
      try {
        const session = await checkSession(p)
        if (cancelled) return
        if (session.s === 'locked') { dispatch({ type: 'locked' }); return }
        if (session.s !== 'unlocked') return
        const gen = ++genRef.current
        if (await loadAccount(p, session.account, gen)) await ensureView(p, gen, false)
      } catch { /* stay disconnected; the session check tries again */ }
    })

    return () => { cancelled = true; unsubscribe?.() }
  }, [refreshNetwork, loadAccount, ensureView])

  const connect = useCallback(async () => {
    const p = providerRef.current
    if (!p) return
    const gen = ++genRef.current
    dispatch({ type: 'connect-start' })
    try {
      const accounts = await requestAccounts(p)
      if (gen !== genRef.current) return
      if (accounts.length === 0) throw new SapientError('wallet', 'Sapient returned no account.', null)
      // Re-read: the connect popup can sit open while the person changes network.
      await refreshNetwork(p)
      if (!(await loadAccount(p, accounts[0], gen))) return
      await ensureView(p, gen, true)
    } catch (e) {
      if (gen === genRef.current) dispatch({ type: 'connect-failed', error: connectError(e) })
    }
  }, [refreshNetwork, loadAccount, ensureView])

  const disconnect = useCallback(async () => {
    genRef.current++
    dispatch({ type: 'disconnected' })
    const p = providerRef.current
    if (p) await disconnectSapient(p).catch(() => undefined)
  }, [])

  /** Ask Sapient where the session stands and follow it — locked, unlocked, switched or gone. */
  const refresh = useCallback(async () => {
    const p = providerRef.current
    const before = stateRef.current
    if (!p || before.status === 'detecting' || before.status === 'missing' || before.status === 'connecting') return
    let r
    try { r = await checkSession(p) } catch { return }
    const cur = stateRef.current
    if (cur.status === 'connecting') return   // a connect is under way; it owns the state
    if (r.s === 'locked') {
      if (cur.status !== 'locked') dispatch({ type: 'locked' })
      return
    }
    if (r.s === 'disconnected') {
      if (cur.status === 'connected' || cur.status === 'locked') { genRef.current++; dispatch({ type: 'disconnected' }) }
      return
    }
    // Unlocked (or connected from elsewhere). Same account coming back from a lock: just unlock, and
    // re-check the grant quietly. A different or not-yet-loaded account: read it, quietly too.
    if (cur.status === 'locked' && cur.componentAddress === r.account) {
      dispatch({ type: 'unlocked' })
      void ensureView(p, genRef.current, false)
      return
    }
    if (cur.componentAddress !== r.account || cur.status !== 'connected') {
      const gen = ++genRef.current
      try {
        if (await loadAccount(p, r.account, gen)) await ensureView(p, gen, false)
      } catch { /* try again on the next check */ }
    }
  }, [loadAccount, ensureView])

  const reportLocked = useCallback(() => {
    if (stateRef.current.status === 'connected') dispatch({ type: 'locked' })
  }, [])

  // The session check: on an interval, and whenever the page comes back into view.
  useEffect(() => {
    if (!provider) return
    const iv = setInterval(() => { void refresh() }, SESSION_CHECK_MS)
    const onFocus = () => { void refresh() }
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(iv)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [provider, refresh])

  const grantViewAccess = useCallback(async () => {
    const p = providerRef.current
    if (!p || stateRef.current.status !== 'connected') return
    await ensureView(p, genRef.current, true)
  }, [ensureView])

  return (
    <Ctx.Provider value={{ ...state, provider, connect, disconnect, grantViewAccess, refresh, reportLocked }}>
      {children}
    </Ctx.Provider>
  )
}
