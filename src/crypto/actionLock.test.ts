// Hammer-click: every action button that confirms and submits runs its sequence exactly once.

import { describe, expect, it, vi } from 'vitest'
import { createActionLock, guarded } from './actionLock'
import walletModalSrc from '../components/wallet/WalletModal.tsx?raw'
import chatAppSrc from '../components/chat/ChatApp.tsx?raw'
import faucetSrc from '../components/wallet/FaucetClaimPanel.tsx?raw'
import cnsSrc from '../components/chat/CnsCommitView.tsx?raw'
import burnSheetSrc from '../components/burn/BurnSheet.tsx?raw'

const tick = () => new Promise(r => setTimeout(r, 0))

/**
 * One action's sequence as the handlers run it — the confirm check, the journal row, the submit,
 * and (for a chat payment) the announcing message — each a counted step with a network-sized gap.
 */
function action() {
  const calls = { confirm: 0, journal: 0, submit: 0, message: 0 }
  const run = async (announce: boolean) => {
    calls.confirm++
    await tick()                       // the confirm-time dry run — the window the presses landed in
    calls.journal++
    calls.submit++
    await tick()
    if (announce) calls.message++
    return 'tx_once'
  }
  return { calls, run }
}

/** Seven presses: five in one tick, two more while the first is mid-confirm. */
async function hammer(press: () => Promise<unknown>) {
  const presses = Array.from({ length: 5 }, press)
  await tick()
  presses.push(press(), press())
  return Promise.all(presses)
}

describe('createActionLock', () => {
  it('runs once under a hammer of presses, and the refused presses resolve undefined', async () => {
    const lock = createActionLock()
    // In flight across both bursts, as a confirm check's network round trip is.
    const fn = vi.fn(async () => { await tick(); await tick(); return 'done' })
    const results = await hammer(() => lock.run(fn))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(results.filter(r => r === 'done')).toHaveLength(1)
    expect(results.filter(r => r === undefined)).toHaveLength(6)
  })

  it('is taken synchronously — before the first await', () => {
    const lock = createActionLock()
    void lock.run(async () => { await tick() })
    expect(lock.held).toBe(true)
  })

  it('releases when the run settles — even by throwing — so a NEW quote can be confirmed', async () => {
    const lock = createActionLock()
    await lock.run(async () => 'first')
    expect(lock.held).toBe(false)
    await expect(lock.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(lock.held).toBe(false)
    expect(await lock.run(async () => 'second')).toBe('second')
  })
})

// ── Every action button ───────────────────────────────────────────────────────────────────────
//
// The handlers live inside React components and these tests run without a DOM, so each button is
// covered twice: its WIRING is read from the source (the entry the button calls must be the guarded
// one), and the guarded entry is hammered with that action's own sequence of steps.

const BUTTONS = [
  { name: 'Send (wallet)', file: walletModalSrc, entry: 'confirmSend', inner: 'handleConfirmSend', lock: 'sendLock', call: 'onConfirm: () => void confirmSend()', announce: false },
  { name: 'Make public / make private', file: walletModalSrc, entry: 'confirmMove', inner: 'handleConfirmMove', lock: 'moveLock', call: 'onConfirm={() => void confirmMove()}', announce: false },
  { name: 'Chat payment', file: chatAppSrc, entry: 'submitPayment', inner: 'submitPaymentNow', lock: 'payLock', call: 'void submitPayment()', announce: true },
  { name: 'Faucet claim', file: faucetSrc, entry: 'claim', inner: 'claimNow', lock: 'claimLock', call: 'void claim()', announce: false },
  { name: '@name register', file: cnsSrc, entry: 'submit', inner: 'submitNow', lock: 'submitLock', call: 'void a.submit(state.prepared)', announce: false },
] as const

describe.each(BUTTONS)('$name', ({ file, entry, inner, lock, call, announce }) => {
  const source: string = file

  it('the button calls the guarded entry, and the entry is the action behind a lock', () => {
    expect(source).toContain(`const ${lock} = useRef(createActionLock())`)
    expect(source).toContain(`const ${entry} = guarded(${lock}.current, ${inner})`)
    expect(source).toContain(call)
    // Nothing calls the unguarded action directly.
    const direct = source.split('\n').filter((l: string) => new RegExp(`\\b${inner}\\(`).test(l) && !/function /.test(l))
    expect(direct).toEqual([])
  })

  it('hammered: exactly one confirm, one journal row, one submit' + (announce ? ', one chat message' : ''), async () => {
    const { calls, run } = action()
    const press = guarded(createActionLock(), () => run(announce))
    await hammer(press)
    expect(calls).toEqual({ confirm: 1, journal: 1, submit: 1, message: announce ? 1 : 0 })
  })
})

describe('Burn', () => {
  it('has its own synchronous lock, hammer-tested in components/burn/burnConfirm.test.ts', () => {
    const sheet: string = burnSheetSrc
    expect(sheet).toContain('createBurnConfirm(')
    expect(sheet).toContain('void gate.current!.confirm(view.prepared)')
  })
})
