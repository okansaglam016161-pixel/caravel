// THE ONE FULL RESCAN: the wallet's own refresh (TARI private + public, and cUSD — the same rescan()
// the Wallet tab's refresh runs). The cUSD faucet claim calls THIS after it lands — one function, not
// copies.
//
// It used to read the Caravel Trade market first, so a filled order's payout showed after one press;
// with Trade gone it is the wallet scan alone, kept as the single entry point so its callers do not
// each grow their own error handling.
//
// NOTHING HERE RUNS ON ITS OWN. A wallet scan happens when somebody asks for one (or a transaction of
// theirs settles).

/** Run the full wallet scan. Never throws. */
export async function runFullRescan(rescan: () => Promise<void>): Promise<void> {
  await rescan().catch(() => undefined)
}
