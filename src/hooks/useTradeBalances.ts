// What the Trade page needs to know about this wallet's funds: tTARI and cUSD, private and public, each
// with an honest state. Reads the wallet context only — starts no scan of its own.
//
// A figure is `ready` only when its read finished; while it runs it is `loading` (no number), and a
// failed read is `unavailable` (no number) — never a zero standing in for "not known". The TARI total
// keeps every rule of the wallet's own hero (hooks/useWalletTotal), not a sum made here.

import { useMemo } from 'react'
import { useWallet } from '../context/WalletContext'
import { useWalletTotal } from './useWalletTotal'

export type Amount =
  | { status: 'ready'; value: bigint }
  | { status: 'loading' }
  | { status: 'unavailable' }

export interface TradeBalances {
  tari: { private: Amount; public: Amount }
  cusd: { private: Amount; public: Amount; total: Amount }
  /** The TARI total, exactly as the wallet's hero states it. */
  tariTotal: ReturnType<typeof useWalletTotal>
}

export function useTradeBalances(): TradeBalances {
  const { scan, revealed, cusd } = useWallet()
  const tariTotal = useWalletTotal()
  return useMemo(() => {
    const cusdBusy = cusd.status === 'idle' || cusd.status === 'scanning'
    const cusdFailed = cusd.status === 'error'
    const priv = cusd.balances?.private
    const pub = cusd.balances?.public
    return {
      tari: {
        private: scan.status === 'error' ? { status: 'unavailable' }
          : scan.balance === null ? { status: 'loading' } : { status: 'ready', value: scan.balance },
        public: revealed.status === 'done' ? { status: 'ready', value: revealed.amount ?? 0n }
          : revealed.status === 'unavailable' ? { status: 'unavailable' } : { status: 'loading' },
      },
      cusd: {
        private: cusdBusy ? { status: 'loading' } : cusdFailed || !priv || priv.incomplete ? { status: 'unavailable' } : { status: 'ready', value: priv.units },
        public: cusdBusy ? { status: 'loading' } : cusdFailed || !pub || pub.kind !== 'ok' ? { status: 'unavailable' } : { status: 'ready', value: pub.units },
        total: cusdBusy ? { status: 'loading' } : cusd.units === null ? { status: 'unavailable' } : { status: 'ready', value: cusd.units },
      },
      tariTotal,
    }
  }, [scan, revealed, cusd, tariTotal])
}
