// Caravel's own testnet faucet — the fixed facts about it, in one place.
//
// The faucet is the `CaravelFaucet` template (github.com/okansaglam016161-pixel/caravel-faucet),
// published and instantiated on Esmeralda. Tari's built-in faucet (`XtrFaucet.take`) is no longer
// used anywhere in Caravel.
//
// Everything here is fixed once deployed: a published template cannot change, and the component's
// vault and receipt resource were allocated by `new()` and are never replaced. What CAN change —
// the claim amount, the pause flag, the vault's balance — is read live by faucetStatus.ts and is
// deliberately not a constant.

/** The published `CaravelFaucet` template. The component's header must name it — see faucetStatus. */
export const FAUCET_TEMPLATE_ADDRESS = '931854cae8c2fe2bad48fdc4aaaa618dd6abadc56012a0d7092d939aa3eff32e'

/** The faucet component every claim calls. */
export const FAUCET_COMPONENT_ADDRESS = 'component_568f84a0cc7ccfe49116ee86d072f02b99e246a4750e680a8cbfcd2b7862f37b'

/** The vault the payout comes out of. Declared as a writable input on every claim. */
export const FAUCET_VAULT_ADDRESS = 'vault_56c3c95ef08e843656e755100345d8fa0bf0a58853b40cd9d2894ab48a112ec6'

/**
 * The claim-receipt NFT resource. A claim mints one NFT whose id is the claimer's public key and
 * burns it in the same call; a second claim by the same key fails with "Duplicate NFT token id".
 */
export const FAUCET_RECEIPTS_RESOURCE_ADDRESS = 'resource_5694c70e0eaa25809e593c2f4ee85862b3fa71ea45d9ad01bf18f8accf35d621'

/**
 * The substate id of `ownerPkHex`'s claim receipt.
 *
 * The template mints `NonFungibleId::from_u256(claimer)`, and a U256 id prints as `uuid_<hex>`. The
 * NFT is burnt as soon as it is minted, but a burnt NFT is still a substate (the engine empties its
 * contents, it does not delete it) — which is exactly why a second mint is refused as a duplicate.
 * So its presence at this id is the chain's record that this key has claimed.
 */
export function faucetReceiptId(ownerPkHex: string): string {
  return `nft_${FAUCET_RECEIPTS_RESOURCE_ADDRESS.slice('resource_'.length)}_uuid_${ownerPkHex.toLowerCase()}`
}
