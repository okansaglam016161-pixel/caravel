// The Sapient connection's transitions — what each answer from the wallet means for the screen.

import { describe, expect, it } from 'vitest'
import { SAPIENT_INITIAL, sapientReducer, type SapientAction, type SapientState } from './sapientState'

const run = (actions: SapientAction[], from: SapientState = SAPIENT_INITIAL) => actions.reduce(sapientReducer, from)

const A = 'component_' + 'a'.repeat(64)
const B = 'component_' + 'b'.repeat(64)
const ADDR = 'otl_1' + 'x'.repeat(80)

const connected = () => run([
  { type: 'detected', present: true },
  { type: 'network', network: 'mainnet' },
  { type: 'connect-start' },
  { type: 'connected', componentAddress: A, walletAddress: ADDR, capabilities: { privateScan: true } },
  { type: 'view', viewAccess: 'granted' },
])

describe('detection', () => {
  it('missing when there is no provider, disconnected when there is', () => {
    expect(run([{ type: 'detected', present: false }]).status).toBe('missing')
    expect(run([{ type: 'detected', present: true }]).status).toBe('disconnected')
  })

  it('keeps the network while disconnected — Sapient answers it without a connection', () => {
    expect(run([{ type: 'detected', present: true }, { type: 'network', network: 'esmeralda' }]).network).toBe('esmeralda')
  })
})

describe('connecting', () => {
  it('ends connected, with the address, capabilities and the grant', () => {
    const s = connected()
    expect(s).toMatchObject({ status: 'connected', componentAddress: A, walletAddress: ADDR, viewAccess: 'granted', error: null })
  })

  it('a failed connect is back to disconnected, saying why', () => {
    const s = run([{ type: 'detected', present: true }, { type: 'connect-start' }, { type: 'connect-failed', error: 'Connection declined in Sapient.' }])
    expect(s).toMatchObject({ status: 'disconnected', error: 'Connection declined in Sapient.', walletAddress: null })
  })

  it('the next attempt clears the old error', () => {
    const s = run([{ type: 'detected', present: true }, { type: 'connect-failed', error: 'x' }, { type: 'connect-start' }])
    expect(s.error).toBeNull()
  })
})

describe("Sapient's events", () => {
  it('accountsChanged([]) ends the session and drops view access', () => {
    const s = run([{ type: 'accounts-changed', accounts: [] }], connected())
    expect(s).toMatchObject({ status: 'disconnected', walletAddress: null, componentAddress: null, viewAccess: 'unknown' })
    expect(s.network).toBe('mainnet')   // still known
  })

  it('a different account is a switch: address re-read, grant does NOT carry over', () => {
    const switched = run([{ type: 'accounts-changed', accounts: [B] }], connected())
    expect(switched).toMatchObject({ status: 'connected', componentAddress: B, walletAddress: null, viewAccess: 'unknown' })
    const reloaded = run([{ type: 'connected', componentAddress: B, walletAddress: 'otl_1other', capabilities: null }], switched)
    expect(reloaded).toMatchObject({ walletAddress: 'otl_1other', viewAccess: 'unknown' })
  })

  it('the same account again changes nothing', () => {
    const s = connected()
    expect(run([{ type: 'accounts-changed', accounts: [A] }], s)).toBe(s)
  })

  it('a network change updates the network only — the events that end a session do the rest', () => {
    const s = run([{ type: 'network', network: 'esmeralda' }], connected())
    expect(s).toMatchObject({ status: 'connected', network: 'esmeralda' })
  })
})

describe('locked (Sapient sends no event — SapientContext checks)', () => {
  it('connected ⇄ locked keeps the account, its address and its grant', () => {
    const locked = run([{ type: 'locked' }], connected())
    expect(locked).toMatchObject({ status: 'locked', componentAddress: A, walletAddress: ADDR, viewAccess: 'granted' })
    expect(run([{ type: 'unlocked' }], locked)).toMatchObject({ status: 'connected', componentAddress: A, viewAccess: 'granted' })
  })

  it('a reload while locked goes from disconnected to locked', () => {
    expect(run([{ type: 'detected', present: true }, { type: 'locked' }]).status).toBe('locked')
  })

  it('the grant is read while locked (tari_getViewAccess needs no unlock), so it never shows as "Off" by mistake', () => {
    const s = run([{ type: 'detected', present: true }, { type: 'locked' }, { type: 'view', viewAccess: 'granted' }])
    expect(s).toMatchObject({ status: 'locked', viewAccess: 'granted', walletAddress: null })
  })

  it('locked never overrides missing or a connect in progress; an empty accountsChanged still ends it', () => {
    expect(run([{ type: 'detected', present: false }, { type: 'locked' }]).status).toBe('missing')
    expect(run([{ type: 'detected', present: true }, { type: 'connect-start' }, { type: 'locked' }]).status).toBe('connecting')
    expect(run([{ type: 'locked' }, { type: 'accounts-changed', accounts: [] }], connected()).status).toBe('disconnected')
    expect(run([{ type: 'unlocked' }], connected()).status).toBe('connected')
  })
})

describe('disconnect and view access', () => {
  it('disconnect resets everything but the network', () => {
    expect(run([{ type: 'disconnected' }], connected())).toMatchObject({
      status: 'disconnected', componentAddress: null, walletAddress: null, capabilities: null, viewAccess: 'unknown', network: 'mainnet',
    })
  })

  it('a view-access answer that lands after a disconnect is ignored', () => {
    const s = run([{ type: 'disconnected' }, { type: 'view', viewAccess: 'granted' }], connected())
    expect(s.viewAccess).toBe('unknown')
  })

  it('disconnect does nothing to a missing wallet', () => {
    const missing = run([{ type: 'detected', present: false }])
    expect(run([{ type: 'disconnected' }], missing).status).toBe('missing')
  })
})
