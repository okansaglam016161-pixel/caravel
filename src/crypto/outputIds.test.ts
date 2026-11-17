// An output id names its resource. A statement for another resource must get that resource's prefix,
// or nothing that reads by id ever asks for its outputs.

import { describe, expect, it } from 'vitest'
import { readOutputSubstateIds } from './outputIds'

const outs = (commitments: string[]) => ({ parsed: () => ({ outputs: commitments.map(c => ({ output: { commitment: c } })) }) })

describe('readOutputSubstateIds', () => {
  it('TARI by default — every TARI path unchanged', () => {
    expect(readOutputSubstateIds(outs(['aa']))).toEqual([`utxo_${'01'.repeat(32)}_aa`])
  })
  it('the given resource for another resource\'s statement', () => {
    const other = 'd1'.repeat(32)
    expect(readOutputSubstateIds(outs(['aa', 'bb']), other)).toEqual([`utxo_${other}_aa`, `utxo_${other}_bb`])
  })
  it('all or nothing: an unreadable entry is a hole, not a shorter list', () => {
    expect(readOutputSubstateIds({ parsed: () => ({ outputs: [{ output: { commitment: 'aa' } }, { output: {} }] }) })).toBeNull()
  })
})
