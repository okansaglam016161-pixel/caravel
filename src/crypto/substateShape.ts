// The two shapes of `GET /substates/<id>`, read as one.
//
// ── WHAT CHANGED IN OOTLE 0.47 ───────────────────────────────────────────────
//
// Up to 0.46 the indexer answered a substate read with its value at the top level:
//
//     { version, substate: { Utxo | Component | Vault | … }, verified, proof? }
//
// 0.47 (tari-ootle #2968) moved the value one level down, so a spent version can be answered too:
//
//     { version, state: { up: { substate: { … } } } | { down: {} }, verified, proof? }
//
// Every reader in this wallet looked for `body.substate`, found `undefined`, and read a live coin as
// gone, a funded vault as empty and the faucet as "not in the expected shape". Nothing threw, so
// the site kept loading and showed 0.
//
// ── WHY BOTH SHAPES, AND WHY THE OLD FIELD IS KEPT ───────────────────────────
//
// SDK 0.9 (what this wallet runs) still parses the OLD shape inside `parseSubstateUtxo`,
// `decryptOwnedUtxo` and `getVaultIdsForAccount`; SDK 0.10+ parses only the NEW one. An upgraded
// body carries BOTH fields, so it is correct for either SDK and the SDK bump cannot quietly break
// this again. An old-shape body (a test fixture, or a node not yet on 0.47) passes through as it is.
//
// ── `down` IS AN ABSENCE ─────────────────────────────────────────────────────
//
// A down answer only comes back for a request that sent `include_proof` and named a version, which
// nothing here does; without one, a spent version is still a 404. It is handled anyway, as the 404
// it stands in for, so a proven-spent coin can never be read as a live one.

import type { Provider } from '@tari-project/ootle'
import { getVaultIdsForAccount } from '@tari-project/ootle'

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

/**
 * A `GET /substates/<id>` body in the shape every reader here expects.
 *
 * - 0.47 up → the same body with `substate` set from `state.up.substate` (both fields kept);
 * - 0.47 down → `null`, the same answer as a 404;
 * - anything else (the 0.46 shape, or not a substate body at all) → unchanged.
 */
export function upgradeSubstateBody(body: unknown): unknown {
  const b = obj(body)
  const state = obj(b?.state)
  if (!b || !state) return body
  const up = obj(state.up)
  if (up && 'substate' in up) return { ...b, substate: up.substate }
  if ('down' in state) return null
  return body
}

/** The substate VALUE (`{ Utxo }`, `{ Component }`, `{ Vault }`, …) of a body in either shape. */
export function substateValueOf(body: unknown): unknown {
  return obj(upgradeSubstateBody(body))?.substate
}

/**
 * The provider with `getSubstate` answering in both shapes, for the SDK 0.9 helpers that read
 * `response.substate` themselves (`getVaultIdsForAccount`). A down answer throws as the indexer's
 * 404 does, so `isSubstateNotFound` reads it as the absence it is.
 */
export function withSubstateShape<P extends Provider>(provider: P): P {
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'getSubstate') {
        return async (...args: Parameters<Provider['getSubstate']>) => {
          const res = await target.getSubstate(...args)
          const upgraded = upgradeSubstateBody(res)
          if (upgraded === null) throw new Error(`substate ${String(args[0])} not found (down)`)
          return upgraded as typeof res
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** `getVaultIdsForAccount` that works against a 0.47 indexer. The default resolver everywhere. */
export function getAccountVaultIds(provider: Provider, account: string): Promise<string[]> {
  return getVaultIdsForAccount(withSubstateShape(provider), account)
}
