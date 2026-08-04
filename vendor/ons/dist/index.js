//   ONS client — public entry point.
//
//   Reads are available out of the box (keyless, zero-dependency). Writes are reachable only after
//   attaching a signer via `withSigner()`, which lazily loads the write module (and its
//   @tari-project/ootle dependency) — so a consumer that only resolves names never touches signing.
import { OnsReader } from "./reader.js";
export { OnsReader } from "./reader.js";
/** An ONS client: keyless reads (inherited from {@link OnsReader}) plus opt-in writes. */
export class OnsClient extends OnsReader {
    config;
    constructor(config) {
        super(config);
        this.config = config;
    }
    /**
     * Attach a wallet-daemon signer to enable writes. Lazily imports the write module so read-only
     * consumers never load the signing code or its SDK dependency.
     */
    async withSigner(signer) {
        const { OnsWriter } = await import("./writer.js");
        return new OnsWriter(this.config, signer);
    }
    /**
     * Attach a self-custodial browser wallet to enable writes signed client-side (the fee is paid
     * from a confidential UTXO). Lazily imports the browser-write module and its tari.js peer deps.
     */
    async withBrowserSigner(signer) {
        const { OnsBrowserWriter } = await import("./browser-writer.js");
        return new OnsBrowserWriter(this.config, signer);
    }
}
/** Create an ONS client from configuration. */
export function createOnsClient(config) {
    return new OnsClient(config);
}
//# sourceMappingURL=index.js.map