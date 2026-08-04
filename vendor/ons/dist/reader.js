//   ONS client — keyless reads via the public indexer. Zero dependencies (just `fetch`): no wallet,
//   no daemon, no credentials, no fee. Resolution is permissionless and runs in the browser or Node.
//
//   The registry component stores one field, `registry: HashMap<String, NameRecord>`, which the
//   indexer returns as plain JSON at `substate.Component.body.state[0]`:
//       { "okz": [ { "@cbor":"bytes", "hex":"c00a…" }, { "nostr":"npub1…" } ] }
//   i.e. name → [ owner (cbor bytes), records (string→string) ]. No CBOR decoding needed.
const DEFAULT_INDEXER_URL = "https://ootle-indexer-a.tari.com";
/** Keyless ONS reads via the public indexer. */
export class OnsReader {
    component;
    indexerUrl;
    constructor(config) {
        if (!config?.component || !config.component.startsWith("component_")) {
            throw new Error(`OnsConfig.component must be a 'component_…' address (got ${String(config?.component)})`);
        }
        this.component = config.component;
        this.indexerUrl = (config.indexerUrl ?? DEFAULT_INDEXER_URL).replace(/\/+$/, "");
    }
    /** Fetch the registry map from the component substate. Throws on network / missing-component. */
    async fetchRegistry() {
        const url = `${this.indexerUrl}/substates/${encodeURIComponent(this.component)}`;
        let resp;
        try {
            resp = await fetch(url);
        }
        catch (e) {
            throw new Error(`ONS indexer request failed: ${e.message}`);
        }
        if (resp.status === 404) {
            throw new Error(`ONS registry component not found: ${this.component} (wrong address or network?)`);
        }
        if (!resp.ok)
            throw new Error(`ONS indexer HTTP ${resp.status}`);
        const body = (await resp.json());
        const state = body?.substate?.Component?.body?.state;
        if (!Array.isArray(state) || state.length === 0 || typeof state[0] !== "object" || state[0] === null) {
            throw new Error("ONS: unexpected component state shape from indexer");
        }
        return state[0];
    }
    /** Full record for a name (owner + all records), or `null` if the name is unregistered. */
    async resolveName(name) {
        const registry = await this.fetchRegistry();
        const entry = registry[name];
        if (!entry)
            return null;
        return { name, owner: ownerHex(entry[0]), records: { ...(entry[1] ?? {}) } };
    }
    /** One record value for a name, or `null` if the name or key is absent. */
    async getRecord(name, key) {
        const rec = await this.resolveName(name);
        return rec?.records[key] ?? null;
    }
    /** Whether a name is registered. */
    async isRegistered(name) {
        const registry = await this.fetchRegistry();
        return Object.prototype.hasOwnProperty.call(registry, name);
    }
    /** Convenience for the common case: the `"nostr"` record for a name (what Caravel resolves). */
    async resolveToNostr(name) {
        return this.getRecord(name, "nostr");
    }
}
/** Owner is stored as CBOR bytes `{ "@cbor":"bytes", hex:"…" }`; also tolerate a plain hex string. */
function ownerHex(owner) {
    if (typeof owner === "string")
        return owner;
    if (owner && typeof owner === "object" && "hex" in owner) {
        const h = owner.hex;
        if (typeof h === "string")
            return h;
    }
    return "";
}
//# sourceMappingURL=reader.js.map