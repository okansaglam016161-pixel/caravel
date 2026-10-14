// The wallet's record of the cUSD outputs it created for itself — today, only its faucet claim.
//
// ── WHY cUSD HAS ITS OWN RECORD, AND NOT THE JOURNAL ─────────────────────────
//
// The journal's `selfOutputIds` are read as TARI by everything downstream: ownedFeed fetches each one
// by id and hands the body to the TARI scan, reconcile subtracts them from the TARI set. A stealth
// output decrypts under the view key whatever its resource, so a cUSD output id in the journal would
// be fetched, opened, and COUNTED AS TARI — 10,000 cUSD reported as 10,000 TARI. Keeping cUSD ids
// here, and only TARI ids in the journal, makes that mix-up structurally impossible rather than a
// filter someone has to remember.
//
// ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
//
//   recovery   the listing lags a fresh output by a minute or more (see ownedFeed). The claim's own
//              output id is known before submission, so the cUSD scan asks for it by id until a
//              listing has it — the same "ask for our own receipts" move the TARI scan makes.
//   activity   the claimed amount, keyed by the journal entry of the claim, so the Activity row can
//              say "10,000 cUSD" without the journal growing a second-currency field.
//
// It is NOT the source of truth for the balance: a restore on a new device has no record and the
// scan still finds every cUSD output from the listing. Sealed like every per-identity store.

import { asRecord, loadStore, writeStore, type Parse } from './storeIo'

export interface CusdClaimRecord {
  /** The journal entry of the claim (its TARI side: the fee and the change). */
  journalId: string
  txId: string | null
  /** `utxo_<cusd>_<commitment>` of the private cUSD output the claim pays into. */
  outputId: string
  /** cUSD base units the claim pays (10,000 cUSD = 10,000,000,000). */
  units: bigint
  at: number
}

const key = (walletAddress: string) => `caravel-cusd-claims-${walletAddress}`

const parse: Parse<CusdClaimRecord[]> = (decoded) => {
  if (!Array.isArray(decoded)) return null
  const out: CusdClaimRecord[] = []
  for (const raw of decoded) {
    const r = asRecord(raw)
    if (!r) return null
    if (typeof r.journalId !== 'string' || typeof r.outputId !== 'string' || typeof r.units !== 'string' || typeof r.at !== 'number') return null
    if (!/^\d+$/.test(r.units)) return null
    out.push({
      journalId: r.journalId,
      txId: typeof r.txId === 'string' ? r.txId : null,
      outputId: r.outputId,
      units: BigInt(r.units),
      at: r.at,
    })
  }
  return out
}

export function loadCusdClaims(walletAddress: string): CusdClaimRecord[] {
  if (!walletAddress) return []
  return loadStore(key(walletAddress), parse, () => [])
}

/** Add or replace (by journal id) a claim record. Returns whether it reached storage. */
export function recordCusdClaim(walletAddress: string, rec: CusdClaimRecord): boolean {
  if (!walletAddress) return false
  const next = [...loadCusdClaims(walletAddress).filter(r => r.journalId !== rec.journalId), rec]
  const json = JSON.stringify(next.map(r => ({ ...r, units: r.units.toString() })))
  const ok = writeStore(key(walletAddress), json, parse)
  if (ok) notify()
  return ok
}

// A tiny change signal so the Activity list re-derives when a claim is recorded, the way
// useJournal re-renders on a journal write. A cached snapshot keeps useSyncExternalStore stable
// between writes (a fresh array every call would loop forever).
const listeners = new Set<() => void>()
function notify() { snapshotAddress = undefined; for (const l of listeners) l() }
export function subscribeCusdClaims(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

let snapshotAddress: string | null | undefined
let snapshot: CusdClaimRecord[] = []
export function cusdClaimsSnapshot(walletAddress: string | null): CusdClaimRecord[] {
  if (walletAddress === snapshotAddress) return snapshot
  snapshotAddress = walletAddress
  snapshot = walletAddress ? loadCusdClaims(walletAddress) : []
  return snapshot
}
