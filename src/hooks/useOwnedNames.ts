// ── The @names this wallet owns, as a state a screen can render ───────────────
//
// A thin translation, and deliberately nothing more. crypto/ons.ts already answers four different
// things and labels them (that was the point of reworking it); this turns those four returns into
// the four states the CNS overlay draws, adds the cancellation the component needs, and exposes the
// retry the unreachable card's "Try again" pulls. It makes no decision about the chain.
//
// SAME FAMILY AS usePaymentResolution / useMediaResolution, on purpose: a discriminated union of
// states, a `{ state, retry }` return, a `cancelled` flag scoped to one effect run, and a `nonce` in
// the dependency array that a manual retry bumps. Those two hooks are where this shape was settled;
// a third hand-rolled copy inside a component is how the two of them would start to disagree.
//
// ── WHY EMPTY AND UNREACHABLE ARE SEPARATE MEMBERS ───────────────────────────
//
// Because they are separate facts, and the app used to render them identically — an unreachable
// registry drawn as "you own nothing", which invites somebody to pay a fee for a name they already
// hold. `empty` is the registry ANSWERING with zero. `unreachable` is not knowing. A union is what
// stops a caller writing `names.length === 0` and quietly reintroducing the bug.
//
// NO IN-FLIGHT DEDUP MAP, unlike usePaymentResolution. That map exists there because dozens of
// payment cards can mount at once asking for the same UTXO. This is one read per overlay-open, so
// the only duplicate is React StrictMode's double-invoke in development — a second GET against a
// public indexer, costing nothing and correcting itself. Machinery for that would be more code than
// the thing it saves.

import { useEffect, useState } from 'react'
import { useWallet } from '../context/WalletContext'
import { ownedOnsNames, type NameRecord, type OnsOwnedErrorKind } from '../crypto/ons'

export type OwnedNamesState =
  /** The read is in flight. Nothing is known yet — and nothing is guessed at. */
  | { kind: 'checking' }
  /** The registry answered, with names. One or several; the caller renders all of them. */
  | { kind: 'names'; names: NameRecord[] }
  /** The registry answered, with nothing. A CONFIRMED zero, not a failure wearing one. */
  | { kind: 'empty' }
  /**
   * We could not find out. `errorKind` distinguishes a registry we couldn't reach from a wallet
   * whose identity we couldn't read — they need different sentences, and telling somebody with a
   * locked wallet that they have a network problem is its own small wrong answer.
   */
  | { kind: 'unreachable'; errorKind: OnsOwnedErrorKind; error: string }

export function useOwnedNames(): { state: OwnedNamesState; retry: () => void } {
  const { wallet } = useWallet()
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<OwnedNamesState>({ kind: 'checking' })

  useEffect(() => {
    // NO WALLET AT ALL — locked while the overlay was open, most likely. We never asked the
    // registry, so this is not an answer about the chain and must not be rendered as one. It is the
    // same shape of not-knowing as a failed read, carrying the identity reason rather than the
    // network one.
    if (!wallet) {
      setState({ kind: 'unreachable', errorKind: 'no-identity', error: 'This wallet is locked.' })
      return
    }

    let cancelled = false
    if (nonce > 0) setState({ kind: 'checking' })  // manual retry resets the visible state

    ownedOnsNames(wallet).then(r => {
      if (cancelled) return
      if (!r.ok) {
        setState({
          kind: 'unreachable',
          // ownedOnsNames labels every failure; the fallback exists only so this stays total.
          errorKind: r.errorKind ?? 'unreachable',
          error: r.error ?? 'Could not read your names.',
        })
        return
      }
      const names = r.names ?? []
      setState(names.length ? { kind: 'names', names } : { kind: 'empty' })
    })

    // Tearing this down sets `cancelled` BEFORE the next run starts, which is what makes retry safe:
    // a slow first read landing after "Try again" writes to nothing instead of flashing its stale
    // result over the new one.
    return () => { cancelled = true }
  }, [wallet, nonce])

  return { state, retry: () => setNonce(n => n + 1) }
}
