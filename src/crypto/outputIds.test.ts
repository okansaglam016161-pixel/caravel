// An output id names its resource. A cUSD statement's outputs must get cUSD's prefix, or the cUSD
// scan never asks for them by id (the T3a claim's output was recorded under TARI's).

import { describe, expect, it } from 'vitest'
import { readOutputSubstateIds } from './outputIds'
import { CUSD_ASSET } from './assets'

const outs = (commitments: string[]) => ({ parsed: () => ({ outputs: commitments.map(c => ({ output: { commitment: c } })) }) })

describe('readOutputSubstateIds', () => {
  it('TARI by default — every TARI path unchanged', () => {
    expect(readOutputSubstateIds(outs(['aa']))).toEqual([`utxo_${'01'.repeat(32)}_aa`])
  })
  it('the given resource for a cUSD statement', () => {
    expect(readOutputSubstateIds(outs(['aa', 'bb']), CUSD_ASSET.resourceHex)).toEqual([
      `utxo_${CUSD_ASSET.resourceHex}_aa`, `utxo_${CUSD_ASSET.resourceHex}_bb`,
    ])
  })
  it('all or nothing: an unreadable entry is a hole, not a shorter list', () => {
    expect(readOutputSubstateIds({ parsed: () => ({ outputs: [{ output: { commitment: 'aa' } }, { output: {} }] }) })).toBeNull()
  })
})
