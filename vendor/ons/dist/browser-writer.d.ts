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
    /** Register a name; the signing wallet becomes its owner. Estimates the fee, then submits. */
    register(name: string): Promise<WriteResult>;
    /** Set (or overwrite) a record on a name this wallet owns. Estimates the fee, then submits. */
    setRecord(name: string, key: string, value: string): Promise<WriteResult>;
    /**
     * Register a name AND set its `nostr` record in a single atomic transaction (one fee, no
     * read-after-write lag): register runs first, then set_record sees the just-created owner==self.
     * Estimates the fee (dry-run) and submits with a small margin in one call.
     */
    registerWithNostr(name: string, nostrPubkey: string): Promise<WriteResult>;
    /**
     * Estimate — WITHOUT committing — the fee (µtTARI) to register `name` + its `nostr` record. Runs a
     * simulated dry-run on the network; nothing is spent. Pair with {@link submitRegisterWithNostr} to
     * show the user the cost and register only on their confirmation.
     */
    estimateRegisterWithNostr(name: string, nostrPubkey: string): Promise<{
        feeMicroTari: bigint;
    }>;
    /**
     * Register `name` + its `nostr` record, revealing exactly `feeBudget` µtTARI for the fee (from a
     * prior {@link estimateRegisterWithNostr}, plus the caller's chosen margin). Throws an honest error
     * on any non-Accept outcome — including a fee-only commit where the fee was burned but no name set.
     */
    submitRegisterWithNostr(name: string, nostrPubkey: string, feeBudget: bigint): Promise<WriteResult>;
    /** Convenience: dry-run estimate → submit with a small safety margin. Used by the single-call API. */
    private estimateAndSubmit;
    /** Dry-run the call(s) to learn the exact required fee (µtTARI). Nothing is committed. */
    private estimate;
    /**
     * Build the fee (reveal `feeBudget` from one UTXO, change to self) + the ONS method call(s), sign,
     * and submit — or, when `dryRun`, submit a simulated transaction the network won't commit. Returns
     * the classified execution outcome; callers decide whether a non-Accept is fatal.
     */
    private buildSubmit;
}
//# sourceMappingURL=browser-writer.d.ts.map