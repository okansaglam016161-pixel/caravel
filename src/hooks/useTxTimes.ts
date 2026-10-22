// The indexer's time of each given transaction (crypto/txTimes), as React state: read once, cached,
// and the component re-renders as each answer arrives. Unknown ones are simply absent from the map.

import { useEffect, useMemo, useState } from 'react'
import { knownTxTime, subscribeTxTimes, txTime } from '../crypto/txTimes'

export function useTxTimes(txIds: readonly string[]): ReadonlyMap<string, number> {
  const [version, setVersion] = useState(0)
  useEffect(() => subscribeTxTimes(() => setVersion(v => v + 1)), [])
  const key = [...new Set(txIds)].sort().join(',')
  useEffect(() => {
    for (const id of key ? key.split(',') : []) if (!knownTxTime(id)) void txTime(id)
  }, [key])
  return useMemo(() => {
    const m = new Map<string, number>()
    for (const id of key ? key.split(',') : []) {
      const t = knownTxTime(id)
      if (t?.at != null) m.set(id, t.at)
    }
    return m
    // `version` re-derives the map when a new time arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
}
