// One action, one run — however fast its button is pressed.
//
// Every button that confirms and submits a transaction (Send, make public/private, the chat
// payment, the faucet claim, @name register; Burn has its own, burnConfirm) runs an async sequence:
// the confirm-time check, a journal row, the submit and — for a chat payment — the message that
// announces it. React only re-renders after a handler returns, and some of these buttons stay on
// screen through the confirm check's network round trip, so a second press used to start a second
// sequence: a second journal row, a second submit of the same envelope (same transaction — it
// cannot pay twice) and, for a chat payment, a second announcement of the same payment.
//
// The lock is taken SYNCHRONOUSLY, before the first await, and released when the sequence settles.
// A press while it is held does nothing. Releasing on settle is right for every caller: each one's
// sequence ends by moving to another screen, or by re-pricing — and a re-priced quote is a new
// thing the user may legitimately confirm.

export interface ActionLock {
  /** True while a sequence is running. */
  readonly held: boolean
  /** Run `fn` unless a run is already in flight; resolves `undefined` when it was refused. */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>
}

export function createActionLock(): ActionLock {
  let held = false
  return {
    get held() { return held },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (held) return undefined
      held = true
      try {
        return await fn()
      } finally {
        held = false
      }
    },
  }
}

/**
 * Wrap an action so every caller goes through one lock. `run(...)` returns the same promise shape as
 * the action, or `undefined` for a press that arrived while one was running.
 */
export function guarded<A extends unknown[], T>(lock: ActionLock, action: (...args: A) => Promise<T>) {
  return (...args: A) => lock.run(() => action(...args))
}
