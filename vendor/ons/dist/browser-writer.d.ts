import { type Mask } from "@tari-project/ootle";
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
    /**
     * The wallet's spendable stealth outputs. When given, the fee input is selected from these
     * instead of the built-in scan — which reads ONE page (the oldest 1000 rows) of ONE indexer's
     * `/utxos`, and so finds nothing for a wallet whose coins are all newer than that page. A wallet
     * that already keeps an accurate owned set (paginated, multi-indexer, spend-aware) should pass it.
     */
    ownedUtxos?: () => Promise<OwnedFeeUtxo[]>;
    /**
     * Called once a real (non-dry-run) transaction is submitted, with the substate ids of the
     * stealth inputs it spends, before the result is polled. Lets a wallet mark the fee input as
     * spent immediately rather than waiting for its next scan.
     */
    onSubmitted?: (txId: string, spentInputIds: string[]) => void;
    /**
     * Progress text for the caller to show. Today it carries only the busy-indexer notice
     * ("Network busy, retrying…") while an Ootle 0.43 rate limit is being waited out.
     */
    onProgress?: (message: string) => void;
}
/** One spendable stealth output — what `ownedUtxos` returns and the built-in scan produces. */
export interface OwnedFeeUtxo {
    substateId: string;
    commitment: Uint8Array;
    nonce: Uint8Array;
    value: bigint;
    mask: Mask;
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
     * simulated dry-run on the network; nothing is spent. For a confirm screen prefer
     * {@link prepareRegisterWithNostr}, which also builds the transaction the confirm will send.
     */
    estimateRegisterWithNostr(name: string, nostrPubkey: string): Promise<{
        feeMicroTari: bigint;
    }>;
    /**
     * Price AND build a register-with-nostr, without sending it.
     *
     * The two-phase form a confirm screen needs: the fee input is chosen ONCE, the transaction is
     * dry-run to learn its cost, `budgetFor(cost)` sets the fee it will pay (default: this client's
     * margin), and the REAL transaction is built and sealed at that fee. `submit()` sends that very
     * envelope — no rescan, no reselection, no rebuild — so the fee shown is the fee charged: the whole
     * revealed budget, since the overcharge is not refunded on this path.
     */
    prepareRegisterWithNostr(name: string, nostrPubkey: string, budgetFor?: (requiredFee: bigint) => bigint): Promise<PreparedOnsWrite>;
    /**
     * Register `name` + its `nostr` record, revealing exactly `feeBudget` µtTARI for the fee. Kept for
     * callers with a budget already in hand: it prepares at that budget and submits what it prepared.
     * Throws an honest error on any non-Accept outcome — including a fee-only commit.
     */
    submitRegisterWithNostr(name: string, nostrPubkey: string, feeBudget: bigint): Promise<WriteResult>;
    /** Convenience: prepare with this client's margin and submit at once. Used by the single-call API. */
    private estimateAndSubmit;
    /** The prepare step shared by every write: one fee input, one dry run, one real build. */
    private prepare;
    private readonly onBusyRetry;
    /**
     * The fee input: the smallest owned output larger than the dry-run budget. Chosen ONCE per write
     * and used for both the pricing dry run and the real build, so the transaction that is priced is
     * the transaction that is sent.
     */
    private feeInput;
    /** Dry-run the call(s) to learn the exact required fee (µtTARI). Nothing is committed. */
    private estimate;
    /**
     * Build the fee (reveal `feeBudget` from `utxo`, change to self) + the ONS method call(s), sign
     * and seal — a dry run when `dryRun`. Returns the envelope and the provider it was resolved on;
     * nothing is sent here.
     */
    private build;
}
/**
 * A priced, built, sealed ONS write — everything except sending it. See
 * {@link OnsBrowserWriter.prepareRegisterWithNostr}.
 */
export interface PreparedOnsWrite {
    /** The fee the transaction pays, exactly (µtTARI): the whole revealed budget. */
    feeMicroTari: bigint;
    /** What the pricing dry run measured the write to require (µtTARI), before any margin. */
    requiredFee: bigint;
    /** Substate id of the stealth output the fee is paid from — the one input this write spends. */
    feeInputId: string;
    /**
     * Dry-run a twin of the prepared transaction (same fee input, same budget, same calls). Free.
     * `accepted` only when the network would Accept it AND its required fee is within the budget —
     * the dry run itself does not enforce the fee.
     */
    simulate(): Promise<{
        accepted: boolean;
        requiredFee?: bigint;
        reason?: string;
    }>;
    /** Send THE prepared envelope, once. Throws an honest error on any non-Accept outcome. */
    submit(): Promise<WriteResult>;
}
//# sourceMappingURL=browser-writer.d.ts.map