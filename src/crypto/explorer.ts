// Links into the Veil block explorer — for a user who wants to check something themselves.
//
// DISPLAY ONLY. Nothing in the wallet reads from the explorer: every figure the app shows comes
// from the indexers (crypto/indexerConfig). These are where a person goes to look for themselves.

export const EXPLORER_URL = 'https://explorer.tari.mw'

/** A transaction's page. */
export function explorerTxUrl(txId: string): string {
  return `${EXPLORER_URL}/tx/${encodeURIComponent(txId)}`
}

/** A substate's page — a component, a vault, a template. */
export function explorerSubstateUrl(substateId: string): string {
  return `${EXPLORER_URL}/substate/${encodeURIComponent(substateId)}`
}
