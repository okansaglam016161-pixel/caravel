// The one full rescan: the wallet scan, and a failing scan never throws out of it.

import { describe, expect, it, vi } from 'vitest'
import { runFullRescan } from './useFullRescan'

describe('runFullRescan', () => {
  it('runs the wallet scan once', async () => {
    const rescan = vi.fn(async () => {})
    await runFullRescan(rescan)
    expect(rescan).toHaveBeenCalledTimes(1)
  })
  it('a failing wallet scan does not throw out of it', async () => {
    await expect(runFullRescan(async () => { throw new Error('down') })).resolves.toBeUndefined()
  })
})
