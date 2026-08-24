// Tests for recovering the account component address from a transaction result (M1 C1).
//
// The fixtures are not invented: the nesting, the `[SubstateId, Substate]` pair shape, the
// all-zero account template and the `owner_rule.ByPublicKey` field were all read off a real
// committed Esmeralda transaction (cb23a6c4…) via the public indexer on 2026-08-24. A change in
// that wire shape must fail here rather than silently return `null` in production, which would
// present as "public balance never appears" with nothing in the logs.

import { beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNT_TEMPLATE_ADDRESS, extractAccountAddress } from './accountAddress'
import { clearAccountAddress, loadAccountAddress, saveAccountAddress } from './accountStore'

const OWNER = '642aea5f478ec0a3a284cf9398be2d793e903007006e7341f963b87179fc5734'
const OTHER_OWNER = 'b'.repeat(64)
const ACCOUNT = 'component_09f502c111ea132bb8b85490a1a2b6686344cd76dc22e6e319beba0ec17fa399'
const VAULT = 'vault_090b300712fcbe0883cbab1bad336d3468daff23ef180e617b45f4b20b63d557'

/** A Component up-substate, shaped exactly as the indexer returns one. */
function component(id: string, owner: string, template = ACCOUNT_TEMPLATE_ADDRESS) {
  return [id, {
    substate: {
      Component: {
        header: {
          template_address: template,
          owner_rule: { ByPublicKey: owner },
          access_rules: { method_access: { balance: 'AllowAll', get_balances: 'AllowAll' }, default: 'DenyAll' },
          entity_id: '09',
        },
        body: { state: [{}, {}] },
      },
    },
    version: 0,
  }]
}

const vault = (id: string) => [id, { substate: { Vault: { resource_container: {} } } , version: 0 }]

/** A committed result, with the full `Finalized → execution_result → finalize → Accept` nesting. */
function committed(upSubstates: unknown[]) {
  return {
    result: {
      Finalized: {
        final_decision: 'Commit',
        execution_result: { finalize: { result: { Accept: { up_substates: upSubstates, down_substates: [], fee_withdrawals: [] } } } },
      },
    },
  }
}

describe('extractAccountAddress — the happy path', () => {
  it('finds our account among the other up-substates', () => {
    // The real transaction created one component and three vaults; order is not guaranteed.
    const res = committed([vault(VAULT), component(ACCOUNT, OWNER), vault('vault_' + 'a'.repeat(64))])
    expect(extractAccountAddress(res, OWNER)).toBe(ACCOUNT)
  })

  it('is idempotent in the engine sense — a repeat claim reports the same address', () => {
    // CreateAccount is create-or-reuse, so this is not a first-write-only read.
    const res = committed([component(ACCOUNT, OWNER)])
    expect(extractAccountAddress(res, OWNER)).toBe(ACCOUNT)
    expect(extractAccountAddress(res, OWNER)).toBe(ACCOUNT)
  })
})

describe('extractAccountAddress — the two checks that keep us off the wrong component', () => {
  it('REFUSES a component owned by somebody else', () => {
    // The one that matters. Latching onto a stranger's account would show their balance as ours,
    // and in a later milestone would aim a withdraw at it.
    const res = committed([component(ACCOUNT, OTHER_OWNER)])
    expect(extractAccountAddress(res, OWNER)).toBeNull()
  })

  it('REFUSES a non-account component, even when we own it', () => {
    const res = committed([component(ACCOUNT, OWNER, 'f'.repeat(64))])
    expect(extractAccountAddress(res, OWNER)).toBeNull()
  })

  it('REFUSES an owner rule that is not ByPublicKey', () => {
    // Not a key we can compare against, so it is not something we may claim.
    const weird = [ACCOUNT, { substate: { Component: { header: {
      template_address: ACCOUNT_TEMPLATE_ADDRESS, owner_rule: { ByAccessRule: 'AllowAll' },
    } } }, version: 0 }]
    expect(extractAccountAddress(committed([weird]), OWNER)).toBeNull()
  })

  it('picks OUR account when several accounts appear in one result', () => {
    const mine = 'component_' + '1'.repeat(64)
    const res = committed([component(ACCOUNT, OTHER_OWNER), component(mine, OWNER)])
    expect(extractAccountAddress(res, OWNER)).toBe(mine)
  })

  it('refuses an empty owner key rather than matching a malformed component', () => {
    const res = committed([component(ACCOUNT, '')])
    expect(extractAccountAddress(res, '')).toBeNull()
  })
})

describe('extractAccountAddress — shapes that must yield null, not throw', () => {
  it.each([
    ['a rejected transaction', { result: { Finalized: { final_decision: 'Reject', execution_result: { finalize: { result: { Reject: { reason: 'nope' } } } } } } }],
    ['a result still pending', { result: {} }],
    ['no up_substates key', committed(undefined as unknown as unknown[])],
    ['up_substates not an array', { result: { Finalized: { execution_result: { finalize: { result: { Accept: { up_substates: 'nope' } } } } } } }],
    ['an empty diff', committed([])],
    ['only vaults, no component', committed([vault(VAULT)])],
    ['a malformed entry', committed([['component_x'], null, 42, {}])],
    ['null', null],
    ['a string', 'not json'],
    ['an array at the root', []],
  ])('returns null for %s', (_label, input) => {
    expect(extractAccountAddress(input, OWNER)).toBeNull()
  })

  it('ignores a component whose id lacks the component_ prefix', () => {
    const res = committed([component('vault_' + '2'.repeat(64), OWNER)])
    expect(extractAccountAddress(res, OWNER)).toBeNull()
  })
})

// ── Storage ───────────────────────────────────────────────────────────────────

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

const WALLET_A = 'otl_esm_wallet_a'
const WALLET_B = 'otl_esm_wallet_b'

beforeEach(() => { globalThis.localStorage = memoryStorage() })

describe('accountStore', () => {
  it('round-trips an address', () => {
    saveAccountAddress(WALLET_A, ACCOUNT)
    expect(loadAccountAddress(WALLET_A)).toBe(ACCOUNT)
  })

  it('returns null for a wallet that has never captured one — the common empty case', () => {
    // Every wallet that claimed before this shipped reads exactly like this. It means "not known
    // yet", never "zero".
    expect(loadAccountAddress(WALLET_A)).toBeNull()
  })

  it('keeps identities apart', () => {
    // A lock/unlock into a different wallet must not inherit the previous one's account.
    saveAccountAddress(WALLET_A, ACCOUNT)
    expect(loadAccountAddress(WALLET_B)).toBeNull()
  })

  it('is first-write-wins — a later capture cannot overwrite a known-good address', () => {
    saveAccountAddress(WALLET_A, ACCOUNT)
    saveAccountAddress(WALLET_A, 'component_' + '9'.repeat(64))
    expect(loadAccountAddress(WALLET_A)).toBe(ACCOUNT)
  })

  it('ignores empty inputs rather than blanking a stored address', () => {
    saveAccountAddress(WALLET_A, ACCOUNT)
    saveAccountAddress(WALLET_A, '')
    saveAccountAddress('', 'component_x')
    expect(loadAccountAddress(WALLET_A)).toBe(ACCOUNT)
    expect(loadAccountAddress('')).toBeNull()
  })

  it('clears on request', () => {
    saveAccountAddress(WALLET_A, ACCOUNT)
    clearAccountAddress(WALLET_A)
    expect(loadAccountAddress(WALLET_A)).toBeNull()
  })

  it('survives storage being unavailable', () => {
    // Private mode / disabled storage reads as "not known yet" rather than throwing into the UI.
    const boom = () => { throw new Error('denied') }
    globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 } as unknown as Storage
    expect(() => saveAccountAddress(WALLET_A, ACCOUNT)).not.toThrow()
    expect(loadAccountAddress(WALLET_A)).toBeNull()
  })
})

// ── The DRY-RUN result shape ──────────────────────────────────────────────────
//
// Account recovery reads the address out of a dry run rather than a committed transaction, and the
// two endpoints nest their payload differently — the dry run has no `Finalized` wrapper and no
// `execution_result` level. Both fixtures below are real: the dry-run one is the body
// /transactions/dry-run returned for a CreateAccount-only simulation on 2026-08-24, which reported
// the same component a real claim had already created for that key.

/** A dry-run result, shaped as /transactions/dry-run returns it. */
function dryRun(upSubstates: unknown[]) {
  return {
    transaction_id: 'a'.repeat(64),
    result: { finalize: { result: { Accept: { up_substates: upSubstates, down_substates: [], fee_withdrawals: [] } } } },
  }
}

describe('extractAccountAddress — dry-run nesting', () => {
  it('reads the address from a dry-run result', () => {
    expect(extractAccountAddress(dryRun([component(ACCOUNT, OWNER)]), OWNER)).toBe(ACCOUNT)
  })

  it('applies the same owner guard to a dry run', () => {
    // A simulation is not a weaker source of truth than a commit — the guards must not relax.
    expect(extractAccountAddress(dryRun([component(ACCOUNT, OTHER_OWNER)]), OWNER)).toBeNull()
  })

  it('applies the same template guard to a dry run', () => {
    expect(extractAccountAddress(dryRun([component(ACCOUNT, OWNER, 'f'.repeat(64))]), OWNER)).toBeNull()
  })

  it('returns null for a REJECTED dry run', () => {
    // The shape seen when the simulation fails, e.g. "No vault for resource" when the account was
    // not declared as an input. There is no Accept diff, so there is nothing to read.
    const rejected = { result: { finalize: { result: { Reject: { ExecutionFailure: 'At instruction #3: Panic!' } } } } }
    expect(extractAccountAddress(rejected, OWNER)).toBeNull()
  })

  it('still reads a committed result — the two nestings coexist', () => {
    expect(extractAccountAddress(committed([component(ACCOUNT, OWNER)]), OWNER)).toBe(ACCOUNT)
  })
})
