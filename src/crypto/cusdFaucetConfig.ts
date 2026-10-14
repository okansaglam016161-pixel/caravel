// The cUSD faucet — the fixed facts about it, in one place. caravel-trade's live deployment
// (README, created 2026-10-14 on Ootle 0.46.1), every address read back from both indexers.
//
// The faucet (`CaravelTestDollar`) holds the whole cUSD supply and has no owner: nobody, the
// deployer included, can withdraw from it, change it, or block anyone's claim. It pays ONE claim of
// 10,000 cUSD per public key, signed by that key — the same mint-and-burn receipt pattern as
// Caravel's TARI faucet, on its own receipt resource.
//
// Unlike the TARI faucet there is no admin state to read: no pause flag and no adjustable amount.
// The claim size is a template constant, so it is a constant here too.

import { CUSD_RESOURCE_ADDRESS } from './assets'

/** The published `CaravelTestDollar` template. The component's header must name it. */
export const CUSD_FAUCET_TEMPLATE_ADDRESS = '0338a252870a68f67b157ddee96045282094c5d55691fab82c25d85f9e188c0d'

/** The faucet component every claim calls. */
export const CUSD_FAUCET_COMPONENT_ADDRESS = 'component_d14e2e910e930ce954a5764921bebfaadf0deda354f7a701bc30dd559c15fe0b'

/** The vault holding every unclaimed cUSD (state field 0). Declared writable on every claim. */
export const CUSD_FAUCET_VAULT_ADDRESS = 'vault_d1131536a6c8caa0ebdeefdad87b5442825a3116602de369c332bc90e0603d85'

/** The claim-receipt NFT resource (state field 1). Mint and burn are locked to the faucet. */
export const CUSD_FAUCET_RECEIPTS_RESOURCE_ADDRESS = 'resource_d10371e4de1461659b9dcced72fb46f03642e9d99bf785dc58b817f1a8201446'

/** One claim: 10,000 cUSD in base units (6 decimals). A template constant (`CLAIM * UNIT`). */
export const CUSD_CLAIM_UNITS = 10_000_000_000n

export { CUSD_RESOURCE_ADDRESS }

/**
 * The substate id of `claimerPkHex`'s claim receipt. Minted as `NonFungibleId::from_u256(claimer)`
 * and burnt at once; a burnt NFT is still a substate, so its presence is the chain's record that
 * this key has claimed — exactly as faucetConfig.faucetReceiptId for the TARI faucet.
 */
export function cusdFaucetReceiptId(claimerPkHex: string): string {
  return `nft_${CUSD_FAUCET_RECEIPTS_RESOURCE_ADDRESS.slice('resource_'.length)}_uuid_${claimerPkHex.toLowerCase()}`
}
