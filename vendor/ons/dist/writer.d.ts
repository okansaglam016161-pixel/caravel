import type { DaemonSigner, OnsConfig, WriteResult } from "./types.js";
/** ONS writes via a wallet daemon. Obtain one with `createOnsClient(cfg).withSigner(signer)`. */
export declare class OnsWriter {
    private readonly signer;
    private readonly component;
    private readonly network;
    private readonly indexerUrl;
    private rpcId;
    constructor(config: OnsConfig, signer: DaemonSigner);
    /**
     * `max_epoch` for a transaction built now: the chain tip plus MAX_EPOCH_LEAD.
     *
     * Read straight from the indexer with `fetch` rather than through an SDK provider, to keep this
     * module's dependency surface as it was — it imports two symbols from @tari-project/ootle and
     * otherwise talks HTTP.
     */
    private maxEpoch;
    private jrpc;
    /** Resolve the fee-payer account: its component (fee source) and its seal signer (owner key id). */
    private account;
    private call;
    /** Register a name. The signing account becomes its owner. */
    register(name: string): Promise<WriteResult>;
    /** Set (or overwrite) a record on a name the signing account owns. */
    setRecord(name: string, key: string, value: string): Promise<WriteResult>;
}
//# sourceMappingURL=writer.d.ts.map