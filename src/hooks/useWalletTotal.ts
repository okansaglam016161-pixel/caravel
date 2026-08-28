//   The combined balance, as a summary caller wants it.
//
//   ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
//   The total is not a sum. computeTotal owns a precedence — unreadable outranks in-flight, a stale
//   pair is refused rather than added, `settling` carries no number at all — and every one of those
//   rules is there because a specific confident-wrong-number shipped once. Any surface that shows a
//   total has to apply all of them.
//
//   Two surfaces did, by hand: the wallet modal's hero and the chat sidebar's balance pill, which
//   held its own transcription of the same six inputs. A second summary surface needed it, and three
//   hand-kept copies is where they start to drift. This is that derivation, once.
//
//   ── ONE DELIBERATE DIFFERENCE FROM THE MODAL'S HERO ──────────────────────────
//
//   WalletModal does NOT use this hook, and should not be changed to. Its hero feeds computeTotal a
//   `publicGeneration` taken from the figure it is actually SHOWING — which, while a refresh is in
//   flight, is the last known public balance held on screen rather than the live read. That held
//   value is a deliberate, local piece of honesty (blanking a known public balance for two short
//   GETs would flash "you have nothing"), and the generation has to travel with it or the freshness
//   guard lies.
//
//   A summary has nothing held on screen, so it reads the live generation. Same rules, one input
//   legitimately different. Collapsing the two would mean giving the modal a worse hero or giving
//   the summaries a generation they never displayed.

import { useMemo } from 'react'
import { useWallet } from '../context/WalletContext'
import { computeTotal, type TotalView } from '../components/wallet/v2/total'

/**
 * The combined balance for a SUMMARY surface — today, the chat sidebar pill.
 *
 * The service rail was the other caller until V3 dropped its balance card (see ServiceNav for why).
 * This stays shared rather than folding back into chat: the point of the hook is that a summary
 * figure anywhere in the app derives from the same precedence as the wallet's own hero, and the
 * next summary surface should not have to rediscover that.
 *
 * Reads the shared wallet state; starts no scan and owns no state of its own, so any number of
 * callers cost nothing beyond a re-render they were already getting from the context.
 */
export function useWalletTotal(): TotalView {
  const { scan, revealed, isSettling, settleLagged } = useWallet()

  return useMemo(() => computeTotal({
    privateBalance:
      scan.status === 'error' ? { status: 'unavailable' }
      : scan.balance === null ? { status: 'loading' }
      : { status: 'ready', microtari: scan.balance },
    privateIncomplete: scan.incomplete,
    publicBalance:
      revealed.status === 'done' ? { status: 'ready', microtari: revealed.amount ?? 0n }
      : revealed.status === 'unavailable' ? { status: 'unavailable' }
      : { status: 'loading' },
    // The freshness pair. A summary is smaller, not laxer — two readings from different refreshes
    // describe different moments and must not be added here either.
    privateGeneration: scan.generation,
    publicGeneration: revealed.generation,
    // A settle is WALLET state: it outlives whichever screen started it, so a summary drawn
    // somewhere else entirely still has to refuse a figure while one is outstanding.
    settling: isSettling,
    settleLagged,
  }), [scan, revealed, isSettling, settleLagged])
}
