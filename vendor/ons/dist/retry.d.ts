/** Shown while a busy indexer is being waited out. */
export declare const RETRYING_MESSAGE = "Network busy, retrying\u2026";
/** Shown when it stayed busy. A busy answer is a refusal, so nothing was sent. */
export declare const NETWORK_BUSY_MESSAGE = "The Tari network is busy right now. Nothing was sent \u2014 try again in a minute.";
/** Thrown when every attempt was answered "busy". */
export declare class IndexerBusyError extends Error {
    constructor();
}
/** Thrown when a busy refusal was followed by evidence the transaction may have landed anyway. */
export declare class SubmitMaybeLandedError extends Error {
    constructor();
}
/** Timing in one mutable place, so tests can make waits instant. */
export declare const retryTiming: {
    baseMs: number;
    capMs: number;
    retryAfterCapMs: number;
    sleep: (ms: number) => Promise<void>;
};
export type AnswerKind = "busy" | "transient" | "definite";
export declare function classifyStatus(status: number): AnswerKind;
/** True for the indexer saying "busy". The SDK transport throws `Error("HTTP 503: …")`. */
export declare function isBusyError(e: unknown): boolean;
/** A Retry-After header (delta-seconds or HTTP date) as ms, capped; null if absent/unreadable. */
export declare function parseRetryAfter(value: string | null | undefined, now?: number): number | null;
/** Wait before attempt `attempt + 1`: Retry-After if given, else exponential backoff with full jitter. */
export declare function backoffMs(attempt: number, retryAfterMs: number | null, random?: () => number): number;
/**
 * fetch with retry, for requests that CHANGE NOTHING (reads, dry runs). Returns the first definite
 * response; throws IndexerBusyError if it stayed busy, or the last transient error.
 */
export declare function fetchWithRetry(url: string, init: RequestInit, opts: {
    attempts: number;
    timeoutMs: number;
    onBusyRetry?: () => void;
}): Promise<Response>;
/** Run an SDK call that CHANGES NOTHING, retrying only a busy answer. Anything else rethrows at once. */
export declare function withBusyRetry<T>(fn: () => Promise<T>, opts: {
    attempts: number;
    onBusyRetry?: () => void;
}): Promise<T>;
/** Total submit attempts, the first included. */
export declare const SUBMIT_ATTEMPTS = 3;
/**
 * Submit with the busy-only, same-envelope, landed-checked retry described above. `submit` must
 * close over ONE sealed envelope; `landed` must answer "not-landed" only on positive evidence.
 */
export declare function submitOnce<R>(submit: () => Promise<R>, opts: {
    landed: () => Promise<"not-landed" | "maybe-landed">;
    onBusyRetry?: () => void;
}): Promise<R>;
//# sourceMappingURL=retry.d.ts.map