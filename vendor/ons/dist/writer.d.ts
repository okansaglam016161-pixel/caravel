import type { DaemonSigner, OnsConfig, WriteResult } from "./types.js";
/** What a dry run returns when nothing is submitted. */
export interface DryRunResult {
    dryRun: true;
    /** The engine's fee receipt for the simulation, as the daemon returned it. */
    feeReceipt: Record<string, unknown> | null;
    /** Components the simulation created (excluding the fee account). */
    newComponents: string[];
}
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
    /**
     * One daemon-sealed transaction: fee from the signer account's revealed balance, then whatever
     * `addCalls` adds. Dry-run first (free); a non-Accept stops before spending. With `dryRunOnly`,
     * returns the dry run's outcome and submits nothing.
     */
    private execute;
    /**
     * Deploy the shared registry: call the template's `new()` from a daemon account, which pays the
     * fee from its revealed balance. Same path as every write — dry-run first, then submit, then wait
     * for a final Accept. Returns the new registry component's address.
     *
     * With `dryRunOnly`, nothing is submitted; the address reported is the one the SIMULATION
     * created, and the real one will differ (it is derived from the submitted transaction).
     */
    static instantiate(templateAddress: string, signer: DaemonSigner, opts?: {
        network?: number;
        indexerUrl?: string;
        dryRunOnly?: boolean;
    }): Promise<(WriteResult & {
        component: string;
    }) | DryRunResult>;
    /** Register a name. The signing account becomes its owner. */
    register(name: string): Promise<WriteResult>;
    /** Set (or overwrite) a record on a name the signing account owns. */
    setRecord(name: string, key: string, value: string): Promise<WriteResult>;
}
//# sourceMappingURL=writer.d.ts.map