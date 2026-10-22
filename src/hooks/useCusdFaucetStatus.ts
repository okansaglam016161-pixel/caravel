// Has this wallet claimed its test cUSD? For the Trade page's "get cUSD" prompt (T4).
//
// Read from the faucet's receipt for this wallet's faucet key (crypto/cusdFaucet.readCusdClaimed),
// believed only when verified. `unknown` is an answer too: the receipt could not be read — so neither
// "claimed" nor "open" is claimed on its behalf.

import { useEffect, useState } from 'react'
import { useWallet } from '../context/WalletContext'
import { readCusdClaimed } from '../crypto/cusdFaucet'

export type CusdFaucetStatus = 'loading' | 'open' | 'claimed' | 'unknown'

export function useCusdFaucetStatus(): { status: CusdFaucetStatus; reload: () => void } {
  const { purposeKeys, address } = useWallet()
  const [status, setStatus] = useState<CusdFaucetStatus>('loading')
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    setStatus('loading')
    if (!purposeKeys || !address) return
    let live = true
    void (async () => {
      try {
        const pk = Array.from(await purposeKeys.faucet.getPublicKey(), b => b.toString(16).padStart(2, '0')).join('')
        const s = await readCusdClaimed(pk)
        if (live) setStatus(s)
      } catch { if (live) setStatus('unknown') }
    })()
    return () => { live = false }
  }, [purposeKeys, address, nonce])
  return { status, reload: () => setNonce(n => n + 1) }
}
