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
// UNLOCKING FROM HERE. A page cannot open Sapient's toolbar popup, and only ONE request opens a
// window while the wallet is locked: tari_requestAccounts. Its window shows the unlock screen, then a
// Connect approval (tari-wallet background/index.ts + popup renderApprovalFlow). That has a cost:
// approving re-records the connection, which DROPS view access (storage.addConnectedSite keeps no
// grant), so `unlock` asks for view access again right after. Unlocking and then pressing Cancel
// leaves the wallet unlocked with the old connection and its grant intact — so a failed unlock is
// never treated as a disconnect: the session check decides what happened. The toolbar icon unlocks
// with no reconnect at all, which is why the screens mention it too.
//
// ── THREE ROUTES TO A WALLET ─────────────────────────────────────────────────
//
// The Sapient extension (today's path, unchanged), Sapient for Android over WalletConnect, and the
// Tari Universe web wallet when Caravel runs inside it (sapient/provider.findProviders). Inside
// Universe its wallet is used. Otherwise the person picks extension or phone in the chooser; the
// choice is remembered on this device (CHOICE_KEY), so a reload restores the same route quietly.
//
// THE PHONE IS NEVER POLLED. Over WalletConnect only tari_getAccounts / tari_getNetwork are
// answered locally (from the session); every other call is a round trip to the phone. So the phone
// path has no 5-second session check: it follows the wallet's events, re-reads the LOCAL session on
// focus, and every call it does make is time-limited (provider.withPhoneTimeouts). A locked or
// sleeping phone surfaces as a message and a Retry, never a hang. Lock detection there is only what
// a call reports.
//
// ── STALE ANSWERS ────────────────────────────────────────────────────────────
//
// Every reset (disconnect, accounts → [], a switch, a new connect) bumps `genRef`, and async work
// started under an older generation drops its result. A popup can sit open for minutes; its answer
// must not land on a session that has since ended.

import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  SapientError, anyProvider, checkSession, detectProviders, disconnectSapient, getAccounts, getCapabilities, getNetwork, getViewAccess,
  getWalletAddress, requestAccounts, requestViewAccess, subscribeSapient, toSapientError, withPhoneTimeouts,
  type TariProvider, type Transport, type WalletProviders,
} from '../sapient/provider'
import { SAPIENT_INITIAL, sapientReducer, type SapientState } from '../sapient/sapientState'

export interface SapientCtx extends SapientState {
  /** The injected provider, once detected — for the payments step. Null while detecting or missing. */
  provider: TariProvider | null
  /**
   * Connect through `transport` (default: the one in use, or the only one available), then ask for
   * view access. Extension: Sapient's popup. Phone: the QR / "Open Sapient", then approval on the
   * phone. Never throws; failures land in `error`.
   */
  connect: (transport?: Transport) => Promise<void>
  /** The wallet chooser (extension or phone). `openChooser` connects directly when there is no choice. */
  chooserOpen: boolean
  openChooser: () => void
  closeChooser: () => void
  /** Forget this site in Sapient and reset. */
  disconnect: () => Promise<void>
  /** Ask for view access (Sapient's popup). For the Grant button. */
  grantViewAccess: () => Promise<void>
  /** Re-check the session now (locked? unlocked? still connected?) — no popup. */
  refresh: () => Promise<void>
  /** A call just answered "Wallet is locked.": show it at once, and keep checking for the unlock. */
  reportLocked: () => void
  /** Open Sapient's unlock screen (via tari_requestAccounts — see the header note). Never throws. */
  unlock: () => Promise<void>
  /** An unlock window is open. */
  unlocking: boolean
}

const Ctx = createContext<SapientCtx | null>(null)

export function useSapient(): SapientCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSapient must be used inside SapientProvider')
  return ctx
}

/** How often the session is re-checked while a connection exists or might (Sapient sends no lock events). */
const SESSION_CHECK_MS = 5000

/** The route the person last connected with, on this device: 'extension' | 'phone'. Not sensitive. */
const CHOICE_KEY = 'caravel.wallet.transport'
function loadChoice(): Transport | null {
  try { const v = localStorage.getItem(CHOICE_KEY); return v === 'extension' || v === 'phone' ? v : null } catch { return null }
}
function saveChoice(t: Transport | null) {
  try { if (t === 'extension' || t === 'phone') localStorage.setItem(CHOICE_KEY, t); else localStorage.removeItem(CHOICE_KEY) } catch { /* ignore */ }
}

/** The route to start with: Universe when inside it, then the remembered choice, then the extension, then the phone. */
function initialTransport(w: WalletProviders): Transport | null {
  if (w.embedded) return 'embedded'
  const chosen = loadChoice()
  if (chosen && w[chosen]) return chosen
  if (w.extension) return 'extension'
  if (w.phone) return 'phone'
  return null
}

function connectError(e: unknown): string {
  const err = toSapientError(e)
  if (err.kind === 'declined') return 'Connection declined in Sapient.'
  if (err.kind === 'locked') return 'Sapient is locked. Unlock it and try again.'
  return err.message
}

export function SapientProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sapientReducer, SAPIENT_INITIAL)
  const [provider, setProvider] = useState<TariProvider | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [chooserOpen, setChooserOpen] = useState(false)
  const providerRef = useRef<TariProvider | null>(null)
  const providersRef = useRef<WalletProviders>({ extension: null, phone: null, embedded: null })
  const transportRef = useRef<Transport | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const genRef = useRef(0)
  const unlockingRef = useRef(false)
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

  /** Subscribe to the active provider's events (re-done whenever the route changes). */
  const subscribe = useCallback((p: TariProvider) => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = subscribeSapient(p, window, {
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
      disconnect: () => {
        // The phone ended the session (removed this site, or the session expired).
        genRef.current++
        dispatch({ type: 'disconnected' })
      },
    })
  }, [loadAccount, ensureView])

  /** Make `t` the route in use: its provider (time-limited on the phone), its events. */
  const activate = useCallback((t: Transport | null): TariProvider | null => {
    const raw = t ? providersRef.current[t] : null
    const p = raw && t === 'phone' ? withPhoneTimeouts(raw) : raw
    transportRef.current = t
    providerRef.current = p
    setProvider(p)
    dispatch({ type: 'transport', transport: t })
    if (p) subscribe(p)
    else { unsubscribeRef.current?.(); unsubscribeRef.current = null }
    return p
  }, [subscribe])

  /** The quiet restore for a route. Never prompts, never pairs a phone. */
  const restore = useCallback(async (p: TariProvider, t: Transport, isCancelled: () => boolean) => {
    await refreshNetwork(p)
    try {
      if (t === 'phone') {
        // Local answers only: [] when there is no WalletConnect session (no QR, no round trip).
        const accounts = await getAccounts(p)
        if (isCancelled() || accounts.length === 0) return
        const gen = ++genRef.current
        if (await loadAccount(p, accounts[0], gen)) await ensureView(p, gen, false)
        return
      }
      const session = await checkSession(p)
      if (isCancelled()) return
      if (session.s === 'locked') {
        // Locked on load: the grant is still readable (tari_getViewAccess needs no unlock), so
        // read it rather than show "Off" for a site that has it.
        dispatch({ type: 'locked' })
        void ensureView(p, genRef.current, false)
        return
      }
      if (session.s !== 'unlocked') return
      const gen = ++genRef.current
      if (await loadAccount(p, session.account, gen)) await ensureView(p, gen, false)
    } catch (e) {
      if (toSapientError(e).kind === 'locked') dispatch({ type: 'locked' })
      /* otherwise stay disconnected; the next check or a Connect tries again */
    }
  }, [refreshNetwork, loadAccount, ensureView])

  // Detection and the quiet restore — once.
  useEffect(() => {
    let cancelled = false
    void detectProviders(window).then(async found => {
      if (cancelled) return
      providersRef.current = found
      dispatch({ type: 'detected', options: { extension: !!found.extension, phone: !!found.phone, embedded: !!found.embedded } })
      if (!anyProvider(found)) return
      const t = initialTransport(found)
      const p = activate(t)
      if (p && t) await restore(p, t, () => cancelled)
    })
    return () => { cancelled = true; unsubscribeRef.current?.(); unsubscribeRef.current = null }
  }, [activate, restore])

  const connect = useCallback(async (want?: Transport) => {
    setChooserOpen(false)
    const t = want ?? transportRef.current ?? initialTransport(providersRef.current)
    if (!t || !providersRef.current[t]) return
    const p = t === transportRef.current && providerRef.current ? providerRef.current : activate(t)
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
      if (t !== 'embedded') saveChoice(t)
      await ensureView(p, gen, true)
    } catch (e) {
      if (gen === genRef.current) dispatch({ type: 'connect-failed', error: connectError(e) })
    }
  }, [activate, refreshNetwork, loadAccount, ensureView])

  /** The chooser when there is a choice (extension and phone); otherwise straight to the one route. */
  const openChooser = useCallback(() => {
    const w = providersRef.current
    if (w.embedded) { void connect('embedded'); return }
    if (w.phone) { setChooserOpen(true); return }
    if (w.extension) void connect('extension')
  }, [connect])
  const closeChooser = useCallback(() => setChooserOpen(false), [])

  const disconnect = useCallback(async () => {
    genRef.current++
    dispatch({ type: 'disconnected' })
    saveChoice(null)
    const p = providerRef.current
    if (p) await disconnectSapient(p).catch(() => undefined)
  }, [])

  /** Ask Sapient where the session stands and follow it — locked, unlocked, switched or gone. */
  const refresh = useCallback(async () => {
    const p = providerRef.current
    const before = stateRef.current
    if (!p || before.status === 'detecting' || before.status === 'missing' || before.status === 'connecting') return
    if (transportRef.current === 'phone') {
      // The local session first (no round trip). Locked: one time-limited call to see if it unlocked.
      let accounts: string[]
      try { accounts = await getAccounts(p) } catch { return }
      const cur = stateRef.current
      if (accounts.length === 0) {
        if (cur.status === 'connected' || cur.status === 'locked') { genRef.current++; dispatch({ type: 'disconnected' }) }
        return
      }
      if (cur.status === 'locked') {
        try { await getViewAccess(p); dispatch({ type: 'unlocked' }); void ensureView(p, genRef.current, false) } catch { /* still locked or asleep */ }
        return
      }
      if (cur.componentAddress !== accounts[0] || cur.status !== 'connected') {
        const gen = ++genRef.current
        try { if (await loadAccount(p, accounts[0], gen)) await ensureView(p, gen, false) } catch { /* next time */ }
      }
      return
    }
    let r
    try { r = await checkSession(p) } catch { return }
    const cur = stateRef.current
    if (cur.status === 'connecting') return   // a connect is under way; it owns the state
    if (r.s === 'locked') {
      if (cur.status !== 'locked') {
        dispatch({ type: 'locked' })
        void ensureView(p, genRef.current, false)
      }
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

  const unlock = useCallback(async () => {
    const p = providerRef.current
    if (!p || stateRef.current.status !== 'locked' || unlockingRef.current) return
    // The phone has no unlock window to open from here: the person unlocks Sapient on the phone, and
    // this checks again.
    if (transportRef.current === 'phone') { await refresh(); return }
    unlockingRef.current = true
    setUnlocking(true)
    try {
      const accounts = await requestAccounts(p)
      if (accounts.length > 0) {
        const gen = ++genRef.current
        await refreshNetwork(p)
        // The Connect approval just dropped view access in Sapient: ask again (a user action led here).
        if (await loadAccount(p, accounts[0], gen)) await ensureView(p, gen, true)
      }
    } catch {
      // Cancelled, closed, or left locked — or unlocked and THEN cancelled. Ask where things stand.
    } finally {
      unlockingRef.current = false
      setUnlocking(false)
      void refresh()
    }
  }, [refreshNetwork, loadAccount, ensureView, refresh])

  // The session check: on an interval (never for the phone: see the header), and whenever the page
  // comes back into view.
  useEffect(() => {
    if (!provider) return
    const iv = state.transport === 'phone' ? null : setInterval(() => { void refresh() }, SESSION_CHECK_MS)
    const onFocus = () => { void refresh() }
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (iv) clearInterval(iv)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [provider, refresh, state.transport])

  const grantViewAccess = useCallback(async () => {
    const p = providerRef.current
    if (!p || stateRef.current.status !== 'connected') return
    await ensureView(p, genRef.current, true)
  }, [ensureView])

  return (
    <Ctx.Provider value={{ ...state, provider, connect, disconnect, grantViewAccess, refresh, reportLocked, unlock, unlocking, chooserOpen, openChooser, closeChooser }}>
      {children}
    </Ctx.Provider>
  )
}
