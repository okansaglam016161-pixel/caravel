var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { IndexerClientError as e, Network as t, OperationCancelledError as n, TransactionRejectedError as r, TransactionTimeoutError as i, WalletError as a, classifyOutcome as o, defaultIndexerUrl as s, stealthUtxoSubstateId as c } from "@tari-project/ootle";
var l = Object.defineProperty, u = (e5, t3) => {
  let n2 = {};
  for (var r2 in e5) l(n2, r2, {
    get: e5[r2],
    enumerable: true
  });
  return t3 || l(n2, Symbol.toStringTag, { value: "Module" }), n2;
}, d = class e2 {
  constructor(e5) {
    __publicField(this, "url");
    this.url = e5;
  }
  static new(t3) {
    if (!t3.startsWith("http://") && !t3.startsWith("https://")) throw Error("URL must start with http:// or https://");
    return t3.endsWith("/") && (t3 = t3.slice(0, -1)), new e2(t3);
  }
  sendGet(e5, t3, n2) {
    return this.sendRequest(e5, {
      method: "GET",
      params: t3
    }, n2);
  }
  sendHead(e5, t3, n2) {
    return this.sendRequest(e5, {
      method: "HEAD",
      params: t3
    }, n2);
  }
  sendPost(e5, t3, n2) {
    return this.sendRequest(e5, {
      method: "POST",
      body: t3
    }, n2);
  }
  sendPut(e5, t3, n2) {
    return this.sendRequest(e5, {
      method: "PUT",
      body: t3
    }, n2);
  }
  sendDelete(e5, t3, n2) {
    return this.sendRequest(e5, {
      method: "DELETE",
      body: t3
    }, n2);
  }
  async sendRequest(e5, t3, n2) {
    let r2 = new AbortController(), i2 = r2.signal, a2 = (n2 == null ? void 0 : n2.timeout_millis) ? setTimeout(() => {
      r2.abort("Timeout");
    }, n2.timeout_millis) : null;
    e5.startsWith("/") && (e5 = e5.slice(1));
    let o2 = null;
    if (typeof t3.params == "object" && t3.params !== null) {
      let e6 = new URLSearchParams();
      for (let [n3, r3] of Object.entries(t3.params)) r3 != null && e6.append(n3, r3.toString());
      o2 = e6;
    }
    typeof t3.body == "object" && t3.body !== null && (t3.headers || (t3.headers = {}), t3.headers["Content-Type"] = "application/json", t3.body = JSON.stringify(t3.body));
    let s2 = `${this.url}/${e5}`;
    o2 && o2.toString().length > 0 && (s2 += `?${o2.toString()}`);
    let c2 = await fetch(s2, {
      signal: i2,
      ...t3
    });
    if (a2 && clearTimeout(a2), !c2.ok) {
      let e6 = await c2.text();
      throw Error(`HTTP ${c2.status}: ${c2.statusText}${e6 ? ` - ${e6}` : ""}`);
    }
    let l2 = await c2.json();
    if (l2.error) throw Error(`${l2.error.code}: ${l2.error.message}`);
    return l2;
  }
}, f = /* @__PURE__ */ u({ FetchTransport: () => d }), p = class e3 {
  constructor(e5) {
    __publicField(this, "transport");
    __publicField(this, "p");
    this.transport = e5;
  }
  static new(t3) {
    return new e3(t3);
  }
  static usingFetchTransport(t3) {
    return e3.new(d.new(t3));
  }
  getTransport() {
    return this.transport;
  }
  identityGet() {
    return this.transport.sendGet("identity", {});
  }
  waitUntilReady() {
    return this.transport.sendGet("wait-until-ready", {});
  }
  epochManagerStats() {
    return this.transport.sendGet("epoch-manager/stats", {});
  }
  networkInfo() {
    return this.transport.sendGet("network", {});
  }
  networkStats() {
    return this.transport.sendGet("network/stats", {});
  }
  getConnections() {
    return this.transport.sendGet("network/connections", {});
  }
  getNonFungibles(e5) {
    return this.transport.sendGet("non-fungibles", e5);
  }
  substatesGet(e5, t3) {
    return this.transport.sendGet(`substates/${encodeURIComponent(e5)}`, t3);
  }
  fetchSubstates(e5) {
    return this.transport.sendPost("substates/fetch", e5);
  }
  submitTransaction(e5) {
    return this.transport.sendPost("transactions", e5);
  }
  getTransactionResult(e5) {
    return this.transport.sendGet(`transactions/${encodeURIComponent(e5)}/result`, {});
  }
  listRecentTransactions(e5) {
    return this.transport.sendGet("transactions/recent", e5);
  }
  queryTransactionEvents(e5) {
    return this.transport.sendGet("transactions/events", e5);
  }
  listTransactionReceipts(e5) {
    return this.transport.sendGet("transaction-receipts", e5);
  }
  getTransactionReceipt(e5) {
    return this.transport.sendGet(`transaction-receipts/${e5}`, {});
  }
  templatesGet(e5) {
    return this.transport.sendGet(`templates/${encodeURIComponent(e5)}`, {});
  }
  templatesList(e5 = 0) {
    return this.transport.sendGet("templates", { limit: e5 });
  }
  templatesListAuthored(e5) {
    return this.transport.sendPost("templates", e5);
  }
  resourcesGet(e5) {
    return this.transport.sendGet(`resources/${encodeURIComponent(e5)}`, {});
  }
};
function m(e5) {
  let t3 = [], n2 = e5.split(/\n\n|\r\n\r\n/), r2 = n2.pop() ?? "";
  for (let e6 of n2) {
    if (!e6.trim()) continue;
    let n3 = "message", r3 = [];
    for (let t4 of e6.split(/\n|\r\n/)) t4.startsWith("event:") ? n3 = t4.slice(6).trim() : t4.startsWith("data:") && r3.push(t4.slice(5).trim());
    if (r3.length === 0) continue;
    let i2 = r3.join("\n"), a2 = i2;
    try {
      a2 = JSON.parse(i2);
    } catch {
    }
    t3.push({
      type: n3,
      data: a2
    });
  }
  return {
    events: t3,
    remainder: r2
  };
}
async function* h(t3, n2) {
  for (; !n2.aborted; ) {
    let r2 = new AbortController(), i2 = () => r2.abort();
    n2.addEventListener("abort", i2, { once: true });
    try {
      let i3 = await fetch(t3, {
        signal: r2.signal,
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache"
        }
      });
      if (!i3.ok || !i3.body) {
        let n3 = Number.isFinite(i3.status) ? i3.status : void 0;
        throw new e(`SSE connection failed: HTTP ${i3.status}`, {
          status: n3,
          url: t3
        });
      }
      let a2 = i3.body.getReader(), o2 = new TextDecoder(), s2 = "";
      try {
        for (; !n2.aborted; ) {
          let { done: e5, value: t4 } = await a2.read();
          if (e5) break;
          s2 += o2.decode(t4, { stream: true });
          let { events: n3, remainder: r3 } = m(s2);
          s2 = r3;
          for (let e6 of n3) yield e6;
        }
      } finally {
        a2.cancel();
      }
    } catch (e5) {
      if (n2.aborted || e5.name === "AbortError") return;
      console.warn("[ootle-indexer] SSE stream error, retrying in 5 s:", e5.message), await new Promise((e6) => {
        let t4 = setTimeout(e6, 5e3);
        n2.addEventListener("abort", () => {
          clearTimeout(t4), e6();
        }, { once: true });
      });
    } finally {
      n2.removeEventListener("abort", i2);
    }
  }
}
var g = 500, _ = 3e3, v = class {
  constructor(e5) {
    __publicField(this, "baseUrl");
    __publicField(this, "pending", /* @__PURE__ */ new Map());
    __publicField(this, "abortController", null);
    __publicField(this, "loopPromise", null);
    this.baseUrl = e5.endsWith("/") ? e5.slice(0, -1) : e5;
  }
  start() {
    this.abortController && !this.abortController.signal.aborted || (this.abortController = new AbortController(), this.loopPromise = this.run(this.abortController.signal));
  }
  stop() {
    var _a;
    (_a = this.abortController) == null ? void 0 : _a.abort();
    let t3 = new e("TransactionWatcher stopped", { url: this.baseUrl });
    for (let e5 of this.pending.values()) e5.reject(t3);
    this.pending.clear();
  }
  watch(e5, t3, n2 = 32e3) {
    return this.start(), new y(e5, this, t3, n2);
  }
  register(e5) {
    return new Promise((t3, n2) => {
      this.pending.set(e5, {
        resolve: t3,
        reject: n2
      });
    });
  }
  unregister(e5) {
    this.pending.delete(e5);
  }
  async run(e5) {
    let t3 = `${this.baseUrl}/events`;
    for await (let n2 of h(t3, e5)) {
      if (n2.type !== "TransactionFinalized") continue;
      let e6 = n2.data, t4 = this.pending.get(e6.transaction_id);
      if (!t4) continue;
      this.pending.delete(e6.transaction_id);
      let r2 = e6.final_decision;
      if (r2 === "Commit") t4.resolve({ decision: "Commit" });
      else if (typeof r2 == "object" && r2 && "Abort" in r2) {
        let n3 = e6.abort_details ?? JSON.stringify(r2.Abort);
        t4.resolve({
          decision: "Reject",
          reason: n3
        });
      } else t4.resolve({ decision: "Indeterminate" });
    }
  }
}, y = class {
  constructor(e5, t3, n2, r2) {
    __publicField(this, "txId");
    __publicField(this, "watcher");
    __publicField(this, "client");
    __publicField(this, "timeoutMs");
    __publicField(this, "cancellation", null);
    this.txId = e5, this.watcher = t3, this.client = n2, this.timeoutMs = r2;
  }
  get id() {
    return this.txId;
  }
  async watch() {
    let e5 = this.watcher.register(this.txId), t3 = Date.now() + this.timeoutMs, n2 = null, r2 = new Promise((e6) => {
      n2 = setTimeout(() => e6("sse-timeout"), this.timeoutMs);
    }), i2 = () => {
    }, a2 = new Promise((e6, t4) => {
      i2 = t4;
    }), o2 = new AbortController();
    this.cancellation = {
      promise: a2,
      reject: i2,
      abort: o2
    };
    try {
      let i3 = await Promise.race([
        e5,
        r2,
        this.cancellation.promise
      ]);
      if (n2 !== null && clearTimeout(n2), i3 === "sse-timeout") return await Promise.race([this.restPollUntilFinal(Date.now() + _, o2.signal, _), a2]);
      if (i3.decision === "Indeterminate") return await Promise.race([this.restPollUntilFinal(t3, o2.signal, 0), a2]);
      if (i3.decision === "Commit") return { outcome: "Commit" };
      let s2 = await this.client.getTransactionResult(this.txId);
      return this.throwFromReceipt(s2, i3.reason);
    } finally {
      this.watcher.unregister(this.txId), n2 !== null && clearTimeout(n2), this.cancellation = null;
    }
  }
  throwFromReceipt(e5, t3) {
    let n2 = o(e5.result);
    if ((n2 == null ? void 0 : n2.outcome) === "FeeIntentCommit") throw new r(`Transaction ${this.txId} only committed fees (execution aborted): ${n2.reason ?? t3}`, {
      txId: this.txId,
      reason: `FeeIntentCommit: ${n2.reason ?? t3}`
    });
    let i2 = (n2 == null ? void 0 : n2.reason) ?? t3;
    throw new r(`Transaction ${this.txId} was rejected: ${i2}`, {
      txId: this.txId,
      reason: i2
    });
  }
  async restPollUntilFinal(e5, t3, r2) {
    let a2;
    do {
      if (t3.aborted) throw new n(`Wait for transaction ${this.txId} was cancelled`);
      let r3 = null;
      try {
        r3 = await this.client.getTransactionResult(this.txId), a2 = null;
      } catch (e6) {
        a2 = e6;
      }
      if (r3) {
        let e6 = o(r3.result);
        if (e6) return e6.outcome === "Commit" ? { outcome: "Commit" } : this.throwFromReceipt(r3, e6.reason ?? "");
      }
      if (Date.now() >= e5) break;
      await this.delay(g, t3);
    } while (Date.now() < e5 && !t3.aborted);
    if (t3.aborted) throw new n(`Wait for transaction ${this.txId} was cancelled`);
    let s2 = this.timeoutMs + r2, c2 = r2 > 0 ? ` (incl. ${r2}ms grace)` : "";
    throw new i(`Transaction ${this.txId} did not finalise within ${s2}ms${c2}`, {
      txId: this.txId,
      ...a2 == null ? {} : { cause: a2 }
    });
  }
  delay(e5, t3) {
    return new Promise((n2) => {
      if (t3.aborted) {
        n2();
        return;
      }
      let r2 = () => {
        clearTimeout(i2), n2();
      }, i2 = setTimeout(() => {
        t3.removeEventListener("abort", r2), n2();
      }, e5);
      t3.addEventListener("abort", r2, { once: true });
    });
  }
  cancel() {
    var _a, _b;
    this.watcher.unregister(this.txId), (_a = this.cancellation) == null ? void 0 : _a.abort.abort(), (_b = this.cancellation) == null ? void 0 : _b.reject(new n(`Wait for transaction ${this.txId} was cancelled`));
  }
  async getReceipt() {
    return this.client.getTransactionResult(this.txId);
  }
};
function b(e5) {
  let t3 = e5 instanceof Error ? e5.message : String(e5);
  return /not found/i.test(t3) || t3.includes("404");
}
var x = class t2 {
  constructor(e5, t3, n2, r2) {
    __publicField(this, "client");
    __publicField(this, "_network");
    __publicField(this, "_url");
    __publicField(this, "_watcher", null);
    __publicField(this, "defaultTransactionTimeoutMs");
    this.client = e5, this._network = t3, this._url = n2, this.defaultTransactionTimeoutMs = r2;
  }
  static async connect(e5) {
    let n2 = p.usingFetchTransport(e5.url);
    return await n2.identityGet(), new t2(n2, e5.network, e5.url, e5.defaultTransactionTimeoutMs ?? 6e4);
  }
  getClient() {
    return this.client;
  }
  watchTransactionSSE(e5, t3) {
    return this._watcher || (this._watcher = new v(this._url), this._watcher.start()), this._watcher.watch(e5, this.client, t3 ?? this.defaultTransactionTimeoutMs);
  }
  stopWatcher() {
    var _a;
    (_a = this._watcher) == null ? void 0 : _a.stop(), this._watcher = null;
  }
  network() {
    return this._network;
  }
  async getSubstate(e5, t3 = null) {
    return this.client.substatesGet(e5, {
      version: t3,
      local_search_only: false
    });
  }
  async getStealthUtxo(e5, t3) {
    let n2 = c(e5, t3);
    try {
      return await this.getSubstate(n2);
    } catch (e6) {
      if (b(e6)) return null;
      throw e6;
    }
  }
  async fetchSubstates(e5) {
    return this.client.fetchSubstates({
      requests: e5,
      cached_only: false
    });
  }
  async getTemplateDefinition(e5) {
    return this.client.templatesGet(e5);
  }
  async submitTransaction(e5) {
    return this.client.getTransport().sendPost("transactions", { transaction: e5 });
  }
  async getTransactionResult(e5) {
    return this.client.getTransactionResult(e5);
  }
  async resolveInputs(t3) {
    return await Promise.all(t3.map(async (t4) => {
      if (t4.version !== null) return t4;
      try {
        let e5 = await this.client.substatesGet(t4.substate_id, {
          version: null,
          local_search_only: false
        });
        return {
          substate_id: t4.substate_id,
          version: e5.version
        };
      } catch (n2) {
        let r2 = n2 instanceof Error ? n2.message : String(n2);
        throw b(n2) ? new e(`Failed to find input "${t4.substate_id}": ${r2}. Verify the substate id is correct (typo? wrong network?) or wait for the producing transaction to finalize.`, {
          cause: n2,
          url: this._url
        }) : new e(`Failed to resolve input "${t4.substate_id}": ${r2}. Check the indexer URL points at the same network as the substate.`, {
          cause: n2,
          url: this._url
        });
      }
    }));
  }
  async listRecentTransactions(e5) {
    return await this.client.listRecentTransactions(e5);
  }
}, S = class e4 {
  constructor() {
    __publicField(this, "_network", t.LocalNet);
    __publicField(this, "_url", null);
    __publicField(this, "_transactionTimeoutMs", 6e4);
  }
  static new() {
    return new e4();
  }
  withNetwork(e5) {
    return this._network = e5, this;
  }
  withUrl(e5) {
    return this._url = e5, this;
  }
  withTransactionTimeoutMs(e5) {
    return this._transactionTimeoutMs = e5, this;
  }
  async connect() {
    let e5 = {
      url: this._url ?? s(this._network),
      network: this._network,
      defaultTransactionTimeoutMs: this._transactionTimeoutMs
    };
    return x.connect(e5);
  }
};
async function C(e5, t3) {
  return Promise.all(t3.map(async (t4) => {
    if (t4.type === "SpecificSubstate") {
      if (t4.version != null) return {
        substate_id: t4.substateId,
        version: t4.version
      };
      let n3 = await e5.substatesGet(t4.substateId, {
        version: null,
        local_search_only: false
      });
      return {
        substate_id: t4.substateId,
        version: n3.version
      };
    }
    let n2 = {
      filter_by_template: t4.resourceAddress,
      filter_by_type: "Vault",
      limit: 1
    }, r2 = (await e5.getTransport().sendGet("substates", n2)).substates.find((e6) => e6.template_address === t4.resourceAddress || e6.substate_id === t4.resourceAddress);
    if (!r2) throw new a(`Could not find a vault for resource address: ${t4.resourceAddress}`);
    return {
      substate_id: r2.substate_id,
      version: r2.version
    };
  }));
}
export {
  p as IndexerClient,
  x as IndexerProvider,
  y as PendingTransaction,
  S as ProviderBuilder,
  v as TransactionWatcher,
  h as openEventStream,
  m as parseSseChunk,
  C as resolveWantInputs,
  f as transports
};
