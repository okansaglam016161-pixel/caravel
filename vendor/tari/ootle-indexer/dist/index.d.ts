import { CommitOutcome } from '@tari-project/ootle';
import { GetSubstatesResponse } from '@tari-project/ootle-ts-bindings';
import { GetTemplateDefinitionResponse } from '@tari-project/ootle-ts-bindings';
import { IndexerClient } from '@tari-project/indexer-client';
import { IndexerGetSubstateResponse } from '@tari-project/ootle-ts-bindings';
import { IndexerGetTransactionResultResponse } from '@tari-project/ootle-ts-bindings';
import { IndexerSubmitTransactionResponse } from '@tari-project/ootle-ts-bindings';
import { ListRecentTransactionsRequest } from '@tari-project/ootle-ts-bindings';
import { ListRecentTransactionsResponse } from '@tari-project/ootle-ts-bindings';
import { Network } from '@tari-project/ootle';
import { Provider } from '@tari-project/ootle';
import { SubstateId } from '@tari-project/ootle-ts-bindings';
import { SubstateRequirement } from '@tari-project/ootle-ts-bindings';
import { TemplateMetadata } from '@tari-project/ootle-ts-bindings';
import { TransactionEntry } from '@tari-project/ootle-ts-bindings';
import { TransactionEnvelope } from '@tari-project/ootle-ts-bindings';
import { transports } from '@tari-project/indexer-client';

export { IndexerClient }

export declare class IndexerProvider implements Provider {
    private readonly client;
    private readonly _network;
    private readonly _url;
    private _watcher;
    readonly defaultTransactionTimeoutMs: number;
    private constructor();
    /**
     * Creates an IndexerProvider and verifies connectivity by fetching the indexer identity.
     */
    static connect(options: IndexerProviderOptions): Promise<IndexerProvider>;
    /** Exposes the underlying IndexerClient for advanced use (e.g. resolveWantInputs). */
    getClient(): IndexerClient;
    /**
     * Returns a `PendingTransaction` that resolves via SSE when the network
     * finalises the transaction, falling back to REST polling on timeout.
     *
     * The `TransactionWatcher` SSE loop is created lazily on the first call
     * and reused for all subsequent calls on this provider instance.
     */
    watchTransactionSSE(txId: string, timeoutMs?: number): PendingTransaction;
    /**
     * Stops the SSE `TransactionWatcher` if one is running.
     * Call this when the provider is no longer needed to release the connection.
     */
    stopWatcher(): void;
    network(): Network;
    getSubstate(substateId: string, version?: number | null): Promise<IndexerGetSubstateResponse>;
    getStealthUtxo(resourceAddress: string, commitment: Uint8Array): Promise<IndexerGetSubstateResponse | null>;
    fetchSubstates(requests: SubstateId[]): Promise<GetSubstatesResponse>;
    getTemplateDefinition(templateAddress: string): Promise<GetTemplateDefinitionResponse>;
    submitTransaction(envelope: TransactionEnvelope): Promise<IndexerSubmitTransactionResponse>;
    getTransactionResult(transactionId: string): Promise<IndexerGetTransactionResultResponse>;
    resolveInputs(inputs: SubstateRequirement[]): Promise<SubstateRequirement[]>;
    listRecentTransactions(params: ListRecentTransactionsRequest): Promise<ListRecentTransactionsResponse>;
}

export declare interface IndexerProviderOptions {
    /** Base URL of the indexer REST API, e.g. "http://localhost:18300" */
    url: string;
    network: Network;
    /** Default timeout for `watchTransaction`, in milliseconds. Defaults to 60000ms. */
    defaultTransactionTimeoutMs?: number;
}

/**
 * A parsed SSE event from the indexer.
 * The `type` field comes from the `event:` line; `data` is the parsed JSON payload.
 */
export declare interface IndexerSseEvent {
    type: string;
    data: unknown;
}

/**
 * Opens a persistent SSE connection to `url` using `fetch` and yields
 * parsed events as an async generator.
 *
 * Works in browsers (Fetch + ReadableStream) and Node.js ≥ 18.
 * Automatically reconnects after errors with a 5 s back-off.
 * Stops when `signal` is aborted.
 *
 * Mirrors the `EventStream` / `into_stream()` pattern from the Rust ootle-rs crate.
 *
 * @throws {IndexerClientError} (caught + logged by the retry loop) if the SSE
 *   endpoint returns a non-success status.
 */
export declare function openEventStream(url: string, signal: AbortSignal): AsyncGenerator<IndexerSseEvent>;

/**
 * Parses a partial SSE buffer into discrete events, returning any unparsed
 * remainder that should be carried forward to the next chunk.
 */
export declare function parseSseChunk(buffer: string): {
    events: IndexerSseEvent[];
    remainder: string;
};

/**
 * A handle for a submitted transaction.
 *
 * Mirrors `PendingTransaction` from the Rust ootle-rs crate.
 *
 * @example
 * ```ts
 * const pending = watcher.watch(txId, client);
 * try {
 *   await pending.watch();              // SSE-driven, throws on non-Commit / timeout
 * } catch (err) {
 *   if (err instanceof TransactionRejectedError) { ... }
 * }
 * const receipt = await pending.getReceipt(); // full receipt if needed
 * ```
 */
export declare class PendingTransaction {
    private readonly txId;
    private readonly watcher;
    private readonly client;
    private readonly timeoutMs;
    private cancellation;
    constructor(txId: string, watcher: TransactionWatcher, client: IndexerClient, timeoutMs: number);
    /** The transaction ID being watched. */
    get id(): string;
    /**
     * Waits for the transaction to finalise via SSE, with REST as the verdict
     * source when SSE is ambiguous. `Commit` resolves directly; `Abort` fetches
     * the receipt once to distinguish `Reject` from `FeeIntentCommit`;
     * `Indeterminate` or SSE silence falls back to REST polling within `timeoutMs`.
     *
     * @throws {TransactionRejectedError} on Reject or FeeIntentCommit (FIC's
     *   `.reason` is prefixed `"FeeIntentCommit: "`).
     * @throws {TransactionTimeoutError} when neither SSE nor REST sees finality in time.
     * @throws {OperationCancelledError} when `cancel()` was called.
     */
    watch(): Promise<CommitOutcome>;
    private throwFromReceipt;
    private restPollUntilFinal;
    /** Sleep `ms`, waking early if `signal` aborts (so cancellation isn't delayed a full interval). */
    private delay;
    /**
     * Cancels an in-flight `watch()`. The watch promise rejects with
     * `OperationCancelledError`. Idempotent; a no-op when no watch is active.
     */
    cancel(): void;
    /**
     * Polls the indexer once for the current transaction result and returns
     * the raw response. Useful for fetching full receipt data after `watch()`.
     */
    getReceipt(): Promise<IndexerGetTransactionResultResponse>;
}

/**
 * Fluent builder for constructing an `IndexerProvider`.
 * Mirrors `ProviderBuilder` from the Rust ootle-rs crate.
 *
 * @example
 * ```ts
 * const provider = await ProviderBuilder.new()
 *   .withNetwork(Network.Esmeralda)
 *   .connect();
 * ```
 */
export declare class ProviderBuilder {
    private _network;
    private _url;
    private _transactionTimeoutMs;
    static new(): ProviderBuilder;
    withNetwork(network: Network): this;
    withUrl(url: string): this;
    /**
     * Sets the maximum time `watchTransaction` will wait for finalization.
     * Mirrors `connect_with_transaction_timeout` from ootle-rs.
     */
    withTransactionTimeoutMs(ms: number): this;
    /**
     * Connects to the indexer. If no URL was set, falls back to `defaultIndexerUrl`
     * for the configured network.
     */
    connect(): Promise<IndexerProvider>;
}

/**
 * Resolves a list of `WantInput` descriptors by querying the indexer, returning
 * fully-versioned `SubstateRequirement` objects ready to attach to a transaction.
 *
 * Mirrors `TransactionInputResolver` from the Rust ootle-rs crate.
 *
 * @throws {WalletError} when a `VaultForResource` query finds no matching vault for
 *   the given resource address (an account-shape problem on the caller's side).
 */
export declare function resolveWantInputs(client: IndexerClient, wants: WantInput[]): Promise<SubstateRequirement[]>;

/**
 * SSE-side decision before `PendingTransaction` maps it to a `TransactionOutcome`.
 * `Indeterminate` covers the LocalNet quirk where a `TransactionFinalized` event
 * arrives without `final_decision` — the REST receipt has the verdict.
 */
declare type SseFinalizedDecision = {
    decision: "Commit";
} | {
    decision: "Reject";
    reason: string;
} | {
    decision: "Indeterminate";
};

export { TemplateMetadata }

export { TransactionEntry }

/**
 * Subscribes to the indexer's SSE `/events` stream and routes
 * `TransactionFinalized` events to waiting callers.
 *
 * The stream is paused (abort + reconnect deferred) when no transactions are
 * being watched, and resumed on the first new `watch()` call.
 * Mirrors `TransactionWatcher` from the Rust ootle-rs crate.
 *
 * Lifecycle: call `start()` once (idempotent), then obtain
 * `PendingTransaction` handles via `watch()`. Call `stop()` to shut down.
 */
export declare class TransactionWatcher {
    private readonly baseUrl;
    private pending;
    private abortController;
    private loopPromise;
    constructor(baseUrl: string);
    /**
     * Starts the background SSE loop (idempotent — safe to call multiple times).
     */
    start(): void;
    /**
     * Stops the background loop and rejects any still-parked waiters with
     * `IndexerClientError("TransactionWatcher stopped")`. In normal use
     * `PendingTransaction` self-unregisters, so a hit here means a leaked handle.
     */
    stop(): void;
    /**
     * Returns a `PendingTransaction` that resolves when the network finalises
     * the given transaction ID, throwing on Reject / FeeIntentCommit / timeout.
     *
     * Automatically starts the watcher loop if it isn't running yet.
     */
    watch(txId: string, client: IndexerClient, timeoutMs?: number): PendingTransaction;
    /** Internal: register a waiter for a transaction ID. */
    register(txId: string): Promise<SseFinalizedDecision>;
    /** Internal: remove a pending waiter. */
    unregister(txId: string): void;
    private run;
}

export { transports }

/**
 * Lazily describes an input the transaction needs, resolved by querying the indexer.
 * Mirrors `WantInput` from the Rust ootle-rs crate.
 *
 * - `VaultForResource` — find the vault component that holds the given resource address.
 * - `SpecificSubstate` — resolve a specific substate by ID (same as `resolveInputs` but
 *   deferred until `resolveWantInputs` is called).
 */
export declare type WantInput = {
    type: "VaultForResource";
    resourceAddress: string;
} | {
    type: "SpecificSubstate";
    substateId: string;
    version?: number | null;
};

export { }
