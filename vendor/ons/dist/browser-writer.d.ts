import type { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import type { OnsConfig, WriteResult } from "./types.js";
/** A self-custodial browser signer: the user's own secret-key wallet + its owner address. */
export interface BrowserSigner {
    /** The self-custodial wallet (client-side keys). */
    wallet: SecretKeyWallet;
    /** The wallet's owner address (`otl_esm_…`), the change destination. */
    senderAddress: string;
    /** Indexer base URL. Defaults to the esmeralda public indexer. */
    indexerUrl?: string;
}
/** ONS writes signed by a self-custodial browser wallet. Obtain via `createOnsClient(cfg).withBrowserSigner(signer)`. */
export declare class OnsBrowserWriter {
    private readonly signer;
    private readonly component;
    private readonly indexerUrl;
    constructor(config: OnsConfig, signer: BrowserSigner);
    /** Register a name; the signing wallet becomes its owner. */
    register(name: string): Promise<WriteResult>;
    /** Set (or overwrite) a record on a name this wallet owns. */
    setRecord(name: string, key: string, value: string): Promise<WriteResult>;
    /**
     * Register a name AND set its `nostr` record in a single atomic transaction (one fee, no
     * read-after-write lag): register runs first, then set_record sees the just-created owner==self.
     */
    registerWithNostr(name: string, nostrPubkey: string): Promise<WriteResult>;
    /** Build the fee (reveal MAX_FEE from one UTXO, change to self) + the ONS method call(s), sign, submit. */
    private run;
}
//# sourceMappingURL=browser-writer.d.ts.map