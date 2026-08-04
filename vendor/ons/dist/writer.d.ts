import type { DaemonSigner, OnsConfig, WriteResult } from "./types.js";
/** ONS writes via a wallet daemon. Obtain one with `createOnsClient(cfg).withSigner(signer)`. */
export declare class OnsWriter {
    private readonly signer;
    private readonly component;
    private readonly network;
    private rpcId;
    constructor(config: OnsConfig, signer: DaemonSigner);
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