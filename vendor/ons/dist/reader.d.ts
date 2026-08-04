import type { NameRecord, OnsConfig } from "./types.js";
/** Keyless ONS reads via the public indexer. */
export declare class OnsReader {
    protected readonly component: string;
    protected readonly indexerUrl: string;
    constructor(config: OnsConfig);
    /** Fetch the registry map from the component substate. Throws on network / missing-component. */
    private fetchRegistry;
    /** Full record for a name (owner + all records), or `null` if the name is unregistered. */
    resolveName(name: string): Promise<NameRecord | null>;
    /** One record value for a name, or `null` if the name or key is absent. */
    getRecord(name: string, key: string): Promise<string | null>;
    /** Whether a name is registered. */
    isRegistered(name: string): Promise<boolean>;
    /** Convenience for the common case: the `"nostr"` record for a name (what Caravel resolves). */
    resolveToNostr(name: string): Promise<string | null>;
}
//# sourceMappingURL=reader.d.ts.map