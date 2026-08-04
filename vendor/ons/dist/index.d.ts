import { OnsReader } from "./reader.js";
import type { DaemonSigner, OnsConfig } from "./types.js";
import type { OnsWriter } from "./writer.js";
import type { BrowserSigner, OnsBrowserWriter } from "./browser-writer.js";
export type { NameRecord, OnsConfig, DaemonSigner, WriteResult } from "./types.js";
export { OnsReader } from "./reader.js";
export type { OnsWriter } from "./writer.js";
export type { BrowserSigner, OnsBrowserWriter } from "./browser-writer.js";
/** An ONS client: keyless reads (inherited from {@link OnsReader}) plus opt-in writes. */
export declare class OnsClient extends OnsReader {
    private readonly config;
    constructor(config: OnsConfig);
    /**
     * Attach a wallet-daemon signer to enable writes. Lazily imports the write module so read-only
     * consumers never load the signing code or its SDK dependency.
     */
    withSigner(signer: DaemonSigner): Promise<OnsWriter>;
    /**
     * Attach a self-custodial browser wallet to enable writes signed client-side (the fee is paid
     * from a confidential UTXO). Lazily imports the browser-write module and its tari.js peer deps.
     */
    withBrowserSigner(signer: BrowserSigner): Promise<OnsBrowserWriter>;
}
/** Create an ONS client from configuration. */
export declare function createOnsClient(config: OnsConfig): OnsClient;
//# sourceMappingURL=index.d.ts.map